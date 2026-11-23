import { open, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FFMPEG, run, inspectBoxes, summarize, ffprobe, getVideoExtradata } from './probe.mjs';
import { createContext, feedParamSet, validateSlice } from './bitstream.mjs';
import { salvageAudio } from './audio.mjs';

// Reference-free last resort: pull the elementary H.264/H.265 stream straight
// out of mdat and re-mux it. Length-prefix size (avcC lengthSizeMinusOne) is
// lost with moov, so we try each of 1/2/4 bytes and let decoding decide which
// is correct. Every candidate NAL is validated against the stream's own slice
// headers so a false length cannot drag the walk into the middle of a frame.

const SC3 = Buffer.from([0, 0, 1]);
const SC4 = Buffer.from([0, 0, 0, 1]);

const h264Type = (nal) => (nal.length ? nal[0] & 0x1f : 0);
const hevcType = (nal) => (nal.length >= 2 ? (nal[0] >> 1) & 0x3f : 0);
function looksH264(nal) {
  if (!nal.length || (nal[0] & 0x80)) return false;
  const t = h264Type(nal);
  return t >= 1 && t <= 12;
}
function looksHevc(nal) {
  if (nal.length < 2 || (nal[0] & 0x80) || (nal[0] & 0x01)) return false;
  const t = hevcType(nal);
  return (t >= 16 && t <= 21) || (t >= 32 && t <= 40);
}
const isVideoNal = (nal, codec) => (codec === 'hevc' ? looksHevc(nal) : looksH264(nal));

function detectCodec(buf) {
  let h264 = 0, hevc = 0;
  for (let i = 1; i < Math.min(buf.length - 2, 800000); i++) {
    const b = buf[i];
    if (!(b & 0x80) && (b & 0x1f) === 7) h264++;
    if (!(b & 0x80) && !(b & 0x01) && ((b >> 1) & 0x3f) === 33) hevc++;
  }
  if (!h264 && !hevc) {
    for (let i = 0; i < buf.length - 2; i += 397) {
      if (looksHevc(buf.subarray(i, i + 2))) hevc++;
      else if (looksH264(buf.subarray(i, i + 2))) h264++;
    }
  }
  return hevc > h264 ? 'hevc' : 'h264';
}

function readBE(buf, pos, ls) {
  if (pos + ls > buf.length) return -1;
  let v = 0;
  for (let k = 0; k < ls; k++) v = (v << 8) | buf[pos + k];
  return v;
}

// Classify a candidate NAL. Parameter sets are remembered for later slices;
// slices must pass the header check; everything else is dropped. Length limits
// encode hard domain facts: SPS/PPS are tens of bytes, an AUD is tiny, a SEI
// payload is at most tens of KB. A "PPS" of 1.6 MB is audio being misread.
function judgeNal(nal, ctx) {
  if (!nal.length) return { action: 'reject' };
  if (ctx.codec === 'hevc') {
    const t = hevcType(nal);
    if (t === 32 || t === 33 || t === 34) {
      if (nal.length > 1024) return { action: 'reject' };
      feedParamSet(ctx, nal);
      return { action: 'accept', param: t === 32 ? 'vps' : t === 33 ? 'sps' : 'pps' };
    }
    if (t === 35) return nal.length <= 16 ? { action: 'accept' } : { action: 'reject' };
    if (t === 38 || t === 39 || t === 40) return nal.length <= 65536 ? { action: 'accept' } : { action: 'reject' };
    if (t <= 9 || (t >= 16 && t <= 21)) {
      const r = validateSlice(nal, ctx);
      if (!r.ok) return { action: 'reject' };
      return { action: 'accept', isNewFrame: r.isNewFrame, idr: r.idr };
    }
    return { action: 'reject' };
  }
  const t = h264Type(nal);
  if (t === 7 || t === 8) {
    if (nal.length > 512) return { action: 'reject' };
    feedParamSet(ctx, nal);
    return { action: 'accept', param: t === 7 ? 'sps' : 'pps' };
  }
  if (t === 9) return nal.length <= 16 ? { action: 'accept' } : { action: 'reject' };
  if (t === 6) return nal.length <= 65536 ? { action: 'accept' } : { action: 'reject' };
  if (t === 1 || t === 5) {
    const r = validateSlice(nal, ctx);
    if (!r.ok) return { action: 'reject' };
    return { action: 'accept', isNewFrame: r.isNewFrame, idr: r.idr };
  }
  return { action: 'reject' };
}

