// Video merging engine.
//
// The whole design follows the approach used by dsh-video-merger and
// merge-video: never re-encode unless the clips genuinely differ, and when they
// do, normalise every clip to one target spec first and concatenate the
// normalised parts without re-encoding them again. That keeps a merge at a
// single encoding generation no matter how many clips it has.
//
// Tiers, cheapest first:
//   copy    – identical streams + container + time base → concat demuxer -c copy
//   remux   – identical streams, different container/time base → per-clip MPEG-TS
//             remux, then concat copy (no video re-encode, no seam stutter)
//   encode  – anything really mixed → normalise each clip to the target spec,
//             then concat copy. If only the audio differs, video is copied.
import { join, dirname, basename, extname } from 'node:path';
import { mkdtemp, mkdir, rm, stat, writeFile, access, rename } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FFMPEG, run, ffprobe, PROGRESS_ARGS, makeProgressParser, decodeSample } from './probe.mjs';

const MP4_VIDEO = new Set(['h264', 'hevc', 'av1', 'mpeg4', 'vp9']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus']);
const CRF = { high: 18, balanced: 20, small: 23 };

const abortError = () => Object.assign(new Error('已停止'), { aborted: true });
const even = (n) => (Math.round(n / 2) * 2) || 2;
const trim = (s, n = 240) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function evalFps(s) {
  if (!s || s === '0/0') return 0;
  const [n, d] = String(s).split('/').map(Number);
  const v = d ? n / d : n || 0;
  return v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : 0;
}

// ---------- probing ----------

export async function probeClip(file) {
  const name = basename(file);
  const st = await stat(file).catch(() => null);
  if (!st) return { file, name, ok: false, error: '文件不存在或无读取权限' };
  if (!st.isFile()) return { file, name, ok: false, error: '不是文件' };

  const p = await ffprobe(file);
  if (!p.ok) return { file, name, size: st.size, ok: false, error: trim(p.error, 200) || '无法解析' };

  const streams = p.raw.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) return { file, name, size: st.size, ok: false, error: '没有视频轨道' };

  const f = p.raw.format || {};
  const fps = evalFps(v.avg_frame_rate) || evalFps(v.r_frame_rate);
  return {
    file, name, size: st.size, ok: true,
    duration: Number(f.duration ?? v.duration ?? 0) || 0,
    container: (f.format_name || '').split(',')[0] || '',
    video: {
      codec: v.codec_name, profile: v.profile || '', level: v.level ?? '',
      width: v.width || 0, height: v.height || 0,
      pixFmt: v.pix_fmt || '', fps,
      sar: v.sample_aspect_ratio || '1:1',
      timeBase: v.time_base || '',
      fieldOrder: v.field_order || 'progressive',
      frames: Number(v.nb_frames) || 0,
    },
    audio: a ? {
      codec: a.codec_name, profile: a.profile || '',
      sampleRate: Number(a.sample_rate) || 0,
      channels: a.channels || 0,
      layout: a.channel_layout || '',
    } : null,
  };
}

const videoSig = (c) => {
  const v = c.video;
  return [v.codec, v.profile, v.level, v.width, v.height, v.pixFmt, v.fps, v.sar, v.fieldOrder].join('|');
};
const audioSig = (c) => (c.audio
  ? [c.audio.codec, c.audio.profile, c.audio.sampleRate, c.audio.channels].join('|')
  : 'none');
const allSame = (arr) => arr.every((x) => x === arr[0]);

// ---------- planning ----------

