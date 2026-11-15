import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdtemp, rm, open, rename } from 'node:fs/promises';
import { join, extname, basename, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isVideoFile, diagnose, FFMPEG, FFPROBE, run } from './lib/probe.mjs';
import { repairFile, repairInPlace, findUntrunc, cleanupWork } from './lib/repair.mjs';
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
  return (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
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
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && isVideoFile(e.name)) {
        const s = await stat(p).catch(() => null);
        if (s) out.push({ path: p, name: e.name, size: s.size, rel: p.slice(root.length).replace(/^\//, '') });
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
  return out;
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

// Finder "delete" moves to Trash (recoverable), unlike fs.rm.
function trashFile(file) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const esc = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) => {
    const c = spawn('osascript', ['-e', `tell application "Finder" to delete POSIX file "${esc}"`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { c.kill('SIGKILL'); resolve(false); }, 30_000);
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
      handleMode: true, pathMode: process.platform === 'darwin',
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

  if (p === '/api/scan' && req.method === 'POST') {
    const { path: root } = await readBody(req);
    if (!root || typeof root !== 'string') return json(res, 400, { error: '缺少 path' });
    const expanded = root === '~' ? homedir() : root.startsWith('~/') ? join(homedir(), root.slice(2)) : root;
    const abs = resolve(expanded);
    const s = await stat(abs).catch(() => null);
    if (!s) return json(res, 404, { error: `路径不存在：${abs}` });
    if (s.isFile()) {
      if (!isVideoFile(abs)) return json(res, 400, { error: '不是支持的视频文件' });
      return json(res, 200, { root: abs, kind: 'file', files: [{ path: abs, name: basename(abs), size: s.size, rel: basename(abs) }] });
    }
    const files = await scanDir(abs);
    return json(res, 200, { root: abs, kind: 'dir', files });
  }

  if (p === '/api/jobs' && req.method === 'POST') {
    const body = await readBody(req);
    const { mode = 'diagnose', files = [], deep = false, allowReencode = true, reference = null } = body;
    if (!Array.isArray(files) || !files.length) return json(res, 400, { error: '没有待处理文件' });
    if (!['diagnose', 'repair'].includes(mode)) return json(res, 400, { error: 'mode 非法' });

    const send = sseStart(res);
    // req.destroyed flips true once the POST body is consumed, so it cannot
    // signal client cancellation here — watch the response socket instead.
    let aborted = false;
    res.on('close', () => { aborted = true; });
    const refOk = reference && await stat(reference).catch(() => null);
    send('start', { total: files.length, mode, deep, untrunc: await findUntrunc(), reference: refOk ? reference : null });

    let done = 0, repaired = 0, skipped = 0, failed = 0;
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
      let diag = null, action = null, strategy = null, tried = null, reasons = null;

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
          if (needsRef && !refOk) log('检测到 moov 缺失：未提供参考文件，将尝试无损/重编码手段（成功率较低）');
          const r = await repairInPlace(path, { reference: refOk ? reference : null, allowReencode, diagnosis: diag, onLog: log, onProgress: prog, isAborted: () => aborted });
          tried = r.tried;
          if (r.ok && r.replaced) {
            repaired++;
            prog({ stage: '已覆盖原文件', percent: 100 });
            log(`已覆盖原文件，策略：${r.strategy}`);
            action = 'repaired'; strategy = r.strategy;
            send('file-done', { index: done, path, name, verdict: 'repaired', action: 'repaired', strategy: r.strategy, tried: r.tried, info: r.info });
          } else {
            failed++; noteFailed(path);
            log(`修复失败，原文件未改动：${(r.reasons || []).join('；')}`);
            action = 'failed'; reasons = r.reasons;
            send('file-done', { index: done, path, name, verdict: diag.verdict, action: 'failed', tried: r.tried, reasons: r.reasons });
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
        action, strategy, tried, reasons, messages: msgs,
      });
      done++;
      send('progress', { done, total: files.length, repaired, skipped, failed });
    }
    send('done', { done, total: files.length, repaired, skipped, failed });
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
        reasons: payload.reasons || null, messages: logs,
      });
      if (emit) { emit('result', payload); return res.end(); }
      return json(res, 200, payload);
    };

    if (mode === 'diagnose') return finish({ diagnosis: diag, logs });
    if (diag.verdict === 'healthy') return finish({ action: 'skipped', diagnosis: diag, logs });

    const r = await repairFile(ent.path, { allowReencode, diagnosis: diag, onLog: log, onProgress: prog });
    if (!r.ok) {
      await cleanupWork(r.work);
      return finish({ action: 'failed', diagnosis: diag, reasons: r.reasons, tried: r.tried, logs });
    }

    const outId = randomUUID();
    STAGED.set(outId, { dir: r.work, path: r.output, name: ent.name, size: (await stat(r.output)).size, created: Date.now(), isResult: true });
    return finish({ action: 'repaired', resultId: outId, strategy: r.strategy, tried: r.tried, diagnosis: diag, info: r.info, logs });
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
      if (await trashFile(t)) trashed.push(t); else errors.push(t);
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