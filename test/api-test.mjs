import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile, stat, readdir, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSamples } from './samples.mjs';

const BASE = 'http://127.0.0.1:8731';
const DIR = join(import.meta.dirname, '..', 'testdata');
const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

async function sse(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = 'message', data = '';
      for (const l of block.split('\n')) {
        if (l.startsWith('event: ')) ev = l.slice(7);
        else if (l.startsWith('data: ')) data += l.slice(6);
      }
      if (data) events.push({ ev, d: JSON.parse(data) });
    }
  }
  return events;
}

await makeSamples();
// Default merge products are intentionally excluded from /api/scan, so a
// previous interrupted run leaves them behind and the next run's collision
// avoidance produces `..._merged-2.mp4`, breaking the naming assertions.
for (const f of await readdir(DIR)) {
  if (/^api_merge_a_merged(?:_t\d+)?(?:-\d+)?\.mp4$/.test(f)) {
    await rm(join(DIR, f), { force: true }).catch(() => {});
  }
}
const scan = await (await fetch(BASE + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: DIR }) })).json();
const files = scan.files.map((f) => f.path);
console.log(`\n=== 扫描到 ${files.length} 个视频 ===`);

const before = {};
for (const f of files) before[f] = await sha(f);

console.log('\n=== 诊断（SSE）===');
const de = await sse('/api/jobs', { mode: 'diagnose', files, deep: false });
const dd = de.filter((e) => e.ev === 'file-done');
for (const e of dd) console.log(`  ${e.d.name.padEnd(18)} ${e.d.verdict}`);
check('诊断事件数与文件数一致', dd.length === files.length, `${dd.length}/${files.length}`);
check('收到 done 事件', de.some((e) => e.ev === 'done'));
const healthyNames = dd.filter((e) => e.d.verdict === 'healthy').map((e) => e.d.name);
check('healthy.mp4 / healthy.mkv / moov_at_end.mp4 判为健康',
  ['healthy.mp4', 'healthy.mkv', 'moov_at_end.mp4'].every((n) => healthyNames.includes(n)), healthyNames.join(','));
check('诊断阶段未改动任何文件', (await Promise.all(files.map(async (f) => await sha(f) === before[f]))).every(Boolean));

console.log('\n=== 修复（SSE，覆盖原文件）===');
const re = await sse('/api/jobs', { mode: 'repair', files, deep: false, allowReencode: true, reference: join(DIR, 'healthy.mp4') });
const rd = re.filter((e) => e.ev === 'file-done');
for (const e of rd) console.log(`  ${e.d.name.padEnd(18)} ${String(e.d.action).padEnd(10)} ${e.d.strategy || (e.d.reasons || []).join('；').slice(0, 70)}`);
const sum = re.find((e) => e.ev === 'done')?.d;
console.log('  汇总:', JSON.stringify(sum));

const byName = Object.fromEntries(rd.map((e) => [e.d.name, e.d]));
check('healthy.mp4 被跳过', byName['healthy.mp4']?.action === 'skipped');
check('healthy.mkv 被跳过', byName['healthy.mkv']?.action === 'skipped');
check('moov_at_end.mp4 被跳过', byName['moov_at_end.mp4']?.action === 'skipped');
check('corrupt.mp4 已修复', byName['corrupt.mp4']?.action === 'repaired');
check('noindex.avi 已修复', byName['noindex.avi']?.action === 'repaired');
check('truncated.mp4 经 untrunc 修复', byName['truncated.mp4']?.action === 'repaired', JSON.stringify(byName['truncated.mp4']));
check('empty.mp4 失败', byName['empty.mp4']?.action === 'failed');
check('notvideo.mp4 失败', byName['notvideo.mp4']?.action === 'failed');

console.log('\n=== 覆盖后校验 ===');
for (const n of ['healthy.mp4', 'healthy.mkv', 'moov_at_end.mp4']) {
  check(`${n} 字节完全未变`, await sha(join(DIR, n)) === before[join(DIR, n)]);
}
for (const n of ['empty.mp4', 'notvideo.mp4']) {
  check(`${n} 修复失败但原文件未变`, await sha(join(DIR, n)) === before[join(DIR, n)]);
}
for (const n of ['corrupt.mp4', 'noindex.avi', 'truncated.mp4']) {
  const p = join(DIR, n);
  check(`${n} 已被替换`, await sha(p) !== before[p]);
  check(`${n} 替换后大小 > 0`, (await stat(p)).size > 0);
}
check('没有遗留 .repairing 临时文件', !(await readdir(DIR)).some((f) => f.endsWith('.repairing')));