export function buildPlan(clips, { mode = 'auto', size = 'first', quality = 'balanced' } = {}) {
  const usable = clips.filter((c) => c.ok);
  if (usable.length < 2) {
    return { ok: false, reasons: ['至少需要 2 个可解析的视频片段'], strategy: null };
  }
  const bad = clips.filter((c) => !c.ok);
  const warnings = bad.map((c) => `${c.name}：${c.error}（已排除）`);

  const vs = usable.map(videoSig);
  const as = usable.map(audioSig);
  const cs = usable.map((c) => c.container);
  const ts = usable.map((c) => c.video.timeBase);

  const videoEqual = allSame(vs);
  const audioEqual = allSame(as);
  const containerEqual = allSame(cs);
  const timeBaseEqual = allSame(ts);

  // Target video geometry.
  const first = usable[0].video;
  let tw = first.width, th = first.height;
  if (size === 'max' || size === 'min') {
    const sorted = [...usable].sort((a, b) =>
      (a.video.width * a.video.height) - (b.video.width * b.video.height));
    const pickV = (size === 'max' ? sorted[sorted.length - 1] : sorted[0]).video;
    tw = pickV.width; th = pickV.height;
  }
  const fps = first.fps || Math.max(...usable.map((c) => c.video.fps || 0)) || 0;

  // Target audio: prefer the first clip that actually carries sound.
  const withAudio = usable.find((c) => c.audio);
  const targetAudio = withAudio
    ? {
      sampleRate: withAudio.audio.sampleRate || 48000,
      channels: Math.min(2, withAudio.audio.channels || 2),
    }
    : null;
  if (targetAudio) targetAudio.bitrate = targetAudio.channels > 1 ? 192_000 : 96_000;

  let strategy;
  if (mode === 'copy') {
    strategy = 'copy';
    if (!videoEqual || !audioEqual || !containerEqual || !timeBaseEqual) {
      return {
        ok: false,
        strategy,
        warnings,
        reasons: ['强制无损模式下，片段规格不一致（需要相同的编码、分辨率、帧率、音频与容器）。请改用“自动”或“强制重编码”，或先统一规格。'],
      };
    }
  } else if (mode === 'encode') {
    strategy = 'encode';
  } else if (videoEqual && audioEqual && containerEqual && timeBaseEqual) {
    strategy = 'copy';
  } else if (videoEqual && audioEqual) {
    strategy = 'remux';
  } else {
    strategy = 'encode';
  }

  // Audio-only differences still let the video be stream-copied.
  const copyVideo = strategy === 'encode' && videoEqual;

  if (strategy !== 'copy' && usable.length > 1) {
    const res = new Set(usable.map((c) => `${c.video.width}x${c.video.height}`));
    if (res.size > 1) warnings.push(`片段分辨率不一致（${[...res].join(' / ')}），将统一缩放到 ${tw}×${th} 并加黑边`);
    const fpsSet = new Set(usable.map((c) => c.video.fps));
    if (fpsSet.size > 1) warnings.push(`片段帧率不一致（${[...fpsSet].join(' / ')}），将统一为 ${fps} fps`);
    const codecSet = new Set(usable.map((c) => c.video.codec));
    if (codecSet.size > 1) warnings.push(`片段编码不一致（${[...codecSet].join(' / ')}），将统一重编码`);
    const noAudio = usable.filter((c) => !c.audio);
    if (noAudio.length && targetAudio) warnings.push(`${noAudio.length} 个片段没有音轨，将为它们补等长静音`);
    if (!targetAudio) warnings.push('所有片段都没有音轨，合并结果将没有声音');
  }

  const outExt = strategy === 'encode' && !copyVideo
    ? 'mp4'
    : (MP4_VIDEO.has(usable[0].video.codec) && (!usable[0].audio || MP4_AUDIO.has(usable[0].audio.codec)) ? 'mp4' : 'mkv');

  return {
    ok: true,
    strategy,
    copyVideo,
    outExt,
    warnings,
    videoEqual,
    audioEqual,
    target: {
      width: even(tw), height: even(th), fps,
      pixFmt: 'yuv420p',
      audio: targetAudio,
      needScale: !videoEqual || size !== 'first',
    },
    crf: CRF[quality] || CRF.balanced,
    expectedDuration: usable.reduce((n, c) => n + (c.duration || 0), 0),
    usableCount: usable.length,
  };
}

// Per-clip label for the UI, so the user sees why a clip needs re-encoding.
export function clipAction(clip, plan) {
  if (!clip.ok) return 'skip';
  if (plan.strategy === 'copy') return 'copy';
  if (plan.strategy === 'remux') return 'remux';
  if (plan.copyVideo) return clip.audio ? 'audio' : 'silence';
  return 'encode';
}

// ---------- output naming ----------

async function exists(p) { try { await access(p); return true; } catch { return false; } }

