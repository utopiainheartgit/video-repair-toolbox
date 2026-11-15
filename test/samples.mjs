import { readFile, writeFile, truncate, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectBoxes } from '../lib/probe.mjs';

const DIR = join(import.meta.dirname, '..', 'testdata');

export async function makeSamples() {
  await mkdir(DIR, { recursive: true });

  const moovEnd = join(DIR, 'moov_at_end.mp4');
  const boxes = await inspectBoxes(moovEnd);
  const moov = boxes.boxes.find((b) => b.type === 'moov');
  if (!moov) throw new Error('moov_at_end.mp4 缺少 moov，无法生成截断样本');
  const trunc = join(DIR, 'truncated.mp4');
  await copyFile(moovEnd, trunc);
  await truncate(trunc, Math.floor(moov.start * 0.9));

  const healthy = await readFile(join(DIR, 'healthy.mp4'));
  const hb = await inspectBoxes(join(DIR, 'healthy.mp4'));
  const mdat = hb.boxes.find((b) => b.type === 'mdat');
  const corrupt = Buffer.from(healthy);
  for (let i = 0; i < 400; i++) {
    corrupt[mdat.start + 8 + Math.floor((mdat.size - 16) * (i / 400))] ^= 0xff;
  }
  await writeFile(join(DIR, 'corrupt.mp4'), corrupt);

  const avi = await readFile(join(DIR, 'noindex.avi'));
  const idx = avi.indexOf(Buffer.from('idx1', 'latin1'));
  if (idx > 0) await writeFile(join(DIR, 'noindex.avi'), avi.subarray(0, idx));

  await writeFile(join(DIR, 'empty.mp4'), Buffer.alloc(0));
  await writeFile(join(DIR, 'notvideo.mp4'), 'this is not a video at all\n');

  return { truncSize: await (await import('node:fs/promises')).stat(trunc).then((s) => s.size) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await makeSamples();
  console.log('样本已重新生成', r);
}