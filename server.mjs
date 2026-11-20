import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdtemp, mkdir, rm, open } from 'node:fs/promises';
import { join, extname, basename, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isVideoFile, diagnose, FFMPEG, FFPROBE, run } from './lib/probe.mjs';
import { repairFile, repairInPlace, findUntrunc, cleanupWork } from './lib/repair.mjs';
import { probeClip, buildPlan, mergeClips, defaultOutput, OUTPUT_DIR } from './lib/merge.mjs';
import { verifyProduct, trashSources } from './lib/queue.mjs';
import { moveToTrash as trashFile } from './lib/trash.mjs';
import { appendJobLog, LOG_FILE } from './lib/joblog.mjs';

const PORT = Number(process.env.PORT || 8731);
const HOST = '127.0.0.1';
const PUBLIC = join(import.meta.dirname, 'public');
const STAGED = new Map();
// Only paths the latest repair job actually failed on may be trashed, so a
// buggy or hostile client cannot turn the delete endpoint into arbitrary rm.
let lastFailedPaths = [];

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
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > limit) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
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
      // Products live in `<source>/merged/`. Scanning them back in would let a
      // re-scan merge a product with the very fragments it was built from.
      if (e.isDirectory()) { if (e.name !== OUTPUT_DIR) stack.push(p); }
      else if (e.isFile() && isVideoFile(e.name)) {
        const s = await stat(p).catch(() => null);
        if (s) out.push({ path: p, name: e.name, size: s.size, rel: p.slice(root.length).replace(/^\//, '') });
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
  return out;
}

// Build a pool of candidate reference files from the reference's own folder.
// untrunc needs a healthy recording with matching codec/resolution; scanning
// the sibling videos gives repairFile something to auto-match against.
async function healthySiblings(reference, max = 24) {
  if (!reference) return [];
  try {
    const dir = resolve(reference);
    const parent = join(dir, '..');
    const entries = await readdir(parent, { withFileTypes: true });
    const pool = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && isVideoFile(e.name))
      .map((e) => join(parent, e.name))
      .filter((p) => p !== resolve(reference))
      .slice(0, max);
    return [resolve(reference), ...pool];
  } catch { return []; }
}

// Native macOS folder picker — the only way to get a real writable path in
// browsers without the File System Access API (Safari, Firefox).
function pickFolderNative() {
  return new Promise((resolve) => {
    const script = 'POSIX path of (choose folder with prompt "选择要扫描的视频文件夹")';
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ ok: false, error: '无法调用 osascript' }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, cancelled: /User canceled/i.test(err), error: err.trim() });
      resolve({ ok: true, path: out.trim() });
    });
  });
}

function pickFilesNative(multiple) {
  return new Promise((resolve) => {
    const script = multiple
      ? 'set fs to choose file with prompt "选择视频文件（可多选）" with multiple selections allowed\nset o to ""\nrepeat with f in fs\nset o to o & POSIX path of f & linefeed\nend repeat\nreturn o'
      : 'POSIX path of (choose file with prompt "选择一个参考视频（同设备录制的完好文件）")';
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ ok: false, error: '无法调用 osascript' }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, cancelled: /User canceled/i.test(err), error: err.trim() });
      const paths = out.split('\n').map((s) => s.trim()).filter(Boolean);
      resolve({ ok: true, paths });
    });
  });
}

// Native macOS save panel, so the merged file can be placed anywhere without
// the browser ever handling bytes.
function pickSaveNative(defaultName) {
  return new Promise((resolve) => {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `POSIX path of (choose file name with prompt "保存合并后的视频" default name "${esc(defaultName)}")`;
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ ok: false, error: '无法调用 osascript' }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, cancelled: /User canceled/i.test(err), error: err.trim() });
      resolve({ ok: true, path: out.trim() });
    });
  });
}

function revealInFinder(file) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const esc = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) => {
    const c = spawn('osascript', ['-e', `tell application "Finder"
activate
reveal POSIX file "${esc}"
end tell`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { c.kill('SIGKILL'); resolve(false); }, 15_000);
    c.on('error', () => { clearTimeout(t); resolve(false); });
    c.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;

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
      nativePicker: process.platform === 'darwin',
      logFile: LOG_FILE,
    });
  }

  if (p === '/api/pick-folder' && req.method === 'POST') {
    const r = await pickFolderNative();
    return json(res, 200, r);
  }

  if (p === '/api/pick-file' && req.method === 'POST') {
    const { multiple = true } = await readBody(req);
    const r = await pickFilesNative(!!multiple);
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
      return { ok: true, root: abs, kind: 'file', files: [{ path: abs, name: basename(abs), size: s.size, rel: basename(abs) }] };
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
    res.on('close', () => { aborted = true; });
    const refOk = reference && await stat(reference).catch(() => null);
    const base = Math.max(0, Math.floor(Number(resumeFrom) || 0));
    send('start', { total: base + files.length, mode, deep, untrunc: await findUntrunc(), reference: refOk ? reference : null });

    let done = base, repaired = 0, skipped = 0, failed = 0;
    if (mode === 'repair') lastFailedPaths = [];
    const noteFailed = (pp) => { if (mode === 'repair') lastFailedPaths.push(pp); };
    const job = randomUUID();
    for (const f of files) {
      if (aborted || res.writableEnded) break;
      const path = typeof f === 'string' ? f : f.path;
      const name = basename(path);
      send('file-start', { index: done, path, name });
      const msgs = [];
      const log = (m) => { msgs.push(m); send('log', { index: done, path, message: m }); };
      const prog = (p) => send('file-progress', { index: done, path, ...p });
      let diag = null, action = null, strategy = null, tried = null, reasons = null, attempts = [], level = null;

      try {
        prog({ stage: '探测容器与结构', percent: null });
        diag = await diagnose(path, { deep, onProgress: prog });
        send('diagnosis', { index: done, path, name, diagnosis: diag });

        if (mode === 'diagnose') {
          if (diag.verdict === 'healthy') skipped++;
          action = 'diagnosed';
          send('file-done', { index: done, path, name, verdict: diag.verdict, action: 'diagnosed' });
        } else if (diag.verdict === 'healthy') {
          skipped++;
          log('文件健康，跳过');
          action = 'skipped';
          send('file-done', { index: done, path, name, verdict: 'healthy', action: 'skipped' });
        } else if (diag.verdict === 'unreadable') {
          failed++; noteFailed(path);
          action = 'failed'; reasons = ['文件不可读'];
          send('file-done', { index: done, path, name, verdict: 'unreadable', action: 'failed', reasons: ['文件不可读'] });
        } else {
          const needsRef = diag.problems.some((x) => x.code === 'MOOV_MISSING');
          if (needsRef && !refOk) log('检测到 moov 缺失：未提供参考文件。将尝试裸流恢复；若同目录有其他健康视频可作参考，请设置参考文件后重试（成功率显著提升）');
          const r = await repairInPlace(path, {
            reference: refOk ? reference : null,
            referencePool: refOk ? await healthySiblings(reference) : [],
            allowReencode, diagnosis: diag,
            onLog: log, onProgress: prog, isAborted: () => aborted,
          });
          tried = r.tried;
          attempts = r.attempts || [];
          level = r.level || null;
          if (r.ok && r.replaced) {
            repaired++;
            prog({ stage: '已覆盖原文件', percent: 100 });
            log(`已覆盖原文件，策略：${r.strategy}${r.level === 'degraded' ? '（降级修复：可播放但可能有残留错误，建议另存备份）' : ''}`);
            action = 'repaired'; strategy = r.strategy;
            const publicAttempts = (r.attempts || []).map(({ strategy: s, ok, level: lv, ms, reasons: rs }) => ({ strategy: s, ok, level: lv, ms, reasons: rs }));
            send('file-done', { index: done, path, name, verdict: 'repaired', action: 'repaired', strategy: r.strategy, tried: r.tried, attempts: publicAttempts, info: r.info, level: r.level || 'clean' });
          } else {
            failed++; noteFailed(path);
            log(`修复失败，原文件未改动：${(r.reasons || []).join('；')}`);
            action = 'failed'; reasons = r.reasons;
            const publicAttempts = (r.attempts || []).map(({ strategy: s, ok, level: lv, ms, reasons: rs }) => ({ strategy: s, ok, level: lv, ms, reasons: rs }));
            send('file-done', { index: done, path, name, verdict: diag.verdict, action: 'failed', tried: r.tried, attempts: publicAttempts, reasons: r.reasons });
          }
        }
      } catch (e) {
        failed++; noteFailed(path);
        action = 'failed'; reasons = [String(e)];
        send('file-done', { index: done, path, name, verdict: 'error', action: 'failed', reasons: [String(e)] });
      }
      const st = await stat(path).catch(() => null);
      await appendJobLog({
        ts: new Date().toISOString(), job, mode, deep,
        reference: refOk ? reference : null,
        path, name, size: st ? st.size : null,
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
    return json(res, 200, await pickSaveNative(basename(String(defaultName)) || 'merged.mp4'));
  }

  if (p === '/api/reveal' && req.method === 'POST') {
    const { path: target } = await readBody(req);
    const abs = normalizePath(target);
    const st = abs ? await stat(abs).catch(() => null) : null;
    if (!st) return json(res, 404, { error: '文件不存在或无权限' });
    return json(res, 200, { ok: await revealInFinder(abs) });
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
      } else if (skipped > 0) {
        // Some source never made it into the product, so deleting the rest
        // would silently lose footage. Keep the whole task.
        verify = { ok: false, reason: `有 ${skipped} 个片段无法解析、未参与合并，整组保留源文件` };
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
    const allowed = new Set(lastFailedPaths);
    const targets = (Array.isArray(paths) ? paths : []).filter((x) => typeof x === 'string' && allowed.has(x));
    const trashed = [], errors = [];
    for (const t of targets) {
      const r = await trashFile(t);
      if (r?.ok !== false) trashed.push(t); else errors.push({ path: t, reason: r.reason || '移入废纸篓失败' });
    }
    lastFailedPaths = lastFailedPaths.filter((x) => !trashed.includes(x));
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

server.listen(PORT, HOST, () => {
  console.log(`视频修复工具已启动： http://${HOST}:${PORT}`);
  console.log(`运行日志： ${LOG_FILE}`);
  console.log('按 Ctrl+C 停止。');
});