// macOS and Windows filesystems are case-insensitive by default, so `A.mp4`
// and `a.mp4` are the same file. Never let an output collide with an input —
// a merge must be strictly non-destructive to its sources.
const samePath = (a, b) => (process.platform === 'darwin' || process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase()
  : a === b);

// By default a product lands in the SAME folder as its first source clip —
// not a `merged/` subfolder — unless the user explicitly picks another place.
// The `_merged` stem marker plus a strict extension keeps generated products
// distinguishable from real sources during directory re-scans.
export const OUTPUT_DIR = 'merged'; // kept for backward compat; no longer a mandatory subfolder

// A product generated by defaultOutput always carries this exact marker. The
// directory scanner uses it to avoid feeding a previous merge back in as a
// source. Deliberately strict: `_merged`, optional `_tNN` task tag, optional
// `-N` collision suffix, then a file extension.
const PRODUCT_RE = /_merged(?:_t\d{1,3})?(?:-\d+)?\.[^.]+$/i;
export const isMergeProduct = (name) => PRODUCT_RE.test(String(name || ''));

// A product we produced ourselves must not turn into `x_merged_t02_merged_t02`
// when it is merged again. Strip our own trailing markers — including the
// `-2` collision suffix — but only when a merge mark is actually present, so a
// user file legitimately named `holiday-2.mp4` keeps its name.
function stripOwnMarks(stem) {
  const re = /[_\-\s]*(?:merged|已合并)(?:[_\-\s]*t\d{1,3})?(?:-\d+)?$/i;
  let s = stem;
  for (let i = 0; i < 5 && re.test(s); i++) s = s.replace(re, '');
  return s;
}

// Characters that break Finder, Windows, SMB shares or shell one-liners.
// Colons are legal on APFS but Finder renders them as `/`, which is worse.
function safeStem(raw) {
  const cleaned = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  // APFS caps a name at 255 bytes and a Chinese char costs 3, so 60 chars of
  // stem leaves room for the suffix even for all-CJK names.
  const chars = [...cleaned];
  const cut = (chars.length > 60 ? chars.slice(0, 60).join('') : cleaned)
    .replace(/[\s.\-_]+$/g, '');
  return cut || 'video';
}

/**
 * Build the default product path in the SAME folder as the first source:
 * `<stem>_merged[_tNN][-N].<ext>`.
 *
 * `_tNN` is added only for multi-task runs: it keeps Finder's alphabetical
 * order equal to the queue order, and it distinguishes tasks whose first clip
 * is generically named (`1.mp4`, `2.mp4`). Collision suffixes use `-2` rather
 * than ` (1)` — spaces and parentheses break shell one-liners and some
 * players, and `(1)`/`(10)` sort inconsistently.
 */
export async function defaultOutput(firstFile, ext, { index = 0, total = 1 } = {}) {
  const stem = safeStem(stripOwnMarks(basename(firstFile, extname(firstFile))));
  const tag = total > 1 ? `_t${String(index + 1).padStart(2, '0')}` : '';
  const base = `${stem}_merged${tag}`;
  const dir = dirname(firstFile);
  let candidate = join(dir, `${base}.${ext}`);
  for (let i = 2; await exists(candidate) && i <= 999; i++) {
    candidate = join(dir, `${base}-${i}.${ext}`);
  }
  // If even -999 is taken, fall back to a unique suffix instead of returning
  // an occupied path that rename() would silently overwrite.
  if (await exists(candidate)) {
    candidate = join(dir, `${base}-${Date.now().toString(36)}.${ext}`);
  }
  return candidate;
}

// A typed-in extension is never authoritative: the merge plan decides the real
// container. Strip any media suffix the user may have added so `holiday.avi`
// becomes `holiday.mp4` when the product is actually mp4. Unknown trailing
// text like `cut v2` is preserved as part of the name.
const MEDIA_EXT = /\.(?:mp4|m4v|mov|mkv|avi|webm|flv|wmv|mpg|mpeg|m2ts|mts|ts|3gp|3g2|ogv|ogm|vob|rm|rmvb|asf|divx|f4v|hevc|h264|aac|mp3|m4a|flac|wav|ogg)$/i;