function newStats() {
  return { accepted: 0, rejected: 0, frames: 0, keyframes: 0, resyncs: 0, sps: 0, pps: 0, bytes: 0, capped: false };
}

// Walk mdat assuming an `ls`-byte big-endian length prefix. On any rejected
// candidate we advance ONE byte and look again, instead of trusting the bogus
// length — that single change is what keeps the walk aligned through noise.
async function walkLength(fh, start, end, ls, ctx, maxOutput = 512 * 1024 * 1024) {
  const chunks = [];
  const gaps = [];
  const stats = newStats();
  let buf = Buffer.alloc(0), bufPos = start, pos = start, gapStart = -1;
  const CHUNK = 4 * 1024 * 1024;
  const closeGap = (at) => {
    if (gapStart >= 0 && at - gapStart >= 256) gaps.push([gapStart, at]);
    gapStart = -1;
  };
  // In MP4 interleaving each video sample is often a single NAL and the audio
  // samples sit between them, so "three in a row" never happens. Instead we
  // accept one NAL that passes the slice-header checks against the reference
  // geometry — that is already a strong signal — and require a 16-byte floor
  // so a stray small integer in the audio cannot be mistaken for a length.
  let aligned = false;

  const sizes = [];
  const medianSize = () => {
    if (sizes.length < 5) return 0;
    const s = [...sizes].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  // A frame size that leaps far past the running median is almost always audio
  // bytes misread as one huge length. Keyframes may legitimately be larger, so
  // they get a looser bound rather than a free pass.
  const plausible = (len, v) => {
    const med = medianSize();
    if (med <= 0) return true;
    return len <= med * (v.idr ? 30 : 15);
  };

  const emit = (nal, v) => {
    if (process.env.DEBUG_WALK) console.log('[nal] off', bufPos - start, 'len', nal.length, 'type', nal[0] & 0x1f, 'new', v.isNewFrame, 'idr', v.idr);
    sizes.push(nal.length);
    if (sizes.length > 32) sizes.shift();
    chunks.push(SC4, nal);
    stats.accepted++;
    if (v.param === 'sps') stats.sps++;
    if (v.param === 'pps') stats.pps++;
    if (v.isNewFrame) stats.frames++;
    if (v.idr) stats.keyframes++;
    stats.bytes += nal.length + 4;
  };

  const tryAlign = () => {
    if (buf.length < ls + 1) return null;
    const len = readBE(buf, 0, ls);
    if (len < 16 || len > 8 * 1024 * 1024) return null;
    if (bufPos + ls + len > end) return null;
    if (buf.length < ls + len) return null;
    const nal = buf.subarray(ls, ls + len);
    const v = judgeNal(nal, ctx);
    if (v.action === 'reject') return null;
    if (!plausible(len, v)) return null;
    return { picked: [{ nal: Buffer.from(nal), v, size: ls + len }], end: ls + len };
  };

  const consume = () => {
    while (buf.length >= ls + 1) {
      if (!aligned) {
        const a = tryAlign();
        if (!a) {
          if (gapStart < 0) gapStart = bufPos;
          buf = buf.subarray(1); bufPos += 1; stats.rejected++;
          continue;
        }
        closeGap(bufPos);
        for (const it of a.picked) emit(it.nal, it.v);
        buf = buf.subarray(a.end); bufPos += a.end;
        aligned = true;
        if (stats.bytes > maxOutput) { stats.capped = true; return; }
        continue;
      }
      const nalLen = readBE(buf, 0, ls);
      if (nalLen < 1 || nalLen > 8 * 1024 * 1024 || bufPos + ls + nalLen > end) {
        if (gapStart < 0) gapStart = bufPos;
        aligned = false;
        buf = buf.subarray(1); bufPos += 1; stats.rejected++; stats.resyncs++;
        continue;
      }
      if (buf.length < ls + nalLen) return;
      const nal = buf.subarray(ls, ls + nalLen);
      const v = judgeNal(nal, ctx);
      if (v.action === 'reject' || !plausible(nalLen, v)) {
        if (gapStart < 0) gapStart = bufPos;
        aligned = false;
        buf = buf.subarray(1); bufPos += 1; stats.rejected++; stats.resyncs++;
        continue;
      }
      closeGap(bufPos);
      emit(Buffer.from(nal), v);
      buf = buf.subarray(ls + nalLen); bufPos += ls + nalLen;
      if (stats.bytes > maxOutput) { stats.capped = true; return; }
    }
  };

  while (pos < end) {
    const len = Math.min(CHUNK, end - pos);
    const chunk = Buffer.alloc(len);
    await fh.read(chunk, 0, len, pos); pos += len;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    consume();
    if (stats.capped) break;
  }
  if (!stats.capped) consume();
  closeGap(end);
  if (process.env.DEBUG_WALK) console.log('[walk-end] consumed', bufPos - start, 'bufLen', buf.length, 'total', end - start, 'stats', JSON.stringify(stats));
  return { chunks, gaps, stats };
}

// Annex-B: split on start codes, validate each NAL the same way.
async function walkAnnexB(fh, start, end, ctx, maxOutput = 512 * 1024 * 1024) {
  const chunks = [];
  const stats = newStats();
  let buf = Buffer.alloc(0), pos = start;
  const CHUNK = 4 * 1024 * 1024;
  const accept = (nal) => {
    if (!isVideoNal(nal, ctx.codec)) return;
    const v = judgeNal(nal, ctx);
    if (v.action === 'reject') { stats.rejected += nal.length; return; }
    chunks.push(SC4, Buffer.from(nal));
    stats.accepted++;
    if (v.param === 'sps') stats.sps++;
    if (v.param === 'pps') stats.pps++;
    if (v.isNewFrame) stats.frames++;
    if (v.idr) stats.keyframes++;
    stats.bytes += nal.length;
  };
  while (pos < end) {
    const len = Math.min(CHUNK, end - pos);
    const chunk = Buffer.alloc(len);
    await fh.read(chunk, 0, len, pos); pos += len;
    const data = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let from = 0, idx;
    while ((idx = data.indexOf(SC4, from)) >= 0 || (idx = data.indexOf(SC3, from)) >= 0) {
      if (idx > from) accept(data.subarray(from, idx));
      const scLen = idx + 4 <= data.length && data.subarray(idx, idx + 4).equals(SC4) ? 4 : 3;
      from = idx + scLen;
      if (stats.bytes > maxOutput) { stats.capped = true; break; }
    }
    buf = data.subarray(from);
    if (stats.capped) break;
  }
  return { chunks, gaps: [], stats };
}

function extractParamSets(ed, codec) {
  if (!ed || ed.length < 7) return [];
  const sets = [];
  if (codec === 'h264') {
    let p = 5;
    const numSps = ed[p++] & 0x1f;
    for (let i = 0; i < numSps && p + 2 <= ed.length; i++) {
      const len = ed.readUInt16BE(p); p += 2;
      if (p + len > ed.length) break;
      sets.push(ed.subarray(p, p + len)); p += len;
    }
    if (p < ed.length) {
      const numPps = ed[p++];
      for (let i = 0; i < numPps && p + 2 <= ed.length; i++) {
        const len = ed.readUInt16BE(p); p += 2;
        if (p + len > ed.length) break;
        sets.push(ed.subarray(p, p + len)); p += len;
      }
    }
  } else {
    let p = 22;
    if (p >= ed.length) return null;
    const numArrays = ed[p++];
    for (let a = 0; a < numArrays && p + 3 <= ed.length; a++) {
      const nalType = ed[p++] & 0x3f;
      const numNalus = ed.readUInt16BE(p); p += 2;
      for (let i = 0; i < numNalus && p + 2 <= ed.length; i++) {
        const len = ed.readUInt16BE(p); p += 2;
        if (p + len > ed.length) break;
        if (nalType >= 32 && nalType <= 34) sets.push(ed.subarray(p, p + len));
        p += len;
      }
    }
  }
  return sets;
}

function spsPpsFromExtradata(ed, codec) {
  const sets = extractParamSets(ed, codec);
  if (!sets.length) return null;
  const parts = [];
  for (const s of sets) parts.push(SC4, s);
  return Buffer.concat(parts);
}

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];

