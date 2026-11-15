import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';

export const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.3gp', '.3g2', '.ogv',
  '.vob', '.divx', '.f4v', '.rm', '.rmvb', '.asf', '.mxf',
]);

export function isVideoFile(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && VIDEO_EXT.has(name.slice(i).toLowerCase());
}

export function run(bin, args, { timeout = 0, onStderr, onStdout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timer = null;

    if (timeout > 0) {
      timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    }
    child.stdout.on('data', (d) => {
      const s = d.toString();
      // A long re-encode emits thousands of progress blocks; don't buffer them
      // when the caller is consuming the stream.
      if (!onStdout) stdout += s;
      if (onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), killed });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, killed });
    });
  });
}

export const PROGRESS_ARGS = ['-progress', 'pipe:1', '-nostats'];

// ffmpeg -progress emits key=value blocks terminated by progress=continue|end.
// out_time_ms is microseconds despite the name; out_time_us is the same unit.
export function makeProgressParser(durationSec, emit) {
  let buf = '';
  let cur = {};
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k !== 'progress') { cur[k] = v; continue; }
      const sec = Number(cur.out_time_us ?? cur.out_time_ms ?? 0) / 1e6;
      const ended = v === 'end';
      emit({
        percent: ended ? 100 : (durationSec > 0 ? Math.min(99, (sec / durationSec) * 100) : null),
        outTime: sec,
        speed: (cur.speed || '').trim(),
        fps: Number(cur.fps) || 0,
        size: Number(cur.total_size) || 0,
        ended,
      });
      cur = {};
    }
  };
}

export async function ffprobe(file) {
  const r = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { timeout: 120_000 });
  if (r.code !== 0) return { ok: false, error: r.stderr.trim(), raw: null };
  try {
    return { ok: true, error: '', raw: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, error: 'ffprobe 输出无法解析', raw: null };
  }
}

// Walks top-level ISO-BMFF boxes by seeking, so a multi-GB mdat costs one read.
export async function inspectBoxes(file) {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch (e) {
    return { ok: false, boxes: [], error: String(e) };
  }
  try {
    const { size: fileSize } = await fh.stat();
    const boxes = [];
    let pos = 0;
    let truncated = false;
    const head = Buffer.alloc(16);

    while (pos + 8 <= fileSize) {
      const { bytesRead } = await fh.read(head, 0, 16, pos);
      if (bytesRead < 8) { truncated = true; break; }
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) { truncated = true; break; }
        boxSize = Number(head.readBigUInt64BE(8));
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = fileSize - pos;
      }
      if (!/^[\x20-\x7e]{4}$/.test(type) || boxSize < headerLen) {
        truncated = true;
        break;
      }
      const end = pos + boxSize;
      boxes.push({ type, start: pos, size: boxSize, overrunsEof: end > fileSize });
      if (end > fileSize) { truncated = true; break; }
      pos = end;
      if (boxes.length > 4096) break;
    }
    if (pos < fileSize && !truncated) truncated = true;
    return { ok: true, boxes, truncated, fileSize, error: '' };
  } finally {
    await fh.close();
  }
}

// ffprobe silently guesses duration when an AVI loses idx1 — it emits no
// warning at any verbosity, so the index has to be checked structurally.
export async function hasAviIndex(file) {
  let fh;
  try { fh = await open(file, 'r'); } catch { return null; }
  try {
    const { size } = await fh.stat();
    const n = Math.min(size, 32 * 1024 * 1024);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, size - n);
    return buf.indexOf(Buffer.from('idx1', 'latin1')) >= 0;
  } finally { await fh.close(); }
}

const MP4_TOP_TYPES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'pnot', 'moof', 'sidx', 'styp', 'emsg', 'meta']);

const ERROR_PATTERNS = [
  [/moov atom not found/i, 'MOOV_MISSING', 'MP4 索引(moov)缺失，通常是下载中断或录制断电'],
  [/moov atom is invalid|invalid moov/i, 'MOOV_INVALID', 'MP4 索引(moov)损坏'],
  [/non-existing PPS|non-existing SPS/i, 'H264_PARAMS', 'H.264 参数集(PPS/SPS)缺失'],
  [/Invalid NAL unit size|Invalid NAL/i, 'BITSTREAM', 'H.264 NAL 单元损坏'],
  [/error while decoding MB|concealing \d+ DC/i, 'BITSTREAM', '视频码流损坏（解码器正在掩盖错误）'],
  [/corrupt (input|data|frame)|corrupted/i, 'BITSTREAM', '码流数据损坏'],
  [/Invalid data found when processing input/i, 'CORRUPT_DATA', '容器或码流含无效数据'],
  [/Could not find codec parameters/i, 'CODEC_PARAMS', '无法确定编解码参数'],
  [/Non-monotonous DTS|non-monotonic/i, 'TIMESTAMP', '时间戳非单调，会导致卡顿或音画不同步'],
  [/Application provided (duration|pts).*invalid|Invalid DTS|Invalid PTS/i, 'TIMESTAMP', '时间戳非法'],
  [/Estimating duration from bitrate/i, 'NO_INDEX', '缺少索引，时长由码率估算（AVI/TS 常见）'],
  [/max_analyze_duration|not enough frames to estimate rate/i, 'PROBE_LIMIT', '探测样本不足，可能影响时长判断'],
  [/read error|End of file|premature end|truncated/i, 'TRUNCATED', '文件被截断，数据不完整'],
  [/Failed to read frame|error reading header/i, 'READ_FAIL', '读取帧或文件头失败'],
  [/Unknown encoder|Decoder .* not found|Unsupported codec/i, 'CODEC_UNSUPPORTED', '本机 ffmpeg 不支持该编码'],
];

export function classifyErrors(stderr) {
  const found = new Map();
  for (const line of stderr.split('\n')) {
    for (const [re, code, desc] of ERROR_PATTERNS) {
      if (re.test(line)) {
        if (!found.has(code)) found.set(code, { code, desc, samples: [] });
        const e = found.get(code);
        if (e.samples.length < 3) e.samples.push(line.trim().slice(0, 300));
      }
    }
  }
  return [...found.values()];
}

// Cheap decode probe: head + tail, instead of walking the whole file.
export async function decodeSample(file, { seconds = 12, duration = 0, onProgress } = {}) {
  const runs = [];
  const tail = duration > seconds * 2;
  const emitPhase = (base, span, label) => (p) => {
    if (!onProgress) return;
    const local = duration > 0 ? Math.min(1, p.outTime / Math.min(seconds, duration)) : 0;
    onProgress({ ...p, stage: label, percent: base + span * local });
  };

  runs.push(await run(FFMPEG, [
    '-v', 'error', '-xerror', ...PROGRESS_ARGS, '-i', file, '-t', String(seconds),
    '-map', '0:v:0?', '-f', 'null', '-',
  ], { timeout: 180_000, onStdout: makeProgressParser(seconds, emitPhase(0, tail ? 50 : 100, '解码抽样·片头')) }));

  if (tail) {
    runs.push(await run(FFMPEG, [
      '-v', 'error', '-xerror', ...PROGRESS_ARGS,
      '-ss', String(Math.max(0, duration - seconds)),
      '-i', file, '-t', String(seconds),
      '-map', '0:v:0?', '-f', 'null', '-',
    ], { timeout: 180_000, onStdout: makeProgressParser(seconds, emitPhase(50, 50, '解码抽样·片尾')) }));
  }
  const stderr = runs.map((r) => r.stderr).join('\n');
  return { ok: runs.every((r) => r.code === 0), stderr };
}

export async function decodeFull(file, { duration = 0, onProgress } = {}) {
  const r = await run(FFMPEG, [
    '-v', 'error', ...PROGRESS_ARGS, '-i', file, '-map', '0:v:0?', '-f', 'null', '-',
  ], {
    timeout: 0,
    onStdout: makeProgressParser(duration, (p) => onProgress?.({ ...p, stage: '整片解码' })),
  });
  return { ok: r.code === 0, stderr: r.stderr };
}

export function summarize(raw) {
  if (!raw) return null;
  const f = raw.format || {};
  const streams = raw.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(f.duration ?? v?.duration ?? 0) || 0;
  return {
    format: f.format_name || '',
    duration,
    size: Number(f.size ?? 0) || 0,
    bitRate: Number(f.bit_rate ?? 0) || 0,
    video: v ? {
      codec: v.codec_name, profile: v.profile, width: v.width, height: v.height,
      pixFmt: v.pix_fmt, fps: evalFps(v.avg_frame_rate), bitDepth: bitDepthOf(v),
      hdr: isHdr(v),
    } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: a.sample_rate } : null,
    streamCount: streams.length,
  };
}

function evalFps(s) {
  if (!s) return 0;
  const [n, d] = s.split('/').map(Number);
  return d ? n / d : n || 0;
}