console.log('\n=== 能力探测：统一路径模式 ===');
const caps = await (await fetch(BASE + '/api/capabilities')).json();
check('handleMode 已关闭（不上传文件字节）', caps.handleMode === false);
check('pathMode 已开启', caps.pathMode === true);

console.log('\n=== 批量扫描 /api/scan-many ===');
const goodFile = join(DIR, 'healthy.mp4');
const manyBody = {
  paths: [
    DIR,                 // folder → several files
    goodFile,            // single file, also inside DIR → should dedupe
    goodFile,            // exact duplicate path → reported as duplicate
    join(DIR, 'no-such-file.mp4'), // missing → ok:false
  ],
};
const many = await (await fetch(BASE + '/api/scan-many', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manyBody),
})).json();
check('批量扫描返回逐项结果', Array.isArray(many.results) && many.results.length === manyBody.paths.length);
check('文件夹项扫描成功且有文件', many.results[0]?.ok === true && many.results[0].count > 0);
check('单文件项扫描成功', many.results[1]?.ok === true && many.results[1].kind === 'file');
check('重复路径被识别', many.duplicates >= 1, `duplicates=${many.duplicates}`);
check('失效路径返回 ok:false', many.results[3]?.ok === false);
const manyPaths = many.results.flatMap((r) => (r.files || []).map((f) => f.path));
check('聚合文件列表内无重复路径', new Set(manyPaths).size === manyPaths.length, `${manyPaths.length} items`);
check('duplicates 只计真实重复，不含失效路径', many.duplicates === 1, `duplicates=${many.duplicates}`);

// Products now sit BESIDE their sources; a re-scan must skip them by the strict
// `_merged[_tNN][-N].ext` name and not feed a merge its own output.
const srcDir = join(DIR, '.scan-merged');
await mkdir(srcDir, { recursive: true });
await writeFile(join(srcDir, 'a.mp4'), 'x');
await writeFile(join(srcDir, 'a_merged.mp4'), 'x');
await writeFile(join(srcDir, 'a_merged_t02.mp4'), 'x');
await writeFile(join(srcDir, 'holiday-2.mp4'), 'x');
const sm = await (await fetch(BASE + '/api/scan-many', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [srcDir] }),
})).json();
const smFiles = (sm.results?.[0]?.files || []).map((f) => f.name);
check('扫描跳过同级合并产物', !smFiles.includes('a_merged.mp4') && !smFiles.includes('a_merged_t02.mp4'), smFiles.join(','));
check('扫描仍收录普通源片段', smFiles.includes('a.mp4') && smFiles.includes('holiday-2.mp4'), smFiles.join(','));
await rm(srcDir, { recursive: true, force: true }).catch(() => {});

console.log('\n=== 非法路径与 file:// 归一化 ===');
const weird = await (await fetch(BASE + '/api/scan-many', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ paths: ['', '   ', 123, null, 'file://' + goodFile] }),
})).json();
check('空串/非字符串被标为 invalid', weird.invalid === 4, `invalid=${weird.invalid}`);
check('file:// 路径被归一化为真实文件', weird.results[4]?.ok === true && weird.results[4]?.kind === 'file');

console.log('\n=== 续跑偏移 resumeFrom ===');
// One healthy file only. With resumeFrom=7 the stream's total must start at 8.
const re2 = await sse('/api/jobs', { mode: 'diagnose', files: [goodFile], deep: false, resumeFrom: 7 });
const startEvt = re2.find((e) => e.ev === 'start');
const doneEvt = re2.find((e) => e.ev === 'done');
check('start.total 计入续跑偏移', startEvt?.d.total === 8, JSON.stringify(startEvt?.d));
check('done.total 计入续跑偏移', doneEvt?.d.total === 8, JSON.stringify(doneEvt?.d));
check('续跑仍正常处理该文件', re2.filter((e) => e.ev === 'file-done').length === 1);
const progEvts = re2.filter((e) => e.ev === 'progress');
check('progress.total 与 start/done.total 一致', progEvts.length > 0 && progEvts.every((e) => e.d.total === 8), JSON.stringify(progEvts.map((e) => e.d)));

console.log('\n=== 合并：计划接口 ===');
const { copyFile } = await import('node:fs/promises');
const ma = join(DIR, '.api_merge_a.mp4');
const mb = join(DIR, '.api_merge_b.mp4');
await copyFile(goodFile, ma);
await copyFile(goodFile, mb);