function snapFps(raw) {
  let best = null;
  for (const c of STANDARD_FPS) {
    const err = Math.abs(raw - c) / c;
    if (err <= 0.03 && (!best || err < best.err)) best = { fps: c, err };
  }
  if (best) return { fps: best.fps, snapped: true, raw };
  return { fps: Math.round(raw * 1000) / 1000, snapped: false, raw };
}

// Prefer the reference's frame rate, then the audio clock (N frames x 1024 /
// sampleRate vs the number of pictures walked), then the source duration.
function pickFps(videoFrames, audio, refInfo, srcInfo) {
  const refFps = refInfo?.video?.fps || srcInfo?.video?.fps || 0;
  if (refFps > 0) return { fps: refFps, source: '参考文件' };
  if (audio?.ok && audio.frames > 0 && audio.sampleRate > 0 && videoFrames > 0) {
    const raw = videoFrames / (audio.frames * 1024 / audio.sampleRate);
    const s = snapFps(raw);
    return { fps: s.fps, source: `音频时钟反推（原始 ${raw.toFixed(3)}${s.snapped ? '，已归一' : ''}）` };
  }
  if (videoFrames > 0 && srcInfo?.duration > 0) {
    const raw = videoFrames / srcInfo.duration;
    const s = snapFps(raw);
    return { fps: s.fps, source: `源时长反推（原始 ${raw.toFixed(3)}${s.snapped ? '，已归一' : ''}）` };
  }
  return { fps: 25, source: '默认（无法推断）' };
}

