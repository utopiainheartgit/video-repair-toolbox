import { readFile, writeFile, truncate, copyFile, stat, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { diagnose, inspectBoxes, isVideoFile } from '../lib/probe.mjs';
import { repairInPlace, findUntrunc } from '../lib/repair.mjs';
import { makeSamples } from './samples.mjs';

const DIR = join(import.meta.dirname, '..', 'testdata');
const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
const size = async (p) => (await stat(p)).size;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function main() {
  console.log('\n=== 1. 制造损坏样本 ===');
  await mkdir(DIR, { recursive: true });
  await makeSamples();

  console.log('\n=== 2. 工具可用性 ===');
  const untrunc = await findUntrunc();
  check('untrunc 可被找到', !!untrunc, untrunc || '');
  check('isVideoFile 识别 mkv', isVideoFile('a.mkv'));
  check('isVideoFile 拒绝 txt', !isVideoFile('a.txt'));
  check('isVideoFile 识别大写 MP4', isVideoFile('A.MP4'));

  console.log('\n=== 3. 诊断准确性 ===');
  const expect = {
    'healthy.mp4': 'healthy',
    'healthy.mkv': 'healthy',
    'truncated.mp4': 'broken',
    'corrupt.mp4': 'damaged',
    'noindex.avi': 'damaged',
    'empty.mp4': 'broken',
    'notvideo.mp4': 'broken',
  };
  const diags = {};
  for (const [name, want] of Object.entries(expect)) {
    const d = await diagnose(join(DIR, name), { deep: false });
    diags[name] = d;
    const codes = d.problems.map((p) => p.code).join(',') || '无';
    check(`${name} → ${d.verdict}`, d.verdict === want, `(期望 ${want}；问题: ${codes})`);
    console.log(`      问题: ${codes}`);
  }
  check('truncated.mp4 命中 MOOV_MISSING', diags['truncated.mp4'].problems.some((p) => p.code === 'MOOV_MISSING'));
  check('healthy.mp4 零问题', diags['healthy.mp4'].problems.length === 0);

  console.log('\n=== 4. 修复 + 覆盖安全性 ===');
  const before = {};
  for (const n of Object.keys(expect)) before[n] = await sha(join(DIR, n));

  // Healthy files must be skipped and left byte-identical.
  for (const n of ['healthy.mp4', 'healthy.mkv']) {
    const d = diags[n];
    check(`${n} 判定健康 → 应跳过`, d.verdict === 'healthy');
  }

  const results = {};
  for (const n of ['corrupt.mp4', 'noindex.avi', 'truncated.mp4', 'empty.mp4', 'notvideo.mp4']) {
    const p = join(DIR, n);
    const logs = [];
    const r = await repairInPlace(p, { diagnosis: diags[n], allowReencode: true, onLog: (m) => logs.push(m) });
    results[n] = r;
    const after = await sha(p);
    const unchanged = after === before[n];
    console.log(`  ${n}: ok=${r.ok} replaced=${!!r.replaced} 策略=${r.strategy || '—'} 原文件${unchanged ? '未改动' : '已替换'}`);
    if (!r.ok) {
      check(`${n} 修复失败时原文件必须分毫不动`, unchanged);
      console.log(`      原因: ${(r.reasons || []).join('；')}`);
    } else {
      check(`${n} 修复成功且已替换`, r.replaced === true);
      const vd = await diagnose(p, { deep: false });
      check(`${n} 修复后可正常诊断`, vd.verdict === 'healthy' || vd.verdict === 'damaged', `verdict=${vd.verdict}`);
      console.log(`      修复后: ${vd.verdict}, 时长 ${vd.info?.duration?.toFixed(2)}s, 大小 ${await size(p)}`);
    }
    if (logs.length) console.log(`      日志末行: ${logs[logs.length - 1].slice(0, 160)}`);
  }

  check('健康文件从未被改动', await sha(join(DIR, 'healthy.mp4')) === before['healthy.mp4']
    && await sha(join(DIR, 'healthy.mkv')) === before['healthy.mkv']);

  console.log('\n=== 5. untrunc 索引重建（带参考文件）===');
  if (untrunc) {
    const p = join(DIR, 'truncated.mp4');
    const b = await sha(p);
    const logs = [];
    const r = await repairInPlace(p, {
      diagnosis: diags['truncated.mp4'], allowReencode: true,
      reference: join(DIR, 'healthy.mp4'), onLog: (m) => logs.push(m),
    });
    console.log(`  ok=${r.ok} 策略=${r.strategy || '—'} 尝试=${(r.tried || []).join('→')}`);
    console.log(`  日志: ${logs.slice(0, 6).join(' | ').slice(0, 500)}`);
    if (r.ok) {
      const vd = await diagnose(p, { deep: false });
      check('untrunc 修复后文件可解析', vd.verdict !== 'broken' && vd.verdict !== 'unreadable', `verdict=${vd.verdict}`);
      console.log(`  修复后时长 ${vd.info?.duration?.toFixed(2)}s（原片 12s）`);
    } else {
      check('untrunc 失败时原文件未改动', await sha(p) === b);
      console.log(`  原因: ${(r.reasons || []).join('；')}`);
    }
  }

  console.log(`\n=== 结果： ${pass} 通过, ${fail} 失败 ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });