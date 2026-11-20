// Queue primitives for batch merging.
//
// Three responsibilities, kept deliberately small and side-effect free except
// for trashSources():
//   1. splitTasks     — turn a linear clip list into task groups
//   2. verifyProduct  — decide whether a merge is trustworthy enough to delete
//   3. trashSources   — move sources to the OS trash, in small guarded batches
//
// The deletion path is the dangerous one, so it is built from independent
// vetoes: a task is only eligible when the merge reported clean, the product
// exists, ffprobe parses it, it has a video track, and its duration matches
// the sum of the inputs. Any doubt keeps the files.

import { stat } from 'node:fs/promises';
import { ffprobe, summarize } from './probe.mjs';

// macOS APFS and Windows NTFS are case-insensitive by default, so /x/A.mp4 and
// /x/a.mp4 can be the same file. Comparisons that gate deletion must match
// that behaviour or we risk deleting a file we just wrote.
export const samePath = (a, b) => (process.platform === 'darwin' || process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b);

/**
 * Split a linear clip list into task groups.
 *
 * A boundary sits AFTER any clip flagged `breakAfter`. Keeping the boundary on
 * the clip (rather than in a parallel array of groups) means the UI only flips
 * one boolean when the user splits or rejoins, and reordering keeps groups
 * coherent automatically.
 */
export function splitTasks(items = []) {
  const tasks = [];
  let cur = [];
  for (let i = 0; i < items.length; i++) {
    cur.push(items[i]);
    if (items[i].breakAfter || i === items.length - 1) {
      tasks.push(cur);
      cur = [];
    }
  }
  return tasks;
}

/**
 * Decide whether a merge result is safe to treat as "success".
 *
 * Returns { ok, reason, duration, size }. A false `ok` always carries a reason
 * suitable for showing to the user next to the retained files.
 */
export async function verifyProduct(result, sources = [], { minBytes = 4096 } = {}) {
  if (!result || !result.ok) {
    return { ok: false, reason: (result?.reasons || [])[0] || '合并未成功' };
  }
  if (result.level !== 'clean') {
    const w = (result.warnings || [])[0];
    return { ok: false, reason: w ? `产物有告警：${w}` : '产物未达到无告警标准' };
  }
  if (!result.output) return { ok: false, reason: '没有产出文件路径' };

  const st = await stat(result.output).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, reason: '产出文件不存在' };
  if (st.size < minBytes) return { ok: false, reason: `产出文件过小（${st.size} 字节）` };

  const p = await ffprobe(result.output);
  if (!p.ok) return { ok: false, reason: `产出文件无法解析：${String(p.error || '').slice(0, 120)}` };
  const info = summarize(p.raw);
  if (!info?.video) return { ok: false, reason: '产出文件没有视频轨' };
  if (!(Number(info.duration) > 0.4)) {
    return { ok: false, reason: `产出文件时长异常（${info.duration || 0}s）` };
  }

  const declared = Number(result.expected) || 0;
  const summed = sources.reduce((n, c) => n + (Number(c.duration) || 0), 0);
  const expected = declared || summed;
  if (expected > 0) {
    const tol = Math.max(2, expected * 0.08);
    if (Math.abs(info.duration - expected) > tol) {
      return {
        ok: false,
        reason: `时长偏差超限（预期约 ${expected.toFixed(1)}s，实际 ${info.duration.toFixed(1)}s）`,
      };
    }
  }
  return { ok: true, duration: info.duration, size: st.size };
}

/**
 * Move sources to the OS trash, one small batch at a time.
 *
 * `trash` is injected so this module does not spawn Finder itself. `allowed`
 * is a hard allow-list: a path that is not in it is never touched, even if the
 * caller passes it by mistake. The merge output is always excluded.
 */
export async function trashSources(files = [], {
  trash,
  output = null,
  allowed = null,
  onEach = () => {},
  maxBatch = 10,
} = {}) {
  if (typeof trash !== 'function') throw new Error('trashSources 需要一个 trash 函数');
  const allowedSet = allowed ? new Set(allowed.map((f) => String(f).toLowerCase())) : null;
  const deleted = [];
  const failed = [];

  const candidates = files.filter((f) => {
    if (!f) return false;
    if (output && samePath(f, output)) return false;
    if (allowedSet && !allowedSet.has(String(f).toLowerCase())) return false;
    return true;
  });

  for (let i = 0; i < candidates.length; i += maxBatch) {
    const batch = candidates.slice(i, i + maxBatch);
    for (const file of batch) {
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) {
        failed.push({ file, reason: st ? '不是普通文件' : '文件不存在' });
        onEach({ file, ok: false });
        continue;
      }
      let ok = false;
      let reason = '';
      try {
        const r = await trash(file);
        // A trash function may return a boolean or { ok, reason, via }. Keep
        // supporting both so the reason reaches the log and the result card.
        if (r && typeof r === 'object' && 'ok' in r) {
          ok = !!r.ok;
          reason = r.reason || '';
        } else {
          ok = !!r;
        }
      } catch (e) {
        reason = String(e?.message || e);
      }
      if (ok) {
        deleted.push(file);
        onEach({ file, ok: true });
      } else {
        failed.push({ file, reason: reason || '移入废纸篓失败' });
        onEach({ file, ok: false, reason });
      }
    }
  }
  return { deleted, failed };
}

/**
 * Human-readable reason a task was held back, used in the summary panel.
 */
export function holdReason({ verify, skipped = 0, planned = 0 } = {}) {
  if (skipped > 0 && planned > 0) return `有 ${skipped}/${planned} 个片段无法解析，已整组保留源文件`;
  return verify?.reason || '未通过校验';
}
