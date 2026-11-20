// Recoverable deletion ("move to trash") with correct handling for external
// volumes.
//
// macOS gives each mounted volume its own trash: the startup disk uses
// ~/.Trash, but an external disk uses /Volumes/<name>/.Trashes/<uid>. Moving a
// file across volumes with fs.rename() throws EXDEV, so always pick the trash
// on the file's own volume. Finder is still tried first because it can record
// the original path for "Put Back"; the rename is the fallback.
//
// Every outcome is returned as { ok, via?, reason? } so callers can show *why*
// a deletion failed instead of silently keeping the files.

import { stat, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { spawn } from 'node:child_process';

const HOME_TRASH = join(homedir(), '.Trash');
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

/**
 * Which trash directory belongs to this file? Pure apart from the stat calls,
 * so tests can check the mount logic without moving anything.
 */
export async function trashDirFor(file, fileStat = null) {
  const st = fileStat || await stat(file).catch(() => null);
  if (!st) return null;
  let homeDev = null;
  try { homeDev = (await stat(homedir())).dev; } catch { /* fall through */ }
  if (homeDev === null || homeDev === st.dev) return HOME_TRASH;

  // Different volume. macOS mounts external media under /Volumes/<name>.
  const m = /^(\/Volumes\/[^/]+)(?=\/|$)/.exec(file);
  const candidates = m ? [m[1]] : [];
  // Also walk upwards, in case the volume is mounted somewhere unusual.
  let cur = dirname(file);
  for (let i = 0; i < 12 && cur && cur !== '/'; i++) {
    candidates.push(cur);
    cur = dirname(cur);
  }
  for (const root of candidates) {
    const rs = await stat(root).catch(() => null);
    if (rs && rs.dev === st.dev && basename(root) !== '.') {
      return join(root, '.Trashes', String(uid()));
    }
  }
  return null; // cannot determine a safe same-volume destination
}

async function pickTarget(dir, name) {
  await mkdir(dir, { recursive: true }).catch(() => {});
  const ext = extname(name);
  const base = basename(name, ext);
  let dest = join(dir, `${base}${ext}`);
  for (let i = 1; i < 500; i++) {
    if (!(await stat(dest).catch(() => null))) return dest;
    dest = join(dir, `${base} ${i}${ext}`);
  }
  return null;
}

const clip = (s, n = 180) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Ask Finder to delete, preferring its "Put Back" metadata. */
export async function finderDelete(file) {
  if (process.platform !== 'darwin') return { ok: false, reason: '非 macOS 系统' };
  const esc = String(file).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) => {
    let done = false;
    const c = spawn('osascript', ['-e', `tell application "Finder" to delete POSIX file "${esc}"`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    c.stderr?.on('data', (b) => { err += b.toString(); });
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      if (!done) { done = true; resolve({ ok: false, reason: 'Finder 删除超时（10 秒）' }); }
    }, 10_000);
    c.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: false, reason: `无法启动 Finder：${e.code || e.message}` });
    });
    c.on('close', async (code) => {
      if (done) return;
      clearTimeout(timer);
      const still = await stat(file).catch(() => null);
      done = true;
      if (code === 0 && !still) return resolve({ ok: true, via: 'finder' });
      resolve({
        ok: false,
        reason: still
          ? `Finder 未删除文件（退出码 ${code}）${err ? '：' + clip(err) : ''}`
          : `Finder 报错（退出码 ${code}）${err ? '：' + clip(err) : ''}`,
      });
    });
  });
}

/**
 * Move a file to the trash on its own volume. `finder` is injectable so tests
 * do not need Automation permission or a 10-second timeout.
 * Returns { ok, via?, reason? }; never unlinks.
 */
export async function moveToTrash(file, { finder = finderDelete, useFinder = true } = {}) {
  if (process.platform !== 'darwin') return { ok: false, reason: '仅支持 macOS 的废纸篓' };
  const st = await stat(file).catch(() => null);
  if (!st) return { ok: false, reason: '文件不存在' };
  if (!st.isFile()) return { ok: false, reason: '不是普通文件' };

  let finderErr = '';
  if (useFinder) {
    const r = await finder(file);
    if (r?.ok) return { ok: true, via: 'finder' };
    finderErr = r?.reason || 'Finder 删除失败';
  }

  try {
    const dir = await trashDirFor(file, st);
    if (!dir) {
      return { ok: false, reason: `${finderErr}；无法确定该文件所在卷的废纸篓` };
    }
    const dest = await pickTarget(dir, basename(file));
    if (!dest) return { ok: false, reason: `${finderErr}；废纸篓内没有可用文件名` };
    await rename(file, dest);
    // A successful rename can still be a no-op on odd filesystems; verify.
    if (await stat(file).catch(() => null)) {
      return { ok: false, reason: `${finderErr}；移动后源文件仍存在` };
    }
    return {
      ok: true,
      via: dir === HOME_TRASH ? 'home-trash' : 'volume-trash',
      reason: finderErr || undefined,
    };
  } catch (e) {
    return {
      ok: false,
      reason: `${finderErr}；回退移动失败：${e.code || e.message}`,
    };
  }
}