const planRes = await fetch(BASE + '/api/merge-plan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ files: [ma, mb], mode: 'auto', size: 'first', quality: 'balanced' }),
});
const planBody = await planRes.json();
check('merge-plan 返回 200', planRes.status === 200, String(planRes.status));
check('merge-plan 探测出两段', planBody.clips?.length === 2 && planBody.clips.every((c) => c.ok));
check('同规格判定为无损 copy', planBody.plan?.strategy === 'copy', planBody.plan?.strategy);
check('给出自动输出名', !!planBody.suggestedOutput && planBody.suggestedOutput.includes('_merged'), planBody.suggestedOutput);
check('merge-plan 未生成任何文件', !(await stat(planBody.suggestedOutput).catch(() => null)));

const badPlan = await (await fetch(BASE + '/api/merge-plan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ files: [], mode: 'auto' }),
})).json();
check('merge-plan 空列表返回 400 语义', !badPlan.clips && !!badPlan.error);

console.log('\n=== 合并：执行接口 ===');
const mergeEvts = await sse('/api/merge', { files: [ma, mb], mode: 'auto', output: join(DIR, '.api_merged.mp4') });
const mDone = mergeEvts.find((e) => e.ev === 'merge-done');
check('merge 产生 merge-done', !!mDone);
check('合并成功', mDone?.d.ok === true, (mDone?.d.reasons || []).join('；'));
check('策略为无损 copy', mDone?.d.strategy === 'copy', mDone?.d.strategy);
check('时长≈24s', mDone?.d.duration > 23 && mDone?.d.duration < 25, `dur=${mDone?.d.duration}`);
check('含 clips 明细', Array.isArray(mDone?.d.clips) && mDone.d.clips.length === 2);
check('源片段哈希未变', (await sha(ma)) === (await sha(goodFile)));

const guardEvts = await sse('/api/merge', { files: [ma, mb], output: ma.toUpperCase() });
const gDone = guardEvts.find((e) => e.ev === 'merge-done');
check('输出指向输入时拒绝', gDone?.d.ok === false, JSON.stringify(gDone?.d));

let shortRejected = false;
try { await sse('/api/merge', { files: [ma] }); } catch { shortRejected = true; }
check('少于 2 段被拒绝', shortRejected);

const reveal = await (await fetch(BASE + '/api/reveal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/no/such/file.mp4' }),
})).json();
check('reveal 对不存在的路径返回错误', !!reveal.error);

console.log('\n=== 合并队列 ===');
const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
check('空队列返回 400', (await post('/api/merge-queue', { tasks: [] })).status === 400);
check('单片段任务返回 400', (await post('/api/merge-queue', { tasks: [{ files: [ma] }] })).status === 400);

const qEvts = await sse('/api/merge-queue', { tasks: [{ files: [ma, mb] }], mode: 'auto', deleteSources: false });
const qStart = qEvts.find((e) => e.ev === 'queue-start');
const qTask = qEvts.find((e) => e.ev === 'task-done');
const qDone = qEvts.find((e) => e.ev === 'queue-done');
check('队列发出 queue-start', qStart?.d.total === 1, JSON.stringify(qStart?.d));
check('队列任务合并成功', qTask?.d.ok === true, (qTask?.d.reasons || []).join('；'));
check('未开启删除时不删源', qTask?.d.deleted.length === 0);
check('队列汇总统计正确', qDone?.d.succeeded === 1 && qDone?.d.failed === 0 && qDone?.d.deletedCount === 0,
  JSON.stringify(qDone?.d && { s: qDone.d.succeeded, f: qDone.d.failed, d: qDone.d.deletedCount }));
check('队列产物已生成', !!(await stat(qTask?.d.output).catch(() => null)));
check('任务回报删除失败明细字段', Array.isArray(qTask?.d.trashErrors));
check('汇总含删除失败计数', typeof qDone?.d.trashErrorCount === 'number' && qDone.d.trashErrorCount === 0);
check('产物落在源片段所在文件夹（无 merged/ 子目录）',
  !String(qTask?.d.output || '').includes('/merged/') && String(qTask?.d.output || '').includes('/testdata/'),
  qTask?.d.output);
check('单任务产物不带任务号', /api_merge_a_merged\.mp4$/.test(qTask?.d.output || ''), qTask?.d.output);

// A per-task path must be honoured — the UI sends one for a single task and
// for renamed tasks, and it used to be shown in the dialog but never submitted.
const manualOut = join(DIR, '.api_manual.mp4');
const manEvts = await sse('/api/merge-queue', { tasks: [{ files: [ma, mb], output: manualOut }], mode: 'auto' });
const manDone = manEvts.find((e) => e.ev === 'task-done');
check('队列采用逐任务指定的输出路径', manDone?.d.output === manualOut, manDone?.d.output);
check('指定路径的产物已生成', !!(await stat(manualOut).catch(() => null)));