/** Normalise a user-supplied product NAME (no directory) to `<stem>.<ext>`. */
export function normalizeOutputName(raw, ext) {
  let s = String(raw || '').trim().replace(MEDIA_EXT, '');
  // A leading dot is a legitimate (if unusual) part of a Unix filename and is
  // used by automation; safeStem strips it, so keep it explicitly.
  const dot = s.startsWith('.') ? '.' : '';
  return `${dot}${safeStem(s)}.${ext}`;
}

/**
 * Resolve any user-supplied output into an absolute final path.
 *  - empty            → default name beside the first clip
 *  - bare name        → that name in the first clip's folder
 *  - relative path    → resolved from the first clip's folder
 *  - absolute path    → honoured as-is (but suffix still normalised)
 *  - existing folder  → default name inside that folder
 */
export async function resolveOutput(raw, firstFile, ext, opts = {}) {
  if (!raw || !String(raw).trim()) return defaultOutput(firstFile, ext, opts);

  let s = String(raw).trim().replace(/;+$/, '');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname); }
    catch { s = s.replace(/^file:\/\/(localhost)?/, ''); }
  }
  if (s === '~') s = homedir();
  else if (s.startsWith('~/')) s = join(homedir(), s.slice(2));

  const srcDir = dirname(firstFile);
  const absolute = s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s);
  let dir = srcDir;
  let name = s;
  if (absolute) {
    dir = dirname(s);
    name = basename(s);
  } else if (s.includes('/') || s.includes('\\')) {
    dir = join(srcDir, dirname(s));
    name = basename(s);
  }

  // A trailing separator or an existing directory means "put it in here".
  if (/[\\/]$/.test(s) || (absolute && (await stat(s).catch(() => null))?.isDirectory())) {
    const inside = absolute ? s : join(srcDir, s);
    return join(inside, basename(await defaultOutput(firstFile, ext, opts)));
  }
  return join(dir, normalizeOutputName(name, ext));
}

// ffmpeg concat demuxer escaping: a literal ' inside a quoted path is written
// as '\'' — closing the quote, an escaped quote, then reopening it.
const listLine = (p) => `file '${p.replace(/'/g, "'\\''")}'`;

// ---------- ffmpeg stages ----------

