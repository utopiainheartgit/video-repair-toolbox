// AAC-LC salvage from the gaps between video NAL units.
//
// When a file loses its moov, the audio track's setup (sample rate, channel
// count, whether frames are ADTS or raw) goes with it. But the frames are still
// interleaved in mdat. ADTS frames are self-describing: a 7-byte header gives
// the frame length, sample rate and channel config. Raw AAC frames (as stored
// inside MP4) have no length at all, so we locate candidate sync elements and
// segment them by the dominant frame gap. The recovered frame count is a clock:
// N frames x 1024 samples / sampleRate is the exact audio duration, which the
// caller uses to recover the true frame rate.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FFMPEG, run } from './probe.mjs';

const SF_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0];
const MAX_FRAME = 8192;

function readAdtsHeader(buf, off) {
  if (off + 7 > buf.length) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) return null;
  if (((buf[off + 1] >> 1) & 0x3) !== 0) return null;
  const profile = (buf[off + 2] >> 6) & 0x3;
  const sfIndex = (buf[off + 2] >> 2) & 0xf;
  const chanCfg = ((buf[off + 2] & 0x1) << 2) | ((buf[off + 3] >> 6) & 0x3);
  const frameLen = ((buf[off + 3] & 0x3) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x7);
  if (frameLen < 7 || frameLen > MAX_FRAME || sfIndex >= 13) return null;
  return { frameLen, profile, sfIndex, chanCfg, sampleRate: SF_RATES[sfIndex] };
}

function findSync(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xf0) === 0xf0) return i;
  }
  return -1;
}

function hasAdtsChain(buf) {
  let off = findSync(buf, 0), n = 0;
  while (off >= 0 && n < 4) {
    const h = readAdtsHeader(buf, off);
    if (!h) break;
    off = findSync(buf, off + h.frameLen);
    n++;
  }
  return n >= 4;
}

function splitAdts(buf) {
  const frames = [];
  let off = findSync(buf, 0);
  while (off >= 0) {
    const h = readAdtsHeader(buf, off);
    if (!h) { off = findSync(buf, off + 1); continue; }
    if (off + h.frameLen > buf.length) break;
    frames.push(buf.subarray(off, off + h.frameLen));
    off = findSync(buf, off + h.frameLen);
  }
  return frames;
}

// CPE (channel_pair_element) with element_instance_tag 0 opens 0x20/0x21. SCE
// (mono) opens 0x00/0x01, but 0x00 is everywhere in compressed video, so we
// only trust it when followed by a non-zero byte.
function looksLikeRawAac(b, next) {
  if (b === 0x20 || b === 0x21) return true;
  if ((b === 0x00 || b === 0x01) && next !== 0x00) return true;
  return false;
}

function splitRawAac(buf) {
  const cands = [];
  for (let i = 0; i + 1 < buf.length; i++) {
    if (looksLikeRawAac(buf[i], buf[i + 1])) cands.push(i);
  }
  if (cands.length < 8) return { frames: [], median: 0 };
  const gaps = [];
  for (let i = 1; i < cands.length; i++) {
    const d = cands[i] - cands[i - 1];
    if (d >= 32 && d <= 4096) gaps.push(d);
  }
  if (!gaps.length) return { frames: [], median: 0 };
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const frames = [];
  for (let i = 0; i < cands.length - 1; i++) {
    const len = cands[i + 1] - cands[i];
    if (len < median * 0.4 || len > median * 2.2) continue;
    if (len > MAX_FRAME) continue;
    frames.push(buf.subarray(cands[i], cands[i + 1]));
  }
  return { frames, median };
}