function bitDepthOf(v) {
  const m = /(\d+)le|(\d+)be/.exec(v.pix_fmt || '');
  if (m) return Number(m[1] || m[2]);
  return /p10|p12|p16/.test(v.pix_fmt || '') ? Number(/p(\d+)/.exec(v.pix_fmt)[1]) : 8;
}

function isHdr(v) {
  return v.color_transfer === 'smpte2084' || v.color_transfer === 'arib-std-b67'
    || v.color_primaries === 'bt2020';
}

export async function diagnose(file, { deep = false, onProgress } = {}) {
  const st = await stat(file).catch(() => null);
  if (!st) return { file, verdict: 'unreadable', problems: [{ code: 'UNREADABLE', desc: '文件不存在或无读取权限' }] };
  if (st.size === 0) return { file, verdict: 'broken', problems: [{ code: 'EMPTY', desc: '文件大小为 0' }], size: 0 };

  const probe = await ffprobe(file);
  const info = summarize(probe.raw);
  const problems = [];

  if (!probe.ok) {
    problems.push(...classifyErrors(probe.error));
    if (!problems.length) problems.push({ code: 'PROBE_FAIL', desc: 'ffprobe 无法解析该文件', samples: [probe.error.slice(0, 300)] });
  }

  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  let boxes = null;
  if (['.mp4', '.m4v', '.mov', '.3gp', '.3g2', '.f4v'].includes(ext)) {
    boxes = await inspectBoxes(file);
    if (boxes.ok) {
      const types = boxes.boxes.map((b) => b.type);
      const looksLikeMp4 = types.length > 0 && types.some((t) => MP4_TOP_TYPES.has(t));
      if (!looksLikeMp4) {
        problems.push({ code: 'NOT_MP4', desc: '扩展名是 MP4/MOV，但内容不是有效的 ISO-BMFF 容器（可能下载到了错误页面或文件被改名）' });
      } else {
        if (!types.includes('moov')) {
          problems.push({
            code: 'MOOV_MISSING',
            desc: types.includes('mdat')
              ? 'MP4 索引(moov)缺失但视频数据(mdat)存在 —— 典型的下载中断/录制断电，需要 untrunc + 参考文件'
              : 'MP4 索引(moov)缺失，且未见完整视频数据',
          });
        }
        if (boxes.truncated) problems.push({ code: 'BOX_TRUNCATED', desc: 'MP4 box 结构在文件末尾被截断' });
        if (!types.includes('ftyp')) problems.push({ code: 'NO_FTYP', desc: '缺少 ftyp 文件类型头' });
      }
    }
  }

  if (ext === '.avi') {
    const idx = await hasAviIndex(file);
    if (idx === false) {
      problems.push({ code: 'NO_INDEX', desc: 'AVI 索引(idx1)缺失 —— 时长靠码率估算不准，拖动进度条会失效或极慢' });
    }
  }

  let decode = null;
  if (probe.ok) {
    decode = deep
      ? await decodeFull(file, { duration: info?.duration || 0, onProgress })
      : await decodeSample(file, { duration: info?.duration || 0, onProgress });
    if (!decode.ok) {
      const cls = classifyErrors(decode.stderr);
      for (const c of cls) if (!problems.some((p) => p.code === c.code)) problems.push(c);
      if (!cls.length) problems.push({ code: 'DECODE_FAIL', desc: '解码失败', samples: [decode.stderr.slice(-400)] });
    }
  }

  // ffprobe reports "moov atom not found" for anything it cannot parse, including
  // a text file renamed to .mp4. Once we know it is not a container at all, those
  // downstream symptoms are noise.
  let reported = problems;
  if (problems.some((p) => p.code === 'NOT_MP4')) {
    reported = problems.filter((p) => !['MOOV_MISSING', 'BOX_TRUNCATED', 'NO_FTYP'].includes(p.code));
  }

  // Deduplicate, then rank severity so the UI can lead with the real blocker.
  const uniq = [...new Map(reported.map((p) => [p.code, p])).values()];
  const fatal = uniq.some((p) => ['MOOV_MISSING', 'EMPTY', 'PROBE_FAIL', 'UNREADABLE', 'READ_FAIL', 'NOT_MP4'].includes(p.code));
  const verdict = uniq.length === 0 ? 'healthy' : fatal ? 'broken' : 'damaged';

  return {
    file, size: st.size, verdict, info, problems: uniq,
    boxes: boxes?.ok ? boxes.boxes.map((b) => ({ type: b.type, size: b.size })) : null,
    probeError: probe.ok ? '' : probe.error.slice(0, 1000),
    decodeChecked: probe.ok ? (deep ? 'full' : 'sample') : 'none',
  };
}