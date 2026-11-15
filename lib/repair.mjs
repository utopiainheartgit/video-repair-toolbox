import { join, dirname, basename, extname } from 'node:path';
import { mkdtemp, rm, rename, stat, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FFMPEG, run, ffprobe, summarize, decodeSample, classifyErrors, PROGRESS_ARGS, makeProgressParser } from './probe.mjs';

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

function pickContainer(src) {
  const e = extname(src).toLowerCase();
  if (['.mkv', '.webm'].includes(e)) return { ext: e, args: [] };
  if (e === '.avi') return { ext: '.avi', args: [] };
  if (e === '.ts' || e === '.m2ts' || e === '.mts') return { ext: e, args: [] };
  return { ext: '.mp4', args: ['-movflags', '+faststart'] };
}

async function canDecodeFrame(file) {
  const r = await run(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { timeout: 120_000 });
  return r.code === 0;
}

// A repaired file must prove it is at least as complete as the source before
// we let it replace the original. This is the gate that makes in-place safe.
export async function validate(outPath, srcInfo, { strict = true } = {}) {
  const reasons = [];
  const st = await stat(outPath).catch(() => null);
  if (!st || st.size === 0) return { ok: false, reasons: ['修复产物为空或不存在'] };

  const probe = await ffprobe(outPath);
  if (!probe.ok) return { ok: false, reasons: ['修复产物无法被 ffprobe 解析', probe.error.slice(0, 200)] };
  const info = summarize(probe.raw);

  // Absolute floor, independent of the source: untrunc can emit a stream-less
  // shell from garbage input, and an unreadable source gives us nothing to
  // compare against. Never let an empty container overwrite a real file.
  if (!info?.video) return { ok: false, reasons: ['修复产物不含任何视频流（空壳容器）'], info };
  if (!(await canDecodeFrame(outPath))) return { ok: false, reasons: ['修复产物无法解码出任何一帧'], info };

  if (srcInfo?.audio && !info?.audio) reasons.push('修复产物丢失了音频流');

  const srcDur = srcInfo?.duration || 0;
  if (info.duration <= 0) {
    reasons.push('修复产物时长为 0');
  } else if (srcDur > 1) {
    const ratio = info.duration / srcDur;
    if (ratio < 0.9) reasons.push(`时长从 ${srcDur.toFixed(1)}s 缩短到 ${info.duration.toFixed(1)}s（仅剩 ${(ratio * 100).toFixed(0)}%），疑似内容丢失`);
  }

  if (strict) {
    const dec = await decodeSample(outPath, { duration: info.duration });
    if (!dec.ok) {
      const cls = classifyErrors(dec.stderr);
      reasons.push('修复产物解码仍有错误' + (cls.length ? `：${cls.map((c) => c.code).join(', ')}` : ''));
    }
  }
  return { ok: reasons.length === 0, reasons, info };
}

async function tryUntrunc(src, work, reference, log, prog) {
  const bin = await findUntrunc();
  if (!bin) { log('untrunc 未安装，跳过索引重建'); return null; }
  if (!reference) { log('未提供参考文件，跳过 untrunc（需要同设备录制的完好视频）'); return null; }

  log(`untrunc 重建索引，参考文件：${basename(reference)}`);
  prog({ stage: 'untrunc 索引重建', percent: 0 });
  const dest = join(work, 'untrunc.mp4');
  // -n: never prompt (would hang the server). -dst: keep artifacts out of the user's folder.
  const r = await run(bin, ['-n', '-dst', dest, reference, src], {
    timeout: 3_600_000,
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

async function tryRemux(src, work, variant, log, prog, duration) {
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
    timeout: 3_600_000,
    onStdout: makeProgressParser(duration, (p) => prog({ ...p, stage: label })),
  });
  if (r.stderr.trim()) log(r.stderr.trim().slice(-1200));
  if (r.code !== 0 && !(await stat(out).catch(() => null))) return null;
  return out;
}

async function tryReencode(src, work, srcInfo, log, prog) {
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
      timeout: 7_200_000,
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
  allowReencode = true,
  diagnosis = null,
  onLog = () => {},
  onProgress = () => {},
} = {}) {
  const log = (m) => onLog(String(m));
  const prog = (p) => onProgress(p);
  const srcInfo = diagnosis?.info || summarize((await ffprobe(src)).raw);
  const duration = srcInfo?.duration || 0;
  const codes = new Set((diagnosis?.problems || []).map((p) => p.code));
  const hopeless = ['EMPTY', 'NOT_MP4', 'UNREADABLE'].find((c) => codes.has(c));
  if (hopeless) {
    const why = {
      EMPTY: '文件为 0 字节，没有任何可恢复的数据',
      NOT_MP4: '内容不是视频容器（可能是下载到的错误页面或被改名的文件），无视频数据可恢复',
      UNREADABLE: '文件不存在或无读取权限',
    }[hopeless];
    log(`不可修复：${why}`);
    return { ok: false, output: null, work: null, tried: [], reasons: [why] };
  }
  const work = await mkdtemp(join(tmpdir(), 'vrepair-'));
  const tried = [];
  const verifying = () => prog({ stage: '校验修复产物', percent: null });

  try {
    if (codes.has('MOOV_MISSING') || codes.has('MOOV_INVALID')) {
      const p = await tryUntrunc(src, work, reference, log, prog);
      tried.push('untrunc');
      if (p) {
        verifying();
        const v = await validate(p, srcInfo, { strict: false });
        if (v.ok) return { ok: true, output: p, work, strategy: 'untrunc 索引重建', tried, info: v.info };
        log(`untrunc 产物未通过校验：${v.reasons.join('；')}`);
      }
    }

    for (const variant of ['plain', 'genpts', 'aggressive']) {
      const p = await tryRemux(src, work, variant, log, prog, duration);
      tried.push(`remux:${variant}`);
      if (!p) continue;
      verifying();
      const v = await validate(p, srcInfo);
      if (v.ok) return { ok: true, output: p, work, strategy: `无损重新封装 (${variant})`, tried, info: v.info };
      log(`remux:${variant} 未通过校验：${v.reasons.join('；')}`);
    }

    if (allowReencode) {
      const p = await tryReencode(src, work, srcInfo, log, prog);
      tried.push('reencode');
      if (p) {
        verifying();
        const v = await validate(p, srcInfo, { strict: false });
        if (v.ok) return { ok: true, output: p, work, strategy: '重编码修复', tried, info: v.info };
        log(`重编码产物未通过校验：${v.reasons.join('；')}`);
      }
    } else {
      log('已禁用重编码，无损手段全部失败');
    }

    return { ok: false, output: null, work, tried, reasons: ['所有修复策略均未产出通过校验的文件'] };
  } catch (e) {
    return { ok: false, output: null, work, tried, reasons: [String(e)] };
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