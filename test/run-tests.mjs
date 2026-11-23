import { readFile, writeFile, truncate, copyFile, stat, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  diagnose, inspectBoxes, isVideoFile, getVideoExtradata, ffprobe, summarize, FFMPEG, run,
  findDataStart, cachedDiagnose, invalidateDiagnosis, clearDiagnosisCache, diagnosisCacheStats,
} from '../lib/probe.mjs';
import { repairInPlace, findUntrunc } from '../lib/repair.mjs';
import { parseSpsH264, parsePpsH264 } from '../lib/bitstream.mjs';
import { tryRawStream } from '../lib/rawstream.mjs';
import { tryHeadFix } from '../lib/headfix.mjs';
import { probeClip, buildPlan, mergeClips, defaultOutput, normalizeOutputName, resolveOutput, isMergeProduct } from '../lib/merge.mjs';
import { splitTasks, verifyProduct, trashSources } from '../lib/queue.mjs';
import { moveToTrash, trashDirFor } from '../lib/trash.mjs';
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

  console.log('\n=== 6. 位流解析与裸流恢复 ===');
  {
    const ed = await getVideoExtradata(join(DIR, 'healthy.mp4'));
    let p = 5;
    const sps = [], pps = [];
    const nSps = ed[p++] & 0x1f;
    for (let i = 0; i < nSps; i++) { const l = ed.readUInt16BE(p); p += 2; sps.push(ed.subarray(p, p + l)); p += l; }
    const nPps = ed[p++];
    for (let i = 0; i < nPps; i++) { const l = ed.readUInt16BE(p); p += 2; pps.push(ed.subarray(p, p + l)); p += l; }
    const s = parseSpsH264(sps[0]);
    check('SPS 解析出 640 宽 / 920 宏块', s.ok && s.width === 640 && s.mbsInFrame === 920, JSON.stringify(s));
    const q = parsePpsH264(pps[0]);
    check('PPS 解析可用', q.ok && q.ppsId === 0 && q.usable === true, JSON.stringify(q));
  }

  {
    const src = join(DIR, 'moov_at_end.mp4');
    const bx = await inspectBoxes(src);
    const moov = bx.boxes.find((b) => b.type === 'moov');
    const broken = join(DIR, '.moov_missing_test.mp4');
    await copyFile(src, broken);
    await truncate(broken, moov.start);
    const work = await mkdtemp(join(tmpdir(), 'vrep-test-'));
    const logs = [];
    let out = null;
    try {
      out = await tryRawStream(broken, work, null, (m) => logs.push(m), () => {}, join(DIR, 'healthy.mp4'));
    } catch (e) { console.log('  裸流异常:', String(e).slice(0, 200)); }
    check('moov 缺失样本可走裸流恢复', !!out, logs.slice(-3).join(' | '));
    if (out) {
      const pr = await ffprobe(out);
      const info = summarize(pr.raw);
      check('裸流恢复时长 10–14s（原 12s）', !!info && info.duration > 10 && info.duration < 14, `dur=${info?.duration}`);
      check('裸流恢复含视频流', !!info?.video, '');
    }
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await rm(broken, { force: true }).catch(() => {});
  }

  {
    const src = join(DIR, 'moov_at_end.mp4');
    const broken = join(DIR, '.headcut_test.mp4');
    const buf = await readFile(src);
    await writeFile(broken, buf.subarray(32));
    const hw = await mkdtemp(join(tmpdir(), 'vrep-hf-'));
    const hf = await tryHeadFix(broken, hw, () => {});
    check('缺 ftyp 样本可补全头部', !!hf, '');
    if (hf) {
      const pr = await ffprobe(hf);
      const info = summarize(pr.raw);
      check('补 ftyp 后时长≈12s', !!info && info.duration > 11 && info.duration < 13, `dur=${info?.duration}`);
    }
    await rm(hw, { recursive: true, force: true }).catch(() => {});
    await rm(broken, { force: true }).catch(() => {});
  }

  console.log('\n=== 7. 合并视频 ===');
  {
    const base = join(DIR, 'healthy.mp4');
    const a = join(DIR, '.merge_a.mp4');
    const b = join(DIR, '.merge_b.mp4');
    await copyFile(base, a); await copyFile(base, b);
    const ha = await sha(a), hb = await sha(b);

    const clips = [await probeClip(a), await probeClip(b)];
    check('probeClip 解析出视频与音频', clips.every((c) => c.ok && c.video && c.audio));
    check('probeClip 时长≈12s', Math.abs(clips[0].duration - 12) < 0.6, `dur=${clips[0].duration}`);

    const plan = buildPlan(clips, { mode: 'auto' });
    check('同规格片段判定为无损 copy', plan.ok && plan.strategy === 'copy', `strategy=${plan.strategy}`);
    check('预期总时长≈24s', Math.abs(plan.expectedDuration - 24) < 1.2, `exp=${plan.expectedDuration}`);

    const out = join(DIR, '.merge_out.mp4');
    const r = await mergeClips(clips, plan, { output: out });
    check('无损合并成功', r.ok && r.strategy === 'copy', (r.reasons || []).join('；'));
    if (r.ok) {
      const info = summarize((await ffprobe(out)).raw);
      check('合并产物时长 23–25s', info.duration > 23 && info.duration < 25, `dur=${info?.duration}`);
      check('合并产物含音视频', !!info.video && !!info.audio);
      check('合并产物可解码', (await run(FFMPEG, ['-v', 'error', '-i', out, '-f', 'null', '-'], { timeout: 120000 })).code === 0);
    }
    check('合并未改动任何源片段', (await sha(a)) === ha && (await sha(b)) === hb);

    // The output must never collide with an input, including case-insensitive
    // filesystems where A.mp4 and a.mp4 are one file.
    const guard = await mergeClips(clips, plan, { output: a.toUpperCase() });
    check('输出指向输入时拒绝执行', !guard.ok, (guard.reasons || []).join('；'));

    // ---- product naming contract ----
    // Once sources go to the trash the name is the only trace left, so these
    // rules are behaviour, not cosmetics.
    const nd = join(DIR, '.naming');
    await mkdir(nd, { recursive: true });
    const clipA = join(nd, 'GX010001.MP4');
    await copyFile(base, clipA);

    const n1 = await defaultOutput(clipA, 'mp4');
    check('默认产物落在源片段所在文件夹', n1 === join(nd, 'GX010001_merged.mp4'), n1);
    check('单任务不带任务号', !/_t\d\d/.test(n1), n1);
    check('产物名可被扫描识别', isMergeProduct(n1), n1);

    const n2 = await defaultOutput(clipA, 'mp4', { index: 1, total: 3 });
    check('队列任务号两位补零', n2.endsWith('GX010001_merged_t02.mp4'), n2);

    await writeFile(n2, 'x');
    const n3 = await defaultOutput(clipA, 'mp4', { index: 1, total: 3 });
    check('撞名用短横线序号而非括号', n3.endsWith('GX010001_merged_t02-2.mp4'), n3);
    check('带撞名序号仍是产物名', isMergeProduct(n3), n3);

    check('产物再合并不叠加后缀',
      (await defaultOutput(n3, 'mp4')).endsWith('GX010001_merged.mp4'),
      await defaultOutput(n3, 'mp4'));

    const weird = join(nd, 'a:b*c?.mp4');
    const n4 = await defaultOutput(weird, 'mp4');
    check('非法字符被替换成下划线', !/[:*?"<>|]/.test(n4.split('/').pop()), n4);

    const n5 = await defaultOutput(join(nd, `${'长'.repeat(80)}.mp4`), 'mp4');
    check('超长名被截断到安全字节数', Buffer.byteLength(n5.split('/').pop()) <= 200,
      `${Buffer.byteLength(n5.split('/').pop())} 字节`);

    // ---- custom product names ----
    check('重命名不必写后缀', normalizeOutputName('火辣青春小美', 'mp4') === '火辣青春小美.mp4',
      normalizeOutputName('火辣青春小美', 'mp4'));
    check('手写后缀一律被方案后缀覆盖', normalizeOutputName('火辣青春小美.avi', 'mp4') === '火辣青春小美.mp4',
      normalizeOutputName('火辣青春小美.avi', 'mp4'));
    check('手写大小写后缀也被覆盖', normalizeOutputName('clip.MOV', 'mkv') === 'clip.mkv',
      normalizeOutputName('clip.MOV', 'mkv'));
    check('普通文件名不被误当产物', !isMergeProduct('holiday-2.mp4') && !isMergeProduct('a.mp4'));

    const bare = await resolveOutput('我的合并', clipA, 'mp4');
    check('裸名落在源文件夹', bare === join(nd, '我的合并.mp4'), bare);
    const explicit = await resolveOutput('/tmp/explicit.avi', clipA, 'mkv');
    check('显式绝对路径保留目录并覆盖后缀', explicit === '/tmp/explicit.mkv', explicit);
    const relative = await resolveOutput('sub/clip.mp4', clipA, 'mp4');
    check('相对路径相对源文件夹解析', relative === join(nd, 'sub', 'clip.mp4'), relative);

    const small = join(DIR, '.merge_small.mp4');
    await run(FFMPEG, ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-ac', '1', small], { timeout: 60000 });

    const mixed = [await probeClip(a), await probeClip(small)];
    const mp = buildPlan(mixed, { mode: 'auto' });
    check('混合规格判定为重编码', mp.ok && mp.strategy === 'encode', `strategy=${mp.strategy}`);
    check('混合规格给出分辨率告警', (mp.warnings || []).some((w) => w.includes('分辨率')), (mp.warnings || []).join('|'));
    check('强制无损遇规格不一致时报错', !buildPlan(mixed, { mode: 'copy' }).ok);

    const mr = await mergeClips(mixed, mp, { output: join(DIR, '.merge_mixed.mp4') });
    check('重编码合并成功', mr.ok, (mr.reasons || []).join('；'));
    if (mr.ok) {
      const info = summarize((await ffprobe(mr.output)).raw);
      check('重编码产物统一为 640×360', info.video.width === 640 && info.video.height === 360,
        `${info.video.width}x${info.video.height}`);
      check('重编码产物保留音轨', !!info.audio);
    }
    for (const f of [a, b, small, out, join(DIR, '.merge_mixed.mp4')]) await rm(f, { force: true }).catch(() => {});
    await rm(nd, { recursive: true, force: true }).catch(() => {});
  }

  // ---------- merge queue ----------
  {
    const mk = (n, breaks = []) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, breakAfter: breaks.includes(i) }));
    const shape = (t) => t.map((g) => g.length).join('/');

    check('空清单切成 0 个任务', splitTasks([]).length === 0);
    check('无分割时只有 1 个任务', shape(splitTasks(mk(4))) === '4');
    check('单点分割切成 2 组', shape(splitTasks(mk(4, [1]))) === '2/2');
    check('多点分割按位置切分', shape(splitTasks(mk(5, [0, 2]))) === '1/2/2');
    check('末项分割被忽略', shape(splitTasks(mk(3, [2]))) === '3');
    check('连续分割产生 1 段任务', shape(splitTasks(mk(3, [0, 1]))) === '1/1/1');

    const fakeOut = join(DIR, '.qverify.mp4');
    await run(FFMPEG, ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', fakeOut], { timeout: 60000 });
    const okRes = { ok: true, level: 'clean', output: fakeOut, expected: 2, warnings: [] };

    const v1 = await verifyProduct(okRes, [{ duration: 2 }]);
    check('校验放行零告警的正常产物', v1.ok, v1.reason);
    check('合并失败一律不放行', !(await verifyProduct({ ok: false, reasons: ['x'] }, [])).ok);
    check('有告警的产物不放行', !(await verifyProduct({ ...okRes, level: 'degraded', warnings: ['时长偏差'] }, [{ duration: 2 }])).ok);
    check('产物不存在不放行', !(await verifyProduct({ ...okRes, output: join(DIR, '.nope.mp4') }, [])).ok);
    check('缺少输出路径不放行', !(await verifyProduct({ ok: true, level: 'clean', output: null }, [])).ok);
    check('时长偏差超限不放行', !(await verifyProduct({ ...okRes, expected: 20 }, [{ duration: 20 }])).ok);

    // trashSources with an injected fake trash: proves the guards without
    // touching a single real file.
    const src = ['.q1.mp4', '.q2.mp4', '.q3.mp4'].map((n) => join(DIR, n));
    for (const f of src) await writeFile(f, 'x');
    const tr = await trashSources(src, { trash: async () => true, output: src[0], allowed: src });
    check('输出文件被排除在删除之外', !tr.deleted.includes(src[0]) && tr.deleted.length === 2);
    const outsider = join(DIR, '.qoutsider.mp4');
    await writeFile(outsider, 'x');
    const trOut = await trashSources([outsider], { trash: async () => true, allowed: src });
    check('白名单外的路径不被删除', trOut.deleted.length === 0);
    for (const f of [...src, outsider]) await rm(f, { force: true }).catch(() => {});

    let calls = 0;
    const many = Array.from({ length: 11 }, (_, i) => join(DIR, `.qb${i}.mp4`));
    for (const f of many) await writeFile(f, 'x');
    const tb = await trashSources(many, { trash: async () => { calls++; return true; }, allowed: many, maxBatch: 10 });
    check('超过一批的文件全部处理', tb.deleted.length === 11 && calls === 11, `${tb.deleted.length}/${calls}`);
    const dirRes = await trashSources([DIR], { trash: async () => true, allowed: [DIR] });
    check('目录不会被当作文件删除', dirRes.deleted.length === 0 && dirRes.failed.length === 1);
    for (const f of many) await rm(f, { force: true }).catch(() => {});

    // Delete failures must carry a reason all the way to the result card.
    const fx = join(DIR, '.qfail.mp4');
    await writeFile(fx, 'x');
    const fr = await trashSources([fx], {
      trash: async () => ({ ok: false, reason: '跨卷移动失败：EXDEV' }),
      allowed: [fx],
    });
    check('删除失败原因被上报', fr.failed[0]?.reason === '跨卷移动失败：EXDEV', JSON.stringify(fr.failed));
    await rm(fx, { force: true }).catch(() => {});

    // The trash must be chosen on the file's own volume: ~/.Trash is on a
    // different device from an external disk and would throw EXDEV.
    const volStat = await stat('/Volumes/Steven').catch(() => null);
    if (volStat) {
      const vd = await trashDirFor('/Volumes/Steven/some/file.mp4', volStat);
      check('外置卷使用卷内 .Trashes/<uid>', vd?.startsWith('/Volumes/Steven/.Trashes/'), String(vd));
    }
    const homeStat = await stat(DIR).catch(() => null);
    if (homeStat) {
      const hd = await trashDirFor(join(DIR, 'x.mp4'), homeStat);
      check('启动盘文件仍用 ~/.Trash', hd?.endsWith('/.Trash'), String(hd));
    }
    check('文件不存在时给出明确原因',
      (await moveToTrash(join(DIR, '.no-such-file.mp4'), { finder: async () => ({ ok: false, reason: 'x' }) })).reason === '文件不存在');

    await rm(fakeOut, { force: true }).catch(() => {});
  }

  console.log('\n=== 10. 前导零剥离 / 诊断缓存 ===');
  {
    const src = join(DIR, 'healthy.mp4');
    const raw = await readFile(src);

    // A long zero prefix before a valid MP4 must be reported as LEADING_ZEROS
    // with the exact offset, so repair can strip it instead of giving up.
    const zMp4 = join(DIR, '.leading_zero.mp4');
    const zHead = Buffer.alloc(2 * 1024 * 1024);
    await writeFile(zMp4, Buffer.concat([zHead, raw]));
    const zs = await findDataStart(zMp4);
    check('前导零 MP4 定位到真实容器起点', zs?.offset === zHead.length, JSON.stringify(zs));
    const zd = await diagnose(zMp4);
    check('前导零 MP4 命中 LEADING_ZEROS', zd.problems.some((p) => p.code === 'LEADING_ZEROS'), zd.problems.map((p) => p.code).join(','));

    // Containerless Annex-B (the real interrupted-download pattern from the
    // repair log) must also be detected, and raw-stream recovery must work on
    // it without an mdat box to anchor on.
    const annex = join(DIR, '.annexb.h264');
    const conv = await run(FFMPEG, ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-c:v', 'copy',
      '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', annex], { timeout: 120000 });
    if (conv.code === 0) {
      const aHead = Buffer.alloc(256 * 1024);
      const zAnnex = join(DIR, '.leading_zero_annexb.mp4');
      await writeFile(zAnnex, Buffer.concat([aHead, await readFile(annex)]));
      const as = await findDataStart(zAnnex);
      check('前导零裸流定位到首个 Annex-B start code', as?.offset === aHead.length, JSON.stringify(as));
      const work = await mkdtemp(join(tmpdir(), 'vrep-lz-'));
      const logs = [];
      let out = null;
      try {
        out = await tryRawStream(zAnnex, work, null, (m) => logs.push(m), () => {});
      } catch (e) { logs.push(String(e)); }
      check('纯 Annex-B（无 mdat）可裸流恢复', !!out, logs.slice(-2).join(' | '));
      if (out) {
        const info = summarize((await ffprobe(out)).raw);
        check('前导零裸流恢复出可探测视频', !!info?.video, `dur=${info?.duration}`);
      }
      await rm(work, { recursive: true, force: true }).catch(() => {});
      await rm(zAnnex, { force: true }).catch(() => {});
      await rm(annex, { force: true }).catch(() => {});
    }
    for (const f of [zMp4]) await rm(f, { force: true }).catch(() => {});

    // Diagnosis cache: unchanged file hits, explicit invalidation misses, and
    // a changed file can never serve a stale verdict.
    clearDiagnosisCache();
    const cfile = join(DIR, '.cache_test.mp4');
    await writeFile(cfile, raw);
    const first = await cachedDiagnose(cfile);
    const second = await cachedDiagnose(cfile);
    check('首次诊断为未命中缓存', first.cached !== true);
    check('未变化文件第二次命中诊断缓存', second.cached === true && second.verdict === first.verdict);
    check('缓存 attach 了 age 信息', Number.isFinite(second.cacheAgeMs));
    invalidateDiagnosis(cfile);
    check('失效后重新诊断', (await cachedDiagnose(cfile)).cached !== true);
    await writeFile(cfile, Buffer.concat([raw, Buffer.from([0])]));
    check('文件内容变化后不使用旧缓存', (await cachedDiagnose(cfile)).cached !== true);
    check('缓存容量受控', diagnosisCacheStats().entries <= diagnosisCacheStats().max);
    await rm(cfile, { force: true }).catch(() => {});
    clearDiagnosisCache();
  }

  console.log('\n=== 11. 平台抽象层 / Windows 脚本 ===');
  {
    const plat = await import('../lib/platform.mjs');
    const winPlat = await import('../lib/platform-win.mjs');
    const { moveToTrash: trashMove } = await import('../lib/trash.mjs');

    check('平台后端被正确识别', ['mac', 'win', 'unsupported'].includes(plat.activeBackend), plat.activeBackend);
    check('桌面平台提供原生选择器', plat.nativePickerAvailable() === (process.platform === 'darwin' || process.platform === 'win32'));
    check('五个平台接口齐全', ['pickFolder', 'pickFiles', 'pickSave', 'reveal', 'moveToTrash']
      .every((k) => typeof plat[k] === 'function'));
    if (plat.activeBackend === 'mac') {
      check('macOS 回收站实现接入平台层', plat.moveToTrash === trashMove);
    }

    const scripts = Object.entries(winPlat.SCRIPTS)
      .map(([k, v]) => [k, typeof v === 'function' ? v(true) : v]);
    const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
    check('Windows 脚本为纯 ASCII（避免 OEM 代码页乱码）', scripts.every(([, s]) => isAscii(s)),
      scripts.filter(([, s]) => !isAscii(s)).map(([k]) => k).join(','));
    check('Windows 脚本强制 UTF-8 输出', scripts.every(([, s]) => s.includes('[System.Text.Encoding]::UTF8')));
    check('选择文件夹使用 FolderBrowserDialog', winPlat.SCRIPTS.pickFolder.includes('FolderBrowserDialog'));
    check('多选文件使用 OpenFileDialog + Multiselect',
      /OpenFileDialog/.test(winPlat.SCRIPTS.pickFiles(true)) && winPlat.SCRIPTS.pickFiles(true).includes('$true'));
    check('单选文件关闭 Multiselect', winPlat.SCRIPTS.pickFiles(false).includes('$false'));
    check('保存对话框使用 SaveFileDialog', winPlat.SCRIPTS.pickSave.includes('SaveFileDialog'));
    check('三个选择器脚本都有独立取消标记',
      [winPlat.SCRIPTS.pickFolder, winPlat.SCRIPTS.pickFiles(true), winPlat.SCRIPTS.pickSave]
        .every((s) => s.includes('__VT_CANCEL__')));
    check('定位使用资源管理器 /select', winPlat.SCRIPTS.reveal.includes('/select,'));
    check('删除走回收站而非永久删除',
      winPlat.SCRIPTS.trash.includes('SendToRecycleBin') && !winPlat.SCRIPTS.trash.includes('Remove-Item'));
    check('删除后验证源文件已消失', winPlat.SCRIPTS.trash.includes('Test-Path -LiteralPath'));
    check('用户数据只从环境变量读取', scripts.every(([, s]) => /\$env:VTOOL_/.test(s)));
    check('脚本中不出现中文路径字面量', scripts.every(([, s]) => !/[一-龥]/.test(s)));
  }

  console.log(`\n=== 结果： ${pass} 通过, ${fail} 失败 ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });