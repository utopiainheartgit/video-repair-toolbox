import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdtemp, mkdir, rm, open } from 'node:fs/promises';
import { join, extname, basename, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isVideoFile, diagnose, cachedDiagnose, invalidateDiagnosis, FFMPEG, FFPROBE, run } from './lib/probe.mjs';
import { repairFile, repairInPlace, findUntrunc, cleanupWork } from './lib/repair.mjs';
import { probeClip, buildPlan, mergeClips, defaultOutput, resolveOutput, isMergeProduct } from './lib/merge.mjs';
import { verifyProduct, trashSources } from './lib/queue.mjs';
import {
  pickFolder, pickFiles, pickSave, reveal as revealFile, moveToTrash as trashFile,
  nativePickerAvailable,
} from './lib/platform.mjs';
import { appendJobLog, LOG_FILE } from './lib/joblog.mjs';

const PORT = Number(process.env.PORT || 8731);
const HOST = '127.0.0.1';
const PUBLIC = join(import.meta.dirname, 'public');
const STAGED = new Map();
// Only paths that actually failed repair may be trashed, so a buggy or hostile
// client cannot turn the delete endpoint into arbitrary rm. This used to be a
// plain array that was CLEARED at the start of every repair and lost on restart;
// a second repair (or a server restart) silently made earlier failed items
// undeletable. Keep it as a persistent, latest-action-wins registry instead.
const failedPaths = new Map(); // normalised absolute path -> { ts, count }
const MAX_FAILED_PATHS = 5000;

function noteFailed(p) {
  if (typeof p !== 'string' || !p) return;
  const key = normalizePath(p);
  if (!key) return;
  const prev = failedPaths.get(key);
  failedPaths.set(key, {
    ts: new Date().toISOString(),
    count: (Number(prev?.count) || 0) + 1,
  });
  while (failedPaths.size > MAX_FAILED_PATHS) {
    failedPaths.delete(failedPaths.keys().next().value);
  }
}