function normArgs(clip, plan, work, idx, encExt) {
  const parts = ['-y', '-hide_banner', '-v', 'error', ...PROGRESS_ARGS, '-i', clip.file];
  const t = plan.target;
  const silent = !clip.audio && t.audio;
  if (silent) parts.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=${t.audio.channels > 1 ? 'stereo' : 'mono'}:r=${t.audio.sampleRate}`);

  parts.push('-map', '0:v:0');
  if (t.audio) parts.push('-map', silent ? '1:a:0' : '0:a:0');

  if (plan.copyVideo) {
    parts.push('-c:v', 'copy');
  } else {
    const vf = [];
    if (t.width && t.height) {
      vf.push(`scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease:flags=bicubic`);
      vf.push(`pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2:color=black`);
      vf.push('setsar=1');
    }
    if (t.fps) vf.push(`fps=${t.fps}`);
    vf.push('format=yuv420p');
    parts.push('-vf', vf.join(','));
    parts.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(plan.crf), '-profile:v', 'high');
  }

  if (t.audio) {
    parts.push('-c:a', 'aac', '-ar', String(t.audio.sampleRate), '-ac', String(t.audio.channels), '-b:a', String(t.audio.bitrate));
  } else {
    parts.push('-an');
  }
  if (silent) parts.push('-shortest');
  parts.push(join(work, `part ${idx}.${encExt}`));
  return parts;
}

async function concatCopy(work, files, outPath, expected, onProgress, signal) {
  const listPath = join(work, `list-${randomUUID().slice(0, 8)}.txt`);
  await writeFile(listPath, files.map(listLine).join('\n') + '\n');
  const r = await run(FFMPEG, [
    '-y', '-hide_banner', '-v', 'error', ...PROGRESS_ARGS,
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
    '-movflags', '+faststart', outPath,
  ], {
    signal,
    onStdout: makeProgressParser(expected, (p) => onProgress({ ...p, stage: '拼接（无损）' })),
  });
  return r;
}

async function remuxParts(clips, work, onLog, onProgress, signal) {
  const outs = [];
  for (let i = 0; i < clips.length; i++) {
    const dst = join(work, `seg ${i}.ts`);
    onProgress({ stage: `重封装 ${i + 1}/${clips.length}`, percent: (i / clips.length) * 70, clipIndex: i, clipName: clips[i].name });
    const r = await run(FFMPEG, [
      '-y', '-hide_banner', '-v', 'error', '-i', clips[i].file,
      '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
      '-f', 'mpegts', dst,
    ], { signal });
    if (r.code !== 0) return { ok: false, error: trim(r.stderr), at: i };
    outs.push(dst);
  }
  return { ok: true, outs };
}

// ---------- main entry ----------

export async function mergeClips(clips, plan, opts = {}) {
  const {
    output = null,
    index = 0,
    total = 1,
    onLog = () => {}, onProgress = () => {}, isAborted = () => false, signal,
  } = opts;
  const logs = [];
  const log = (m) => { logs.push(m); onLog(m); };
  const warnings = [...(plan.warnings || [])];
  const usable = clips.filter((c) => c.ok);
  // Active set can shrink mid-run: an external process (sync, manual cleanup,
  // an unmounted share) may remove a source after probing but before/during
  // encoding. Drop such clips instead of failing the whole group — the queue
  // will then keep every source of this task as a safety net.
  let active = usable.slice();
  const skippedMidRun = [];
  let expected = plan.expectedDuration || usable.reduce((n, c) => n + (c.duration || 0), 0);
  const refreshSources = async () => {
    if (!active.length) return;
    const still = [];
    for (const c of active) {
      const st = await stat(c.file).catch(() => null);
      if (st && st.isFile()) { still.push(c); continue; }
      skippedMidRun.push(c.name);
      expected = Math.max(0, expected - (c.duration || 0));
      warnings.push(`${c.name}：合并过程中源文件已消失，已跳过该片段（该组源文件将整组保留）`);
      log(`${c.name} 在合并过程中消失，已跳过`);
    }
    active = still;
  };
  const out = await resolveOutput(output, usable[0].file, plan.outExt, { index, total });

  if (usable.some((c) => samePath(out, c.file))) {
    return { ok: false, reasons: ['输出文件与某个输入片段是同一个文件，请换一个输出位置'], logs };
  }

  const work = await mkdtemp(join(tmpdir(), 'vmerge-'));
  const stageDir = dirname(out);
  // The output folder normally already exists (it is the source folder), but a
  // user-chosen path may point somewhere new.
  await mkdir(stageDir, { recursive: true }).catch(() => {});
  const partOut = join(stageDir, `.${basename(out)}.part-${randomUUID().slice(0, 6)}`);
  const created = [];

  let strategy = plan.strategy;
  let lastErr = '';
  const chain = strategy === 'copy' ? ['copy', 'remux', 'encode']
    : strategy === 'remux' ? ['remux', 'encode']
      : ['encode'];

  try {
    for (const step of chain) {
      if (isAborted()) throw abortError();
      await refreshSources();
      if (active.length < 2) {
        lastErr = '合并过程中源文件消失，剩余可合并片段不足 2 个';
        log(lastErr);
        continue;
      }
      for (const p of created.splice(0)) await rm(p, { force: true }).catch(() => {});
      const target = `${partOut}.${step === 'remux' ? 'ts' : plan.outExt}`;
      created.push(target);
      let r;

      if (step === 'copy') {
        log(`无损拼接 ${active.length} 个片段（容器与参数完全一致，不重新编码）`);
        r = await concatCopy(work, active.map((c) => c.file), target, expected, onProgress, signal);
        if (r.code !== 0) lastErr = `无损拼接失败：${trim(r.stderr)}`;
      } else if (step === 'remux') {
        log('片段容器/时基不同：先逐段重封装为 MPEG-TS，再无损拼接');
        const rm1 = await remuxParts(active, work, log, onProgress, signal);
        if (!rm1.ok) lastErr = `重封装第 ${rm1.at + 1} 个片段失败：${rm1.error}`;
        else r = await concatCopy(work, rm1.outs, target, expected, onProgress, signal);
        if (r && r.code !== 0) lastErr = `重封装后拼接失败：${trim(r.stderr)}`;
      } else {
        const encExt = plan.copyVideo ? plan.outExt : 'mp4';
        const parts = [];
        let failed = null;
        for (let i = 0; i < active.length; i++) {
          if (isAborted()) throw abortError();
          const c = active[i];
          const base = (i / active.length) * 85;
          onProgress({ stage: `标准化 ${i + 1}/${active.length}`, percent: base, clipIndex: i, clipName: c.name, outTime: 0 });
          const dst = join(work, `part ${i}.${encExt}`);
          const rr = await run(FFMPEG, normArgs(c, plan, work, i, encExt), {
            signal,
            onStdout: makeProgressParser(c.duration || 0, (p) => onProgress({
              ...p, stage: `标准化 ${i + 1}/${active.length}`, clipIndex: i, clipName: c.name,
              percent: Math.min(85, base + (p.percent || 0) * (85 / active.length)),
            })),
          });
          // A clip may vanish between refreshSources() and this exact open.
          // Re-check on failure so a mid-encode disappearance is a skip, not a
          // hard error that fails the whole group.
          if (rr.code !== 0 && !(await exists(c.file))) {
            skippedMidRun.push(c.name);
            expected = Math.max(0, expected - (c.duration || 0));
            warnings.push(`${c.name}：标准化时源文件已消失，已跳过该片段（该组源文件将整组保留）`);
            log(`${c.name} 在标准化时消失，已跳过`);
            continue;
          }
          if (rr.code !== 0) { failed = { at: i, error: trim(rr.stderr) }; break; }
          parts.push(dst);
        }
        if (failed) {
          lastErr = `标准化第 ${failed.at + 1} 个片段失败：${failed.error}`;
        } else if (parts.length < 2) {
          lastErr = '合并过程中源文件消失，剩余可合并片段不足 2 个';
          log(lastErr);
        } else {
          onProgress({ stage: '拼接（无损）', percent: 88 });
          r = await concatCopy(work, parts, target, expected, (p) => onProgress({
            ...p, percent: 88 + (p.percent || 0) * 0.12,
          }), signal);
          if (r.code !== 0) lastErr = `标准化后拼接失败：${trim(r.stderr)}`;
        }
      }

      if (!r || r.code !== 0) { log(`${step} 未成功，尝试下一种方式${lastErr ? '：' + lastErr : ''}`); continue; }

      // Validate before publishing: parseable, right ballpark duration, decodable.
      const pr = await ffprobe(target);
      if (!pr.ok) {
        lastErr = `产物无法解析：${trim(pr.error)}`;
        log(lastErr); await rm(target, { force: true }).catch(() => {}); continue;
      }
      const dur = Number(pr.raw.format?.duration || 0);
      const tol = Math.max(2, expected * 0.08);
      if (expected > 0 && Math.abs(dur - expected) > tol) {
        warnings.push(`时长校验偏差较大：预期约 ${expected.toFixed(1)}s，实际 ${dur.toFixed(1)}s（片段本身可能被截断或含可变帧率）`);
      }
      const dec = await decodeSample(target, { seconds: 8, duration: dur });
      if (!dec.ok) warnings.push('产物首尾抽样解码出现错误，建议播放确认关键位置');

      await rename(target, out);
      const sz = (await stat(out)).size;
      onProgress({ stage: '完成', percent: 100 });
      return {
        ok: true, output: out, size: sz, duration: dur, expected,
        strategy: step, level: warnings.length ? 'degraded' : 'clean',
        warnings, logs, skippedMidRun,
        clips: active.filter((c) => !skippedMidRun.includes(c.name))
          .map((c) => ({ name: c.name, duration: c.duration, action: clipAction(c, plan) })),
      };
    }

    return { ok: false, reasons: [lastErr || '合并失败'], warnings, logs, output: null, skippedMidRun };
  } catch (e) {
    if (e.aborted) return { ok: false, aborted: true, reasons: ['已停止，未生成文件'], warnings, logs, skippedMidRun };
    return { ok: false, reasons: [String(e)], warnings, logs, skippedMidRun };
  } finally {
    for (const p of created) await rm(p, { force: true }).catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