function adtsHeader(frameLen, profile, sfIndex, chanCfg) {
  const total = frameLen + 7;
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf1; // MPEG-4, layer 0, no CRC
  h[2] = ((profile & 0x3) << 6) | ((sfIndex & 0xf) << 2) | ((chanCfg >> 2) & 0x1);
  h[3] = ((chanCfg & 0x3) << 6) | ((total >> 11) & 0x3);
  h[4] = (total >> 3) & 0xff;
  h[5] = ((total & 0x7) << 5) | 0x1f; // buffer fullness = 0x7FF
  h[6] = 0xfc; // fullness low bits, 0 raw blocks
  return h;
}

function guessSampleRateIndex(rate) {
  let best = 0, bestErr = Infinity;
  for (let i = 0; i < 13; i++) {
    if (!SF_RATES[i]) continue;
    const err = Math.abs(SF_RATES[i] - rate) / SF_RATES[i];
    if (err < bestErr) { bestErr = err; best = i; }
  }
  return best;
}

// ranges: [[start,end],...] byte spans that video parsing rejected.
export async function salvageAudio(fh, ranges, { sampleRate = 0, channels = 0, work, maxBytes = 192 * 1024 * 1024, videoFrames = 0 } = {}) {
  let budget = maxBytes;
  const parts = [];
  for (const [s, e] of ranges) {
    const len = e - s;
    if (len < 64) continue;
    const take = Math.min(len, Math.max(0, budget));
    if (take <= 0) break;
    const b = Buffer.alloc(take);
    await fh.read(b, 0, take, s);
    parts.push(b);
    budget -= take;
    if (budget <= 0) break;
  }
  if (!parts.length) return { ok: false, reason: '没有可用的数据空隙' };
  const buf = Buffer.concat(parts);

  let frames = [];
  let mode = 'adts';
  let sfIndex = sampleRate ? guessSampleRateIndex(sampleRate) : 3; // default 48k
  let chanCfg = channels === 1 ? 1 : channels === 2 ? 2 : 2;

  if (hasAdtsChain(buf)) {
    frames = splitAdts(buf);
    const h = frames.length ? readAdtsHeader(frames[0], 0) : null;
    if (h) { sfIndex = h.sfIndex; chanCfg = h.chanCfg || chanCfg; }
  } else {
    const r = splitRawAac(buf);
    if (r.frames.length >= 20 && r.median >= 64) {
      frames = r.frames;
      mode = 'raw-heuristic';
    } else {
      return { ok: false, reason: '未识别到成链的 AAC 帧' };
    }
  }

  if (frames.length < 10) return { ok: false, reason: `AAC 帧过少（${frames.length}）` };

  const out = [];
  if (mode === 'adts') {
    for (const f of frames) out.push(f);
  } else {
    const sf = sampleRate || SF_RATES[sfIndex];
    sfIndex = guessSampleRateIndex(sf);
    for (const f of frames) out.push(adtsHeader(f.length, 1, sfIndex, chanCfg), f);
  }

  const sr = SF_RATES[sfIndex] || sampleRate || 48000;
  const duration = frames.length * 1024 / sr;

  // A raw-frame guess implying far more audio than the video could ever hold
  // is video bytes sliced into pseudo-frames, not real audio.
  if (mode === 'raw-heuristic' && videoFrames > 0 && duration > videoFrames * 0.6 + 10) {
    return { ok: false, reason: `音频时长 ${duration.toFixed(1)}s 与视频帧数不匹配，判定为误识别` };
  }

  const path = join(work, 'salvaged.aac');
  await writeFile(path, Buffer.concat(out));

  // Verify the salvaged stream actually decodes. A bad raw-AAC split produces
  // bytes ffmpeg rejects; better to report "no audio" than ship noise.
  const check = await run(FFMPEG, ['-v', 'error', '-i', path, '-t', '3', '-f', 'null', '-'], { timeout: 60_000 });
  if (check.code !== 0 || /Invalid data|Decode error rate|channel element/i.test(check.stderr)) {
    return { ok: false, reason: '抢救出的音频无法解码（切分精度不足）' };
  }

  return {
    ok: true, path, frames: frames.length, sampleRate: sr,
    channels: chanCfg, duration, mode,
  };
}