// Surfaced in scan results and diagnosis events: repeated failures are a strong
// signal that re-running the same strategy chain is pointless. The user should
// see this BEFORE spending another 10 minutes on the same file.
function priorFailureFor(p) {
  const key = normalizePath(p);
  const v = key ? failedPaths.get(key) : null;
  if (!v) return null;
  const count = Number(v.count) || 1;
  const at = String(v.ts || '');
  const when = at ? new Date(at) : null;
  const mins = when && !Number.isNaN(when.getTime())
    ? Math.max(0, Math.round((Date.now() - when.getTime()) / 60000)) : null;
  const ago = mins == null ? '' : mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前`
    : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
  return {
    count, at, ago,
    hint: `此前修复失败 ${count} 次${ago ? `（最近 ${ago}）` : ''}：建议换参考文件、换方案或重新下载，重复同样操作大概率仍失败`,
  };
}

// Rebuild the deletable set from the append-only job log on startup. The log
// records every repair outcome, so the latest action per path wins: a file that
// was later repaired successfully is NOT reopened for deletion after a restart.
async function loadFailedPaths() {
  try {
    const text = await readFile(LOG_FILE, 'utf8');
    const latest = new Map();
    const counts = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.mode !== 'repair' || typeof r.path !== 'string' || !r.path) continue;
      if (r.action !== 'failed' && r.action !== 'repaired') continue;
      const key = normalizePath(r.path);
      if (!key) continue;
      if (r.action === 'failed') counts.set(key, (counts.get(key) || 0) + 1);
      const prev = latest.get(key);
      if (!prev || String(r.ts || '') >= prev.ts) {
        latest.set(key, { ts: String(r.ts || ''), failed: r.action === 'failed' });
      }
    }
    for (const [key, v] of latest) {
      if (v.failed) failedPaths.set(key, { ts: v.ts, count: counts.get(key) || 1 });
    }
    while (failedPaths.size > MAX_FAILED_PATHS) {
      failedPaths.delete(failedPaths.keys().next().value);
    }
  } catch {
    // A missing/unreadable log just means an empty registry this session.
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // Accumulate raw bytes, then decode once. Concatenating per-chunk strings
    // corrupts multi-byte UTF-8 (Chinese paths) split across chunk boundaries,
    // and buf.length counts UTF-16 units rather than bytes.
    const chunks = [];
    let bytes = 0;
    req.on('data', (d) => {
      bytes += d.length;
      if (bytes > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Reject cross-origin / non-JSON state-changing requests. This is a localhost
// tool, but without these checks any web page could drive the delete endpoints
// via DNS rebinding + a text/plain POST (which skips CORS preflight).
function rejectCrossSite(req, res) {
  const host = String(req.headers.host || '');
  if (host && host !== `${HOST}:${PORT}` && host !== HOST) {
    json(res, 403, { error: '拒绝跨站请求' });
    return false;
  }
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) {
    json(res, 415, { error: '请使用 application/json' });
    return false;
  }
  return true;
}

function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  // A single large-file repair can be silent for minutes. Heartbeat comments
  // keep proxies and the browser from treating the idle stream as dead.
  const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
  const cleanup = () => clearInterval(hb);
  res.once('close', cleanup);
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  send.cleanup = cleanup;
  return send;
}

// Bounded-concurrency map over an array, preserving input order. Used to scan
// hundreds of paths without spawning an unbounded number of stat/readdir calls.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// Normalise one user-supplied path: trim, strip quotes/trailing ';', decode
// file:// URLs, expand ~, resolve to absolute. Returns '' for empty input.
function normalizePath(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().replace(/;+$/, '');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname); }
    catch { s = s.replace(/^file:\/\/(localhost)?/, ''); }
  }
  if (!s) return '';
  return resolve(s === '~' ? homedir() : s.startsWith('~/') ? join(homedir(), s.slice(2)) : s);
}

async function scanDir(root, { maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      // Products now sit beside their sources. Skip any generated product by
      // its strict `_merged[_tNN][-N].<ext>` name, plus the legacy `merged/`
      // folder from earlier versions — otherwise a re-scan could merge a
      // product back with the very fragments it was built from.
      if (e.isDirectory()) { if (e.name !== 'merged') stack.push(p); }
      else if (e.isFile() && isVideoFile(e.name) && !isMergeProduct(e.name)) {
        const s = await stat(p).catch(() => null);
        if (s) out.push({
          path: p, name: e.name, size: s.size,
          rel: p.slice(root.length).replace(/^\//, ''),
          priorFailure: priorFailureFor(p),
        });
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
  return out;
}

// Build candidate references for a BROKEN file. untrunc needs a healthy
// recording from the same device (matching codec/resolution/fingerprint). The
// best candidates are the healthy siblings in the broken file's OWN folder —
// most camera/user collections keep a whole batch together.
//
// The old version only ran when the user picked a reference manually and
// scanned that reference's folder, so a moov-missing file sitting next to 50
// healthy clips still got no reference. Repair-log analysis showed 14 moov
// failures, 13 of which had healthy files in the same directory.
async function referencePoolFor(brokenFile, explicitRef = null, max = 24) {
  const seen = new Set();
  const pool = [];
  const add = (p) => {
    const abs = resolve(p);
    if (!seen.has(abs)) { seen.add(abs); pool.push(abs); }
  };
  // An explicitly chosen reference is the strongest signal: match it first.
  if (explicitRef && await stat(explicitRef).then((s) => s.isFile(), () => false)) add(explicitRef);
  // The broken file itself can never be its own reference — exclude it from
  // the candidate scan below (but do not put it in the pool).
  const skip = new Set(pool);
  if (brokenFile) skip.add(resolve(brokenFile));
  try {
    const parent = join(resolve(brokenFile), '..');
    const entries = await readdir(parent, { withFileTypes: true });
    // Prefer files near the target alphabetically (camera sequences group
    // together), then cap the work: matchReference ffprobes each candidate.
    entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && isVideoFile(e.name))
      .map((e) => join(parent, e.name))
      .filter((p) => !skip.has(resolve(p)))
      .sort((a, b) => basename(a).localeCompare(basename(b), 'zh'))
      .slice(0, max)
      .forEach(add);
  } catch { /* unreadable folder just means no auto candidates */ }
  return pool.slice(0, max + 2);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  // Every state-changing endpoint consumes a JSON body and may touch local
  // files (including the trash). Require a same-origin JSON POST so a random
  // web page cannot drive them via DNS rebinding / simple text/plain requests.
  if (req.method === 'POST' && !rejectCrossSite(req, res)) return;

  if (p === '/api/capabilities' && req.method === 'GET') {
    const untrunc = await findUntrunc();
    const ver = await run(FFMPEG, ['-version'], { timeout: 15000 });
    return json(res, 200, {
      untrunc, ffmpeg: ver.stdout.split('\n')[0] || FFMPEG,
      ffprobe: FFPROBE, platform: process.platform,
      // Intake is unified on path mode: the server and browser run on the same
      // machine, so we resolve real paths and repair in place — never stream
      // whole file bytes through the browser.
      handleMode: false, pathMode: true,
      nativePicker: nativePickerAvailable(),
      logFile: LOG_FILE,
    });
  }

  if (p === '/api/pick-folder' && req.method === 'POST') {
    const r = await pickFolder();
    return json(res, 200, r);
  }

  if (p === '/api/pick-file' && req.method === 'POST') {
    const { multiple = true } = await readBody(req);
    const r = await pickFiles(!!multiple);
    if (r.ok && multiple) r.paths = r.paths.filter((f) => isVideoFile(f));
    return json(res, 200, r);
  }

  // Shared implementation for single and batch scan. Returns a result object
  // instead of writing the response, so the batch endpoint can dedupe/aggregate.
  async function scanOne(root) {
    const abs = normalizePath(root);
    if (!abs) return { ok: false, error: '路径为空' };
    const s = await stat(abs).catch(() => null);
    if (!s) return { ok: false, error: `路径不存在：${abs}` };
    if (s.isFile()) {
      if (!isVideoFile(abs)) return { ok: false, error: '不是支持的视频文件' };
      return { ok: true, root: abs, kind: 'file', files: [{
        path: abs, name: basename(abs), size: s.size, rel: basename(abs), priorFailure: priorFailureFor(abs),
      }] };
    }
    if (!s.isDirectory()) return { ok: false, error: `不是文件或文件夹：${abs}` };
    return { ok: true, root: abs, kind: 'dir', files: await scanDir(abs) };
  }

  if (p === '/api/scan' && req.method === 'POST') {
    const { path: root } = await readBody(req);
    if (!root || typeof root !== 'string') return json(res, 400, { error: '缺少 path' });
    const r = await scanOne(root);
    if (!r.ok) return json(res, 404, r);
    return json(res, 200, r);
  }

  // Batch scan: one request for hundreds of pasted paths. Deduplicates by the
  // normalised absolute path on the server, scans with bounded concurrency,
  // and returns a per-input result list plus a single deduplicated file list.
  if (p === '/api/scan-many' && req.method === 'POST') {
    const { paths = [] } = await readBody(req, 32 * 1024 * 1024);
    if (!Array.isArray(paths)) return json(res, 400, { error: 'paths 必须是数组' });
    const seenAbs = new Set();
    const inputs = [];
    const results = new Array(paths.length);
    for (let i = 0; i < paths.length; i++) {
      const raw = paths[i];
      const abs = normalizePath(raw);
      if (!abs) { results[i] = { input: raw, ok: false, error: '路径为空或无效', invalid: true }; continue; }
      if (seenAbs.has(abs)) { results[i] = { input: raw, ok: false, error: '重复路径，已跳过', dup: true }; continue; }
      seenAbs.add(abs);
      inputs.push({ index: i, raw, abs });
    }
    await mapLimit(inputs, 8, async ({ index, raw, abs }) => {
      const r = await scanOne(abs);
      const files = r.files || [];
      results[index] = {
        input: raw, ok: r.ok, kind: r.kind || null, error: r.error || null,
        count: files.length, files,
      };
    });
    // Cross-result dedupe in input order: a file pasted both as part of a folder
    // and as its own path should be reported/registered only once.
    const seenFile = new Set();
    let fileDuplicates = 0;
    for (const r of results) {
      if (!r?.ok || !r.files) continue;
      const kept = [];
      for (const f of r.files) {
        if (seenFile.has(f.path)) { fileDuplicates++; continue; }
        seenFile.add(f.path);
        kept.push(f);
      }
      r.files = kept;
      r.added = kept.length;
    }
    const pathDuplicates = results.reduce((n, r) => n + (r?.dup ? 1 : 0), 0);
    return json(res, 200, {
      results, duplicates: pathDuplicates, fileDuplicates,
      invalid: results.reduce((n, r) => n + (r?.invalid ? 1 : 0), 0),
    });
  }

  if (p === '/api/jobs' && req.method === 'POST') {
    const body = await readBody(req);
    const { mode = 'diagnose', files = [], deep = false, allowReencode = true, reference = null, resumeFrom = 0 } = body;
    if (!Array.isArray(files) || !files.length) return json(res, 400, { error: '没有待处理文件' });
    if (!['diagnose', 'repair'].includes(mode)) return json(res, 400, { error: 'mode 非法' });

    const send = sseStart(res);
    // req.destroyed flips true once the POST body is consumed, so it cannot
    // signal client cancellation here — watch the response socket instead.
    let aborted = false;
    const ctrl = new AbortController();
    res.on('close', () => { aborted = true; ctrl.abort(); });
    const refOk = reference && await stat(reference).catch(() => null);
    const base = Math.max(0, Math.floor(Number(resumeFrom) || 0));
    send('start', { total: base + files.length, mode, deep, untrunc: await findUntrunc(), reference: refOk ? reference : null });

    let done = base, repaired = 0, skipped = 0, failed = 0;
    const job = randomUUID();
    for (const f of files) {
      if (aborted || res.writableEnded) break;
      const path = typeof f === 'string' ? f : f?.path;
      // A malformed entry must not abort the whole SSE stream without a
      // file-done/done event (the client would treat it as a dropped connection).
      if (typeof path !== 'string' || !path) {
        failed++;
        send('file-done', { index: done, path: String(path ?? ''), name: '无效路径', verdict: 'error', action: 'failed', reasons: ['无效的文件路径'] });
        continue;
      }
      const name = basename(path);
      const prior = priorFailureFor(path);
      send('file-start', { index: done, path, name });
      const msgs = [];
      const log = (m) => { msgs.push(m); send('log', { index: done, path, message: m }); };
      const prog = (p) => send('file-progress', { index: done, path, ...p });
      // Every file-done carries the history so the UI can keep the hint even
      // after the result badge changes.
      const doneEvent = (payload) => send('file-done', {
        index: done, path, name, priorFailure: prior, ...payload,
      });
      let diag = null, action = null, strategy = null, tried = null, reasons = null, attempts = [], level = null;

      try {
        if (prior && mode === 'repair') log(`历史提示：${prior.hint}`);
        prog({ stage: '探测容器与结构', percent: null });
        diag = await cachedDiagnose(path, { deep, onProgress: prog, signal: ctrl.signal });
        if (diag.cached) log(`命中诊断缓存（${Math.round((diag.cacheAgeMs || 0) / 1000)} 秒内未变化），跳过重复探测`);
        send('diagnosis', { index: done, path, name, priorFailure: prior, diagnosis: diag });

        if (mode === 'diagnose') {
          if (diag.verdict === 'healthy') skipped++;
          action = 'diagnosed';
          doneEvent({ verdict: diag.verdict, action: 'diagnosed' });
        } else if (diag.verdict === 'healthy') {
          skipped++;
          log('文件健康，跳过');
          action = 'skipped';
          doneEvent({ verdict: 'healthy', action: 'skipped' });
        } else if (diag.verdict === 'unreadable') {
          failed++; noteFailed(path);
          action = 'failed'; reasons = ['文件不可读'];
          doneEvent({ verdict: 'unreadable', action: 'failed', reasons: ['文件不可读'] });
        } else {
          const needsRef = diag.problems.some((x) => ['MOOV_MISSING', 'MOOV_INVALID', 'CORRUPT_DATA'].includes(x.code));
          // Always offer same-folder candidates, even without a manual pick:
          // matchReference() fingerprints each one and selects the best match.
          const pool = needsRef ? await referencePoolFor(path, refOk ? reference : null) : [];
          if (needsRef && !refOk && pool.length > 0) {
            // One sibling is still a usable candidate — matchReference() checks
            // its fingerprint. The old `> 1` guard claimed "no reference" while
            // silently using that one file, which made logs misleading.
            log(`自动参考：未手动选择参考文件，已从同目录找到 ${pool.length} 个候选，按指纹自动匹配`);
          } else if (needsRef && !refOk) {
            log('检测到索引/码流损坏：同目录没有其他可用视频作参考，将尝试裸流恢复');
          }
          const r = await repairInPlace(path, {
            reference: refOk ? reference : null,
            referencePool: pool,
            allowReencode, diagnosis: diag,
            onLog: log, onProgress: prog, isAborted: () => aborted, signal: ctrl.signal,
          });
          tried = r.tried;
          attempts = r.attempts || [];
          level = r.level || null;
          if (r.ok && r.replaced) {
            repaired++;
            // Successfully repaired: no longer a deletion candidate, and the
            // old diagnosis no longer describes the file on disk.
            failedPaths.delete(normalizePath(path));
            invalidateDiagnosis(path);
            prog({ stage: '已覆盖原文件', percent: 100 });
            log(`已覆盖原文件，策略：${r.strategy}${r.level === 'degraded' ? '（降级修复：可播放但可能有残留错误，建议另存备份）' : ''}`);
            action = 'repaired'; strategy = r.strategy;
            const publicAttempts = (r.attempts || []).map(({ strategy: s, ok, level: lv, ms, reasons: rs }) => ({ strategy: s, ok, level: lv, ms, reasons: rs }));
            doneEvent({ verdict: 'repaired', action: 'repaired', strategy: r.strategy, tried: r.tried, attempts: publicAttempts, info: r.info, level: r.level || 'clean' });
          } else {
            failed++; noteFailed(path);
            log(`修复失败，原文件未改动：${(r.reasons || []).join('；')}`);
            action = 'failed'; reasons = r.reasons;
            const publicAttempts = (r.attempts || []).map(({ strategy: s, ok, level: lv, ms, reasons: rs }) => ({ strategy: s, ok, level: lv, ms, reasons: rs }));
            doneEvent({ verdict: diag.verdict, action: 'failed', tried: r.tried, attempts: publicAttempts, reasons: r.reasons });
          }
        }
      } catch (e) {
        failed++; noteFailed(path);
        action = 'failed'; reasons = [String(e)];
        doneEvent({ verdict: 'error', action: 'failed', reasons: [String(e)] });
      }
      const st = await stat(path).catch(() => null);
      await appendJobLog({
        ts: new Date().toISOString(), job, mode, deep,
        reference: refOk ? reference : null,
        path, name, size: st ? st.size : null,
        priorFailure: prior || undefined,
        verdict: diag ? diag.verdict : 'error',
        problems: diag ? diag.problems : [],
        action, strategy, tried, reasons, level: level || (action === 'repaired' ? 'clean' : null),
        attempts: (attempts || []).map((a) => ({
          strategy: a.strategy, ok: a.ok, level: a.level,
          ms: a.ms, reasons: a.reasons,
        })),
        messages: msgs,
      });
      done++;
      send('progress', { done, total: base + files.length, repaired, skipped, failed });
    }
    send('done', { done, total: base + files.length, repaired, skipped, failed });
    send.cleanup();
    return res.end();
  }

  // ---------- merge (合并视频) ----------

  if (p === '/api/pick-save' && req.method === 'POST') {
    const { defaultName = 'merged.mp4' } = await readBody(req);
    return json(res, 200, await pickSave(basename(String(defaultName)) || 'merged.mp4'));
  }

  if (p === '/api/reveal' && req.method === 'POST') {
    const { path: target } = await readBody(req);
    const abs = normalizePath(target);
    const st = abs ? await stat(abs).catch(() => null) : null;
    if (!st) return json(res, 404, { error: '文件不存在或无权限' });
    return json(res, 200, { ok: await revealFile(abs) });
  }

  // Probe every clip and decide the cheapest safe strategy up front, so the UI
  // can show 无损 / 重封装 / 重编码 per clip before the user commits to a long
  // encode. Re-probing here also keeps /api/merge stateless.
  if (p === '/api/merge-plan' && req.method === 'POST') {
    const {
      files = [], mode = 'auto', size = 'first', quality = 'balanced', index = 0, total = 1,
    } = await readBody(req, 32 * 1024 * 1024);
    if (!Array.isArray(files) || !files.length) return json(res, 400, { error: '没有片段' });
    const clips = await mapLimit(files, 6, (f) => probeClip(typeof f === 'string' ? f : f.path));
    const plan = buildPlan(clips, { mode, size, quality });
    let suggestedOutput = null;
    const firstOk = clips.find((c) => c.ok);
    if (plan.ok && firstOk) {
      suggestedOutput = await defaultOutput(firstOk.file, plan.outExt, { index, total });
    }
    return json(res, 200, { clips, plan, suggestedOutput });
  }

  if (p === '/api/merge' && req.method === 'POST') {
    const body = await readBody(req, 32 * 1024 * 1024);
    const { files = [], mode = 'auto', size = 'first', quality = 'balanced', output = null } = body;
    if (!Array.isArray(files) || files.length < 2) return json(res, 400, { error: '至少需要 2 个片段' });

    const send = sseStart(res);
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    const job = randomUUID();
    const logs = [];
    const log = (m) => { logs.push(m); if (!res.writableEnded) send('log', { message: m }); };

    try {
      send('stage', { stage: '分析片段…', percent: null });
      const clips = await mapLimit(files, 6, (f) => probeClip(typeof f === 'string' ? f : f.path));
      send('clips', { clips });
      const plan = buildPlan(clips, { mode, size, quality });
      if (!plan.ok) {
        send('merge-done', { ok: false, reasons: plan.reasons, warnings: plan.warnings || [], logs });
        send.cleanup();
        return res.end();
      }
      send('plan', { plan, output: output || null });

      const r = await mergeClips(clips, plan, {
        output, signal: ctrl.signal, onLog: log,
        onProgress: (pr) => { if (!res.writableEnded) send('merge-progress', pr); },
        isAborted: () => ctrl.signal.aborted,
      });

      await appendJobLog({
        ts: new Date().toISOString(), job, mode: 'merge',
        output: r.output || null, strategy: r.strategy || null,
        clips: clips.map((c) => ({ name: c.name, path: c.file, ok: c.ok, duration: c.duration, error: c.error })),
        ok: !!r.ok, level: r.level || null,
        duration: r.duration || null, expected: r.expected || null,
        size: r.size || null, warnings: r.warnings || [], reasons: r.reasons || [],
        messages: logs,
      });

      if (!res.writableEnded) send('merge-done', r);
      send.cleanup();
      return res.end();
    } catch (e) {
      if (!res.writableEnded) send('merge-done', { ok: false, reasons: [String(e)], logs });
      send.cleanup();
      return res.end();
    }
  }

  // Batch queue: run several independent merges back to back. Each task is
  // verified on its own; sources are only moved to the trash when the product
  // is clean, parseable and the right length. A failed task never blocks the
  // rest of the queue.
  if (p === '/api/merge-queue' && req.method === 'POST') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const {
      tasks = [], mode = 'auto', size = 'first', quality = 'balanced', deleteSources = false,
    } = body;
    if (!Array.isArray(tasks) || !tasks.length) return json(res, 400, { error: '队列为空' });
    if (tasks.length > 500) return json(res, 400, { error: '单次队列最多 500 个任务' });
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t || !Array.isArray(t.files) || t.files.length < 2) {
        return json(res, 400, { error: `任务 ${i + 1} 至少需要 2 个片段` });
      }
    }

    const send = sseStart(res);
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    const job = randomUUID();
    const doDelete = !!deleteSources;

    const summary = {
      total: tasks.length, succeeded: 0, partial: 0, failed: 0,
      deletedCount: 0, keptCount: 0, trashErrorCount: 0, notRun: 0, deleteSources: doDelete, tasks: [],
    };

    send('queue-start', { total: tasks.length, deleteSources: doDelete });

    for (let i = 0; i < tasks.length; i++) {
      if (ctrl.signal.aborted) { summary.notRun = tasks.length - i; break; }
      const t = tasks[i];
      const names = t.files.map((f) => basename(String(f)));
      send('task-start', { index: i, total: tasks.length, names, deleteSources: doDelete });

      const logs = [];
      const log = (m) => { logs.push(m); if (!res.writableEnded) send('log', { index: i, message: m }); };
      let result = null;
      let clips = [];
      let plan = null;

      try {
        clips = await mapLimit(t.files, 6, (f) => probeClip(String(f)));
        send('clips', { index: i, clips });
        const usable = clips.filter((c) => c.ok);
        plan = buildPlan(clips, { mode, size, quality });

        if (!plan.ok || usable.length < 2) {
          result = {
            ok: false,
            reasons: plan.reasons?.length ? plan.reasons : ['可解析的片段不足 2 个'],
            warnings: plan.warnings || [],
            logs,
          };
        } else {
          send('task-plan', { index: i, plan });
          result = await mergeClips(clips, plan, {
            output: t.output || null,
            index: i,
            total: tasks.length,
            signal: ctrl.signal,
            onLog: log,
            onProgress: (pr) => { if (!res.writableEnded) send('task-progress', { index: i, ...pr }); },
            isAborted: () => ctrl.signal.aborted,
          });
        }
      } catch (e) {
        result = { ok: false, reasons: [String(e)], warnings: [], logs };
      }

      // ---- verification and the only place sources may be destroyed ----
      const usable = clips.filter((c) => c.ok);
      const skipped = clips.length - usable.length;
      let verify = null;
      let deleted = [];
      let kept = [];
      let trashErrors = [];

      if (!doDelete) {
        verify = { ok: false, reason: '未开启删除' };
      } else if (!result?.ok) {
        verify = { ok: false, reason: (result?.reasons || [])[0] || '合并失败' };
        kept = t.files.slice();
      } else if (result.aborted) {
        verify = { ok: false, reason: '已停止' };
        kept = t.files.slice();
      } else if (skipped > 0 || (result.skippedMidRun || []).length > 0) {
        // Some source never made it into the product (unparseable at probe time
        // or vanished mid-run), so deleting the rest would silently lose
        // footage. Keep the whole task.
        const gone = (result.skippedMidRun || []).length;
        const parts = [];
        if (skipped > 0) parts.push(`${skipped} 个片段无法解析`);
        if (gone > 0) parts.push(`${gone} 个片段在合并中消失`);
        verify = { ok: false, reason: `有 ${parts.join('、')}、未参与合并，整组保留源文件` };
        kept = t.files.slice();
      } else {
        verify = await verifyProduct(result, usable);
        if (verify.ok) {
          const r = await trashSources(usable.map((c) => c.file), {
            trash: trashFile,
            output: result.output,
            allowed: t.files,
          });
          deleted = r.deleted;
          kept = r.failed.map((x) => x.file);
          // Surface the actual reason (e.g. EXDEV on an external volume)
          // instead of a bare "kept" list in the result card and job log.
          trashErrors = r.failed.map((x) => ({ file: x.file, reason: x.reason }));
          for (const e of trashErrors) log(`移入废纸篓失败：${e.file} — ${e.reason}`);
        } else {
          kept = usable.map((c) => c.file);
        }
      }

      const rec = {
        index: i,
        ok: !!result?.ok,
        verified: !!verify?.ok,
        verifiedReason: verify?.ok ? null : verify?.reason,
        output: result?.output || null,
        duration: result?.duration || null,
        expected: result?.expected || null,
        size: result?.size || null,
        strategy: result?.strategy || null,
        level: result?.level || null,
        deleted,
        kept,
        trashErrors,
        reasons: result?.reasons || [],
        warnings: result?.warnings || [],
        skipped,
        skippedMidRun: result?.skippedMidRun || [],
        aborted: !!result?.aborted,
      };

      if (rec.ok && (!doDelete || verify.ok)) summary.succeeded++;
      else if (rec.ok) summary.partial++;
      else summary.failed++;
      summary.deletedCount += deleted.length;
      summary.trashErrorCount += trashErrors.length;
      summary.keptCount += kept.length;
      summary.tasks.push(rec);

      await appendJobLog({
        ts: new Date().toISOString(), job, mode: 'merge-queue', task: i + 1,
        output: rec.output, strategy: rec.strategy, ok: rec.ok, level: rec.level,
        duration: rec.duration, expected: rec.expected, size: rec.size,
        clips: clips.map((c) => ({ name: c.name, path: c.file, ok: c.ok, duration: c.duration, error: c.error })),
        deleted, kept, trashErrors, verified: rec.verified, verifiedReason: rec.verifiedReason,
        warnings: rec.warnings, reasons: rec.reasons, messages: logs,
      }).catch(() => {});

      if (!res.writableEnded) send('task-done', rec);
    }

    if (!res.writableEnded) send('queue-done', summary);
    send.cleanup();
    return res.end();
  }

  // Handle mode: browser streams bytes in, we repair, browser streams bytes back
  // and commits via FileSystemWritableFileStream (swap-on-close).
  if (p === '/api/stage' && req.method === 'POST') {
    const name = url.searchParams.get('name') || 'video.mp4';
    const id = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'vstage-'));
    const safe = basename(name).replace(/[^\w.\- ()\[\]\u4e00-\u9fff]/g, '_');
    const dest = join(dir, safe);
    const fh = await open(dest, 'w');
    let size = 0;
    try {
      for await (const chunk of req) { size += chunk.length; await fh.write(chunk); }
    } finally { await fh.close(); }
    STAGED.set(id, { dir, path: dest, name: safe, size, created: Date.now() });
    return json(res, 200, { id, size, name: safe });
  }

  if (p === '/api/repair-staged' && req.method === 'POST') {
    const { id, deep = false, allowReencode = true, mode = 'repair', stream = false } = await readBody(req);
    const ent = STAGED.get(id);
    if (!ent) return json(res, 404, { error: '暂存文件不存在或已过期' });

    const emit = stream ? sseStart(res) : null;
    const logs = [];
    const log = (m) => { logs.push(m); emit?.('log', { message: m }); };
    const prog = (p) => emit?.('file-progress', p);
    const job = randomUUID();

    prog({ stage: '探测容器与结构', percent: null });
    const diag = await diagnose(ent.path, { deep, onProgress: prog });
    emit?.('diagnosis', { diagnosis: diag });

    const finish = async (payload) => {
      await appendJobLog({
        ts: new Date().toISOString(), job, mode, deep, reference: null,
        path: ent.path, name: ent.name, size: ent.size,
        verdict: diag.verdict, problems: diag.problems,
        action: payload.action || 'diagnosed',
        strategy: payload.strategy || null, tried: payload.tried || null,
        reasons: payload.reasons || null, level: payload.level || null,
        attempts: (payload.attempts || []).map((a) => ({
          strategy: a.strategy, ok: a.ok, level: a.level, ms: a.ms, reasons: a.reasons,
        })),
        messages: logs,
      });
      if (emit) { emit('result', payload); return res.end(); }
      return json(res, 200, payload);
    };

    if (mode === 'diagnose') return finish({ diagnosis: diag, logs });
    if (diag.verdict === 'healthy') return finish({ action: 'skipped', diagnosis: diag, logs });

    const r = await repairFile(ent.path, { allowReencode, diagnosis: diag, onLog: log, onProgress: prog });
    if (!r.ok) {
      await cleanupWork(r.work);
      return finish({ action: 'failed', diagnosis: diag, reasons: r.reasons, tried: r.tried, attempts: r.attempts, logs });
    }

    if (r.level === 'degraded') log(`降级修复：可播放但可能有残留错误（${r.strategy}），建议另存备份`);
    const outId = randomUUID();
    STAGED.set(outId, { dir: r.work, path: r.output, name: ent.name, size: (await stat(r.output)).size, created: Date.now(), isResult: true });
    return finish({ action: 'repaired', resultId: outId, strategy: r.strategy, tried: r.tried, attempts: r.attempts, level: r.level, diagnosis: diag, info: r.info, logs });
  }

  if (p.startsWith('/api/fetch/') && req.method === 'GET') {
    const ent = STAGED.get(p.slice('/api/fetch/'.length));
    if (!ent) return json(res, 404, { error: '不存在' });
    const s = await stat(ent.path);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-store' });
    const fh = await open(ent.path, 'r');
    try {
      for await (const chunk of fh.createReadStream()) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
    } finally { await fh.close(); res.end(); }
    return;
  }

  if (p.startsWith('/api/staged/') && req.method === 'DELETE') {
    const ent = STAGED.get(p.slice('/api/staged/'.length));
    if (ent) { await rm(ent.dir, { recursive: true, force: true }); STAGED.delete(p.slice('/api/staged/'.length)); }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/trash-failed' && req.method === 'POST') {
    const { paths = [] } = await readBody(req);
    const trashed = [], errors = [];
    const seen = new Set();
    for (const raw of (Array.isArray(paths) ? paths : [])) {
      if (typeof raw !== 'string' || !raw.trim()) {
        errors.push({ path: String(raw ?? ''), reason: '无效路径' });
        continue;
      }
      // Match the registry by normalised absolute path, but always move the
      // ORIGINAL path string the client gave us (it is already absolute from
      // scan; normalisation here is only for lookup safety).
      const key = normalizePath(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!failedPaths.has(key)) {
        // Never silently skip: tell the user exactly why nothing happened.
        errors.push({
          path: raw,
          reason: '该失败项已失效（服务重启或已重新诊断），请重新诊断失败文件后再删除',
          stale: true,
        });
        continue;
      }
      const r = await trashFile(raw);
      if (r?.ok !== false) {
        trashed.push(raw);
        failedPaths.delete(key);
      } else {
        errors.push({ path: raw, reason: r?.reason || '移入废纸篓失败' });
      }
    }
    const record = {
      ts: new Date().toISOString(), job: randomUUID(), mode: 'trash-failed',
      requested: (Array.isArray(paths) ? paths : []).length,
      trashed, errors,
    };
    await appendJobLog(record);
    return json(res, 200, { trashed, errors });
  }

  return json(res, 404, { error: '未知接口' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = resolve(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep) && file !== join(PUBLIC, 'index.html')) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

setInterval(async () => {
  const cutoff = Date.now() - 3 * 3600_000;
  for (const [id, e] of STAGED) {
    if (e.created < cutoff) { await rm(e.dir, { recursive: true, force: true }).catch(() => {}); STAGED.delete(id); }
  }
}, 600_000).unref();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e) });
    else res.end();
  }
});

// Restore the deletable-failed set BEFORE accepting requests, so a failed item
// from an earlier run (or before a restart) remains actionable.
await loadFailedPaths();

server.listen(PORT, HOST, () => {
  console.log(`视频修复工具已启动： http://${HOST}:${PORT}`);
  console.log(`运行日志： ${LOG_FILE}`);
  console.log(`可删除的失败记录： ${failedPaths.size} 条`);
  console.log('按 Ctrl+C 停止。');
});