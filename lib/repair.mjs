import { join, dirname, basename, extname } from 'node:path';
import { mkdtemp, rm, rename, stat, copyFile, access, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { FFMPEG, run, ffprobe, summarize, decodeSample, classifyErrors, PROGRESS_ARGS, makeProgressParser, getVideoExtradata, findDataStart } from './probe.mjs';
import { tryRawStream } from './rawstream.mjs';
import { tryHeadFix } from './headfix.mjs';

export const UNTRUNC_CANDIDATES = [
  process.env.UNTRUNC_BIN,
  join(import.meta.dirname, '..', 'vendor', 'untrunc', 'untrunc-81'),
  join(import.meta.dirname, '..', 'vendor', 'untrunc', 'untrunc'),
  '/opt/homebrew/bin/untrunc',
  '/usr/local/bin/untrunc',
].filter(Boolean);

export async function findUntrunc() {
  for (const p of UNTRUNC_CANDIDATES) {
    try { await access(p); return p; } catch { /* keep looking */ }
  }
  return null;
}

// Copy the file starting at `offset` so a junk prefix (HTML page, downloader
// header) no longer blocks ffmpeg's moov lookup. Byte-for-byte after the cut.
async function stripHeader(src, work, offset, log) {
  const dest = join(work, 'stripped.mp4');
  const rs = await open(src, 'r');
  const ws = await open(dest, 'w');
  try {
    const CHUNK = 4 * 1024 * 1024;
    let pos = offset;
    const { size } = await rs.stat();
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const { bytesRead } = await rs.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      await ws.write(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await rs.close(); await ws.close();
  }
  const st = await stat(dest);
  log(`已剥离头部 ${offset} 字节杂质（保留 ${st.size} 字节有效数据）`);
  return dest;
}

// A reference only helps untrunc if it shares the same codec/resolution/fps.
// Given a pool of healthy files, pick the closest one instead of trusting an
// arbitrary user selection. Returns { file, score } or null.
function refScore(target, ref) {
  const tv = target?.video, rv = ref?.video;
  if (!tv || !rv) return 0;
  let score = 0;
  if (tv.codec === rv.codec) score += 40;
  if (tv.width === rv.width && tv.height === rv.height) score += 30;
  else if (tv.width && rv.width && Math.abs(tv.width - rv.width) <= 64) score += 12;
  if (tv.fps && rv.fps && Math.abs(tv.fps - rv.fps) < 0.5) score += 20;
  if (tv.pixFmt === rv.pixFmt) score += 5;
  return score;
}

export async function matchReference(targetInfo, candidates = [], log = () => {}) {
  const usable = [];
  for (const file of candidates) {
    const p = await ffprobe(file);
    if (!p.ok) continue;
    const info = summarize(p.raw);
    if (!info?.video) continue;
    // Fingerprint the codec configuration (avcC/hvcC). Files from the same
    // device or app share an identical fingerprint, which is a far stronger
    // signal than resolution and frame rate alone.
    let fp = '';
    try {
      const ed = await getVideoExtradata(file);
      if (ed?.length) fp = createHash('sha1').update(ed).digest('hex').slice(0, 12);
    } catch { /* fingerprint is best-effort */ }
    usable.push({ file, info, score: refScore(targetInfo, info), fp });
  }
  if (!usable.length) { log('参考文件池中未找到可解析的视频'); return null; }

  // When one fingerprint dominates the pool, its files are almost certainly
  // from the device the broken file came from — boost them.
  const counts = new Map();
  for (const u of usable) if (u.fp) counts.set(u.fp, (counts.get(u.fp) || 0) + 1);
  let topFp = '', topN = 0;
  for (const [fp, n] of counts) if (n > topN) { topN = n; topFp = fp; }
  if (topN >= 2) for (const u of usable) if (u.fp === topFp) u.score += 30;

  usable.sort((a, b) => b.score - a.score);
  const best = usable[0];
  log(`参考文件匹配：${basename(best.file)}（匹配度 ${best.score}${best.fp ? `，指纹 ${best.fp}${best.fp === topFp && topN >= 2 ? ' · 同源' : ''}` : ''}）`);
  return { file: best.file, score: best.score };
}

function pickContainer(src) {
  const e = extname(src).toLowerCase();
  if (['.mkv', '.webm'].includes(e)) return { ext: e, args: [] };
  if (e === '.avi') return { ext: '.avi', args: [] };
  if (e === '.ts' || e === '.m2ts' || e === '.mts') return { ext: e, args: [] };
  return { ext: '.mp4', args: ['-movflags', '+faststart'] };
}

async function canDecodeFrame(file, signal) {
  const r = await run(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { timeout: 120_000, signal });
  return r.code === 0;
}

// A repaired file must prove it is at least as complete as the source before
// we let it replace the original. `level` distinguishes a clean result from a
// playable-but-imperfect one so the caller can offer a degraded recovery.
export async function validate(outPath, srcInfo, { strict = true, allowDegraded = false, srcSize = 0, srcDurationKnown = true, signal } = {}) {
  const reasons = [];
  const st = await stat(outPath).catch(() => null);
  if (!st || st.size === 0) return { ok: false, level: 'rejected', reasons: ['修复产物为空或不存在'] };

  const probe = await ffprobe(outPath);
  if (!probe.ok) return { ok: false, level: 'rejected', reasons: ['修复产物无法被 ffprobe 解析', probe.error.slice(0, 200)] };
  const info = summarize(probe.raw);

  // Absolute floor, independent of the source: untrunc can emit a stream-less
  // shell from garbage input, and an unreadable source gives us nothing to
  // compare against. Never let an empty container overwrite a real file.
  if (!info?.video) return { ok: false, level: 'rejected', reasons: ['修复产物不含任何视频流（空壳容器）'], info };
  if (!(await canDecodeFrame(outPath, signal))) return { ok: false, level: 'rejected', reasons: ['修复产物无法解码出任何一帧'], info };

  const hard = [];
  if (srcInfo?.audio && !info?.audio) hard.push('修复产物丢失了音频流');

  const srcDur = srcInfo?.duration || 0;
  if (info.duration <= 0) {
    hard.push('修复产物时长为 0');
  } else if (srcDur > 1) {
    const ratio = info.duration / srcDur;
    if (ratio < 0.9) hard.push(`时长从 ${srcDur.toFixed(1)}s 缩短到 ${info.duration.toFixed(1)}s（仅剩 ${(ratio * 100).toFixed(0)}%），疑似内容丢失`);
  }
  if (hard.length) return { ok: false, level: 'rejected', reasons: hard, info };

  // CRITICAL: when the source duration is unknown (e.g. moov missing), the
  // duration ratio check above cannot run. Guard against a tiny fragment
  // silently overwriting a large original. Compare the product's byte size to
  // the source: a repair that kept barely any data is never "clean".
  const soft = [];
  if (!srcDurationKnown || srcDur <= 1) {
    if (srcSize > 0 && st.size < srcSize * 0.15) {
      hard.push(`修复产物仅 ${(st.size / 1048576).toFixed(1)}MB，不足原文件 ${(srcSize / 1048576).toFixed(1)}MB 的 15%，疑似只恢复了极小片段`);
      return { ok: false, level: 'rejected', reasons: hard, info };
    }
    // Even if size looks plausible, we cannot PROVE completeness without a
    // source duration — downgrade so the UI tells the user to verify/backup.
    soft.push('源时长未知（如 moov 缺失），无法确认恢复完整，请核对时长并另存备份');
  }
  if (hard.length) return { ok: false, level: 'rejected', reasons: hard, info };

  if (strict) {
    const dec = await decodeSample(outPath, { duration: info.duration });
    if (!dec.ok) {
      const cls = classifyErrors(dec.stderr);
      soft.push('解码仍有残留错误' + (cls.length ? `：${cls.map((c) => c.code).join(', ')}` : ''));
    }
  }
  if (soft.length) {
    return {
      ok: allowDegraded,
      level: 'degraded',
      reasons: soft,
      info,
    };
  }
  return { ok: true, level: 'clean', reasons, info };
}

async function tryUntrunc(src, work, reference, log, prog, signal) {
  const bin = await findUntrunc();
  if (!bin) { log('untrunc 未安装，跳过索引重建'); return null; }
  if (!reference) { log('未提供参考文件，跳过 untrunc（需要同设备录制的完好视频）'); return null; }

  log(`untrunc 重建索引，参考文件：${basename(reference)}`);
  prog({ stage: 'untrunc 索引重建', percent: 0 });
  const dest = join(work, 'untrunc.mp4');
  // -n: never prompt (would hang the server). -dst: keep artifacts out of the user's folder.
  const r = await run(bin, ['-n', '-dst', dest, reference, src], {
    timeout: 3_600_000, signal,
    onStderr: (s) => {
      const m = [...s.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
      if (m.length) prog({ stage: 'untrunc 索引重建', percent: Math.min(99, Number(m[m.length - 1][1])) });
    },
  });
  const tail = (r.stderr.trim() || r.stdout.trim()).slice(-1500);
  if (tail) log(tail);
  if (await stat(dest).catch(() => null)) return dest;
  log(r.code === 0 ? 'untrunc 未产出文件' : `untrunc 退出码 ${r.code}`);
  return null;
}

async function tryRemux(src, work, variant, log, prog, duration, signal) {
  const { ext, args } = pickContainer(src);
  const out = join(work, `remux-${variant}${ext}`);
  const base = ['-y', '-v', 'warning', '-err_detect', 'ignore_err'];
  const extra = {
    plain: [],
    genpts: ['-fflags', '+genpts+igndts', '-avoid_negative_ts', 'make_zero'],
    aggressive: ['-fflags', '+genpts+igndts+discardcorrupt', '-avoid_negative_ts', 'make_zero', '-max_interleave_delta', '0'],
  }[variant];

  const label = `无损重新封装 (${variant})`;
  const cmd = [...base, ...extra, ...PROGRESS_ARGS, '-i', src, '-map', '0', '-c', 'copy', ...args, out];
  log(`${label}：ffmpeg ${cmd.join(' ')}`);
  prog({ stage: label, percent: 0 });
  const r = await run(FFMPEG, cmd, {
    timeout: 3_600_000, signal,
    onStdout: makeProgressParser(duration, (p) => prog({ ...p, stage: label })),
  });
  if (r.stderr.trim()) log(r.stderr.trim().slice(-1200));
  if (r.code !== 0 && !(await stat(out).catch(() => null))) return null;
  return out;
}

async function tryReencode(src, work, srcInfo, log, prog, signal) {
  const { ext, args } = pickContainer(src);
  const out = join(work, `reencode${ext}`);
  const v = srcInfo?.video;
  const hdr = v?.hdr || (v?.bitDepth || 8) > 8;

  // Apple Silicon: VideoToolbox keeps a 4K re-encode realtime-ish instead of hours.
  const codec = hdr ? 'hevc_videotoolbox' : 'h264_videotoolbox';
  const bitrate = srcInfo?.bitRate > 0
    ? Math.max(1_000_000, Math.round(srcInfo.bitRate * 0.9))
    : Math.max(2_000_000, (v?.width || 1920) * (v?.height || 1080) * 4);

  const colorArgs = [];
  if (hdr) {
    colorArgs.push('-profile:v', 'main10', '-tag:v', 'hvc1');
    for (const [flag, key] of [['-color_primaries', 'bt2020'], ['-color_trc', 'smpte2084'], ['-colorspace', 'bt2020nc']]) {
      colorArgs.push(flag, key);
    }
  }

  const attempts = [
    { name: `硬件重编码 ${codec}`, vcodec: codec, extra: colorArgs },
    { name: '软件重编码 libx264（兼容回退）', vcodec: 'libx264', extra: ['-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'] },
  ];

  for (const a of attempts) {
    const cmd = [
      '-y', '-v', 'warning', '-err_detect', 'ignore_err',
      '-fflags', '+genpts+igndts+discardcorrupt',
      ...PROGRESS_ARGS,
      '-i', src, '-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', a.vcodec, '-b:v', String(bitrate),
      ...a.extra,
      '-c:a', 'aac', '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero',
      ...args, out,
    ];
    log(`${a.name}：ffmpeg ${cmd.join(' ')}`);
    prog({ stage: a.name, percent: 0 });
    const r = await run(FFMPEG, cmd, {
      timeout: 7_200_000, signal,
      onStdout: makeProgressParser(srcInfo?.duration || 0, (p) => prog({ ...p, stage: a.name })),
    });
    if (r.stderr.trim()) log(r.stderr.trim().slice(-1200));
    if (r.code === 0 && await stat(out).catch(() => null)) return out;
    log(`${a.name} 失败，尝试下一种`);
  }
  return null;
}

export async function repairFile(src, {
  reference = null,
  referencePool = [],
  allowReencode = true,
  diagnosis = null,
  allowDegraded = true,
  onLog = () => {},
  onProgress = () => {},
  signal,
} = {}) {
  const log = (m) => onLog(String(m));
  const prog = (p) => onProgress(p);
  let srcInfo = diagnosis?.info || summarize((await ffprobe(src)).raw);
  let duration = srcInfo?.duration || 0;
  const srcStat = await stat(src).catch(() => null);
  let srcSize = srcStat?.size || 0;
  let srcDurationKnown = duration > 1;
  const codes = new Set((diagnosis?.problems || []).map((p) => p.code));
  // NOT_MP4 is no longer hopeless: the header-resync may have been wrong, and
  // raw elementary-stream recovery can rescue data without any container.
  const hopeless = ['EMPTY', 'UNREADABLE'].find((c) => codes.has(c));
  if (hopeless) {
    const why = {
      EMPTY: '文件为 0 字节，没有任何可恢复的数据',
      UNREADABLE: '文件不存在或无读取权限',
    }[hopeless];
    log(`不可修复：${why}`);
    return { ok: false, output: null, work: null, tried: [], attempts: [], reasons: [why] };
  }
  const work = await mkdtemp(join(tmpdir(), 'vrepair-'));
  const tried = [];
  const attempts = [];
  const verifying = () => prog({ stage: '校验修复产物', percent: null });
  let degradedBest = null; // keep the best playable-but-imperfect result

  // Try each strategy and record outcome + timing for the run log.
  const attempt = async (name, fn, { strict = false } = {}) => {
    const t0 = Date.now();
    tried.push(name);
    prog({ stage: name, percent: null });
    let p = null;
    try {
      p = await fn();
    } catch (e) {
      log(`${name} 执行异常：${String(e).slice(0, 200)}`);
    }
    if (!p) {
      attempts.push({ strategy: name, ok: false, ms: Date.now() - t0, reasons: ['未产出文件'] });
      return false;
    }
    verifying();
    const v = await validate(p, srcInfo, { strict, allowDegraded, srcSize, srcDurationKnown, signal });
    const rec = {
      strategy: name, ok: v.ok, level: v.level, ms: Date.now() - t0,
      reasons: v.reasons, output: p,
    };
    attempts.push(rec);
    if (v.ok && v.level === 'clean') {
      return { done: true, result: { ok: true, output: p, work, strategy: name, tried: [...tried], attempts, info: v.info, level: 'clean' } };
    }
    if (v.level === 'degraded' || (v.ok && v.level !== 'clean')) {
      const size = (await stat(p).catch(() => null))?.size || 0;
      if (!degradedBest || size > degradedBest.size) degradedBest = { ...rec, name, info: v.info, size };
      log(`${name} 产物可播放但有残留错误：${v.reasons.join('；')}（保留为降级候选）`);
    } else {
      log(`${name} 未通过校验：${v.reasons.join('；')}`);
    }
    return false;
  };

  try {
    // 1. Strip a junk prefix first — otherwise ffmpeg can't even open the file.
    let input = src;
    let stripped = 0; // bytes already removed from the original file head
    const junk = (diagnosis?.problems || []).find((p) => p.code === 'HEADER_JUNK');
    if (junk?.offset > 0) {
      input = await stripHeader(src, work, junk.offset, log);
      stripped = junk.offset;
      srcSize = (await stat(input).catch(() => null))?.size || srcSize;
      const fresh = await ffprobe(input);
      if (fresh.ok) {
        srcInfo = summarize(fresh.raw);
        duration = srcInfo?.duration || 0;
        srcDurationKnown = duration > 1;
      }
    }

    // 1a. Long all-zero head (interrupted download / preallocated blocks).
    // Raw-stream recovery only looks inside `mdat` boxes, so a file whose head
    // is tens of MB of zeros was rejected outright ("未找到 mdat"). Strip the
    // zero run and let every later strategy see the real video bytes. Diagnosis
    // supplies the offset; re-detect here as a safety net for stale diagnoses.
    if (codes.has('LEADING_ZEROS') || codes.has('NOT_MP4') || codes.has('MOOV_MISSING')) {
      let z = (diagnosis?.problems || []).find((p) => p.code === 'LEADING_ZEROS')?.offset || 0;
      if (!z) {
        const found = await findDataStart(input).catch(() => null);
        z = found?.offset || 0;
      }
      // HEADER_JUNK and LEADING_ZEROS can describe the SAME zero prefix.
      // Offsets are relative to the original file, so only strip the part
      // that is still present — otherwise a valid video loses its first
      // frames (or the whole container) after a double strip.
      if (z > stripped) {
        input = await stripHeader(input, work, z - stripped, log);
        stripped = z;
        srcInfo = summarize((await ffprobe(input)).raw);
        srcSize = (await stat(input).catch(() => null))?.size || srcSize;
        duration = srcInfo?.duration || 0;
        srcDurationKnown = duration > 1;
        // The stripped file may now probe as a container (an ftyp was hidden
        // behind the zeros) or as a raw stream — either way, refresh codes so
        // later strategy gates (raw stream) still fire.
        if (!codes.has('NOT_MP4')) codes.add('NOT_MP4');
      }
    }

    // Resolve a reference once: explicit selection, else best match from pool.
    let ref = reference;
    if (!ref && referencePool.length) {
      const m = await matchReference(srcInfo, referencePool, log);
      if (m) ref = m.file;
    }

    // 1b. Head-truncation surgery: ftyp cut away whole while mdat+moov are
    //     intact. Deterministic and lossless, so try it before untrunc.
    if (codes.has('NO_FTYP')) {
      const r = await attempt('头部 ftyp 补全', () => tryHeadFix(input, work, log), { strict: true });
      if (r && r.done) return r.result;
    }

    // 2. untrunc index rebuild, with automatic reference matching as a fallback.
    if (codes.has('MOOV_MISSING') || codes.has('MOOV_INVALID') || codes.has('CORRUPT_DATA')) {
      const r = await attempt('untrunc 索引重建', () => tryUntrunc(input, work, ref, log, prog, signal));
      if (r && r.done) return r.result;
    }

    // 3. Lossless remux variants (cheap, preserves quality).
    for (const variant of ['plain', 'genpts', 'aggressive']) {
      const r = await attempt(`remux:${variant}`, () => tryRemux(input, work, variant, log, prog, duration, signal), { strict: true });
      if (r && r.done) return r.result;
    }

    // 4. Elementary stream recovery (works with no reference; a reference can
    //    optionally supply missing SPS/PPS parameter sets).
    if (codes.has('MOOV_MISSING') || codes.has('MOOV_INVALID') || codes.has('NOT_MP4') || codes.has('CORRUPT_DATA') || codes.has('FMP4_SEGMENT')) {
      const r = await attempt('裸流恢复', () => tryRawStream(input, work, srcInfo, log, prog, ref, signal));
      if (r && r.done) return r.result;
    }

    // 5. Re-encode as the final (lossy) fallback.
    if (allowReencode) {
      const r = await attempt('重编码修复', () => tryReencode(input, work, srcInfo, log, prog, signal));
      if (r && r.done) return r.result;
    } else {
      log('已禁用重编码，无损手段全部失败');
    }

    if (degradedBest && allowDegraded) {
      log(`采用降级修复产物：${degradedBest.name}（可播放但有残留错误，建议另存备份）`);
      return {
        ok: true, output: degradedBest.output, work, strategy: `${degradedBest.name}（降级）`,
        tried: [...tried], attempts, info: degradedBest.info, level: 'degraded',
      };
    }
    return { ok: false, output: null, work, tried, attempts, reasons: ['所有修复策略均未产出通过校验的文件'] };
  } catch (e) {
    return { ok: false, output: null, work, tried, attempts, reasons: [String(e)] };
  }
}

export async function cleanupWork(work) {
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
}

// Path mode: repair beside the original, then swap only after validation passed.
export async function repairInPlace(src, opts) {
  const res = await repairFile(src, opts);
  if (!res.ok) { await cleanupWork(res.work); return res; }
  // The client may have pressed 停止 while ffmpeg was running. Never commit a
  // repair the user has already cancelled.
  if (opts.isAborted?.()) {
    await cleanupWork(res.work);
    return { ok: false, tried: res.tried, reasons: ['已停止，原文件未改动'] };
  }
  const sibling = join(dirname(src), `.${basename(src)}.repairing`);
  try {
    await copyFile(res.output, sibling);
    await rename(sibling, src);
    return { ...res, replaced: true };
  } catch (e) {
    await rm(sibling, { force: true }).catch(() => {});
    await cleanupWork(res.work);
    return { ok: false, tried: res.tried, reasons: [`写回原文件失败：${e}`] };
  } finally {
    await cleanupWork(res.work);
  }
}