async function tryMux(raw, audio, work, codec, fps, log, prog, signal) {
  const demux = codec === 'hevc' ? 'hevc' : 'h264';
  const out = join(work, `raw_${demux}.mp4`);
  const fpsArg = fps > 0 ? String(Math.round(fps * 1000) / 1000) : '25';
  const audioIn = audio?.ok ? ['-f', 'aac', '-i', audio.path] : [];
  const mapAudio = audio?.ok ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : [];
  const attempts = [
    { name: `裸流封装 (${demux} · copy${audio?.ok ? '+音频' : ''})`, vc: 'copy', extra: [] },
    { name: `裸流封装 (${demux} · 重编码${audio?.ok ? '+音频' : ''})`, vc: codec === 'hevc' ? 'libx265' : 'libx264', extra: ['-crf', '22', '-pix_fmt', 'yuv420p', '-preset', 'veryfast'] },
  ];
  for (const a of attempts) {
    const cmd = [
      '-y', '-v', 'warning', '-err_detect', 'ignore_err', '-fflags', '+genpts+igndts',
      '-r', fpsArg, '-f', demux, '-i', raw,
      ...audioIn,
      '-map', '0:v:0', ...mapAudio,
      '-c:v', a.vc, ...a.extra,
      '-r', fpsArg,
      '-movflags', '+faststart', out,
    ];
    log(`${a.name}：ffmpeg ${cmd.join(' ')}`);
    prog?.({ stage: a.name, percent: null });
    const r = await run(FFMPEG, cmd, { timeout: 7_200_000, signal });
    const tail = r.stderr.trim().slice(-600);
    if (tail) log(tail);
    const st = await stat(out).catch(() => null);
    if (st && st.size > 0) {
      const p = await ffprobe(out);
      const info = p.ok ? summarize(p.raw) : null;
      if (info?.video) return { path: out, info };
    }
    log(`${a.name} 未产出可解析视频`);
  }
  return null;
}

export async function tryRawStream(src, work, srcInfo, log, prog, reference = null, signal) {
  const boxes = await inspectBoxes(src);
  if (!boxes.ok) return null;
  const mdats = boxes.boxes.filter((b) => b.type === 'mdat');
  let ranges;
  if (mdats.length) {
    // fMP4/DASH fragments carry many mdat boxes; walk each in order.
    ranges = mdats
      .map((b) => [b.start + b.headerLen, b.overrunsEof ? boxes.fileSize : Math.min(b.start + b.size, boxes.fileSize)])
      .filter(([s, e]) => e - s >= 1024);
  } else {
    // No MP4 container at all: the file may be a raw Annex-B elementary
    // stream (common after a leading-zero strip, or from a direct stream
    // capture). Treat the whole file as one candidate range. walkAnnexB()
    // resynchronises on start codes and validates every NAL, so garbage is
    // skipped rather than corrupting the output.
    log('裸流提取：未找到 mdat，按纯 Annex-B 裸流处理');
    ranges = [[0, boxes.fileSize]];
  }
  if (!ranges.length || ranges.every(([s, e]) => e - s < 1024)) {
    log('裸流提取：可扫描数据过少，跳过');
    return null;
  }
  const [start, end] = ranges[0];

  const fh = await open(src, 'r');
  try {
    const probeBuf = Buffer.alloc(Math.min(256 * 1024, end - start));
    await fh.read(probeBuf, 0, probeBuf.length, start);
    const codec = detectCodec(probeBuf);
    log(`裸流提取：检测到 ${codec} 编码`);

    let refInfo = null, injected = null, refSets = [];
    if (reference) {
      const rp = await ffprobe(reference);
      if (rp.ok) refInfo = summarize(rp.raw);
      const ed = await getVideoExtradata(reference);
      refSets = extractParamSets(ed, codec);
      injected = spsPpsFromExtradata(ed, codec);
      if (injected) log(`已从参考文件取得 ${refSets.length} 个参数集（用于切片校验与流首注入）`);
    }

    // Seed the validator with the reference parameter sets so slice headers are
    // checked against a real geometry from the very first NAL.
    const mkCtx = () => {
      const ctx = createContext(codec);
      for (const s of refSets) feedParamSet(ctx, s);
      return ctx;
    };

    const walkAll = async (ls) => {
      const ctx = mkCtx();
      const acc = { chunks: [], gaps: [], stats: newStats() };
      for (const [s, e] of ranges) {
        const r = await walkLength(fh, s, e, ls, ctx);
        for (const c of r.chunks) acc.chunks.push(c);
        for (const g of r.gaps) acc.gaps.push(g);
        for (const k of Object.keys(acc.stats)) acc.stats[k] += r.stats[k] || 0;
      }
      return acc;
    };
    const walkAnnexBAll = async () => {
      const ctx = mkCtx();
      const acc = { chunks: [], gaps: [], stats: newStats() };
      for (const [s, e] of ranges) {
        const r = await walkAnnexB(fh, s, e, ctx);
        for (const c of r.chunks) acc.chunks.push(c);
        for (const k of Object.keys(acc.stats)) acc.stats[k] += r.stats[k] || 0;
      }
      return acc;
    };
    // Try length-prefix interpretations first (the norm for MP4 mdat), then
    // Annex-B as a fallback. A stray 00 00 01 inside length-prefixed data used
    // to misclassify fMP4 fragments as Annex-B, so the choice is made by trying,
    // not by sniffing. The 1-byte prefix is not a real avcC length size and only
    // produced false positives, so it is gone.
    const lengthPlans = [4, 2].map((ls) => ({ label: `${ls} 字节长度前缀`, fn: () => walkAll(ls) }));
    const annexPlan = { label: 'Annex-B', fn: walkAnnexBAll };
    // Inside mdat, avcC length prefixes are the norm. In a containerless raw
    // stream (whole file as one range) Annex-B start codes are the norm, so
    // try that first — length-prefix walkers produce noisy false NALs there.
    const containerless = mdats.length === 0;
    const plans = containerless ? [annexPlan, ...lengthPlans] : [...lengthPlans, annexPlan];

    for (const plan of plans) {
      const { chunks, gaps, stats } = await plan.fn();
      log(`裸流提取 ${plan.label}：接受 ${stats.accepted} NAL，丢弃 ${stats.rejected} 字节，帧≈${stats.frames}，关键帧≈${stats.keyframes}，脱轨重同步 ${stats.resyncs} 次${stats.capped ? '（已达输出上限，截断处理）' : ''}`);
      if (stats.accepted < 20) { chunks.length = 0; continue; }

      const audioRanges = gaps.length ? gaps : ranges;
      const audio = await salvageAudio(fh, audioRanges, {
        sampleRate: refInfo?.audio?.sampleRate || srcInfo?.audio?.sampleRate || 0,
        channels: refInfo?.audio?.channels || srcInfo?.audio?.channels || 0,
        videoFrames: stats.frames,
        work,
      }).catch((e) => { log(`音频抢救异常：${String(e).slice(0, 160)}`); return { ok: false }; });
      if (audio.ok) log(`音频抢救：${audio.frames} 帧 ${audio.sampleRate}Hz/${audio.channels}ch，约 ${audio.duration.toFixed(2)}s（${audio.mode}）`);
      else log(`音频抢救：${audio.reason || '未找到可恢复音频'}`);

      const fpsPick = pickFps(stats.frames, audio, refInfo, srcInfo);
      log(`帧率：${fpsPick.fps} fps（${fpsPick.source}）`);

      const raw = join(work, `elementary_${plan.label.replace(/\W/g, '')}.bin`);
      const parts = [];
      if (injected) parts.push(injected);
      for (const c of chunks) parts.push(c);
      await writeFile(raw, Buffer.concat(parts));
      chunks.length = 0;

      prog?.({ stage: `裸流重新封装 (${plan.label})`, percent: null });
      const out = await tryMux(raw, audio, work, codec, fpsPick.fps, log, prog, signal);
      if (out) {
        log(`裸流恢复成功：${plan.label}${audio.ok ? '（含音频）' : '（无音频）'}`);
        return out.path;
      }
    }
  } finally {
    await fh.close();
  }
  log('裸流恢复：所有方案均未产出可解码视频');
  return null;
}