// A bare rename with no suffix must land beside the sources with the plan's
// extension appended (the exact bug behind the 火辣青春小美 log entry).
const bareEvts = await sse('/api/merge-queue', {
  tasks: [{ files: [ma, mb], output: '裸名测试产物' }], mode: 'auto',
});
const bareDone = bareEvts.find((e) => e.ev === 'task-done');
const bareOut = join(DIR, '裸名测试产物.mp4');
check('裸名重命名落到源文件夹并自动补后缀', bareDone?.d.output === bareOut, bareDone?.d.output);
check('裸名重命名的产物已生成', !!(await stat(bareOut).catch(() => null)));

const badFile = join(DIR, '.api_qbad.mp4');
await writeFile(badFile, 'not a video');
const fEvts = await sse('/api/merge-queue', { tasks: [{ files: [badFile, ma] }], mode: 'auto', deleteSources: true });
const fTask = fEvts.find((e) => e.ev === 'task-done');
const fDone = fEvts.find((e) => e.ev === 'queue-done');
check('含坏文件的任务判定失败', fTask?.d.ok === false);
check('失败任务不删任何源', fTask?.d.deleted.length === 0);
check('失败任务列出全部保留文件', fTask?.d.kept.length === 2, `${fTask?.d.kept.length}`);
check('失败计入汇总', fDone?.d.failed === 1 && fDone?.d.deletedCount === 0);

const seqEvts = await sse('/api/merge-queue', {
  tasks: [{ files: [badFile, ma] }, { files: [ma, mb] }], mode: 'auto', deleteSources: false,
});
const seqDone = seqEvts.find((e) => e.ev === 'queue-done');
check('前一任务失败不阻断队列', seqDone?.d.total === 2 && seqDone.d.tasks.length === 2, JSON.stringify(seqDone?.d?.tasks?.length));
check('后续任务仍然成功', seqDone?.d.tasks[1].ok === true);
check('多任务产物带补零任务号', /_merged_t02\.mp4$/.test(seqDone?.d.tasks?.[1]?.output || ''),
  seqDone?.d.tasks?.[1]?.output);

await rm(badFile, { force: true }).catch(() => {});
await rm(manualOut, { force: true }).catch(() => {});
await rm(bareOut, { force: true }).catch(() => {});
await rm(join(DIR, 'merged'), { recursive: true, force: true }).catch(() => {});

for (const f of [ma, mb, join(DIR, '.api_merged.mp4')]) await rm(f, { force: true }).catch(() => {});

// --- Request validation / cross-site hardening ---
const wrongCt = await fetch(BASE + '/api/trash-failed', {
  method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"paths":[]}',
});
check('非 JSON 请求被拒绝', wrongCt.status === 415, `HTTP ${wrongCt.status}`);

// Node's fetch() overrides the Host header, so use raw http to simulate a
// DNS-rebinding request carrying a foreign Host.
const badHostStatus = await new Promise((resolve) => {
  const req = httpRequest({
    host: '127.0.0.1', port: 8731, path: '/api/scan', method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: 'evil.example', 'Content-Length': 2 },
  }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.end('{}');
});
check('跨站 Host 被拒绝', badHostStatus === 403, `HTTP ${badHostStatus}`);

// The native folder picker POST has no payload, but it still has to carry the
// JSON header. Guard BOTH sides of that contract: a bodyless request must be
// rejected, and every frontend call site must send the header. Without the
// second check the picker silently dies with "请使用 application/json".
const noCtFolder = await new Promise((resolve) => {
  const req = httpRequest({
    host: '127.0.0.1', port: 8731, path: '/api/pick-folder', method: 'POST',
    headers: { 'Content-Length': 0 },
  }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.end();
});
check('无 JSON 头的文件夹选择被拒绝', noCtFolder === 415, `HTTP ${noCtFolder}`);
const appSrc = await readFile(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
const folderCalls = [...appSrc.matchAll(/fetch\('\/api\/pick-folder'[\s\S]*?\)\.then/g)].map((m) => m[0]);
check('文件夹选择调用均带 JSON 头', folderCalls.length > 0
  && folderCalls.every((s) => s.includes("'Content-Type': 'application/json'")), `调用数 ${folderCalls.length}`);

// Malformed file entries must not kill the SSE stream: a file-done + done must
// still arrive so the client does not treat it as a dropped connection.
const malEvts = await sse('/api/jobs', { mode: 'diagnose', files: [{}] });
check('畸形文件项仍返回 file-done', malEvts.some((e) => e.ev === 'file-done'));
check('畸形文件项不中断 SSE', malEvts.some((e) => e.ev === 'done'));

console.log(`\n=== API 结果： ${pass} 通过, ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);