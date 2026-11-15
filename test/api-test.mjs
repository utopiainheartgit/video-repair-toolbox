import { createHash } from 'node:crypto';
import { readFile, stat, readdir } from 'node:fs/promises';
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

console.log(`\n=== API 结果： ${pass} 通过, ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);