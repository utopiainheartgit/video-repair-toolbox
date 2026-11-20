import { open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffprobe, summarize, inspectBoxes } from './probe.mjs';

// A minimal, universally accepted 32-byte ftyp. Matches what most muxers write
// for an H.264/AAC MP4, so sample offsets computed against it stay valid.
const FTYP_ISOM = Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex');

async function copyWithPrefix(src, dest, prefix) {
  const rs = await openFile(src, 'r');
  const ws = await openFile(dest, 'w');
  try {
    await ws.write(prefix);
    const { size } = await rs.stat();
    const CHUNK = 4 * 1024 * 1024;
    let pos = 0;
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await rs.read(buf, 0, len, pos);
      if (!bytesRead) break;
      await ws.write(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await rs.close();
    await ws.close();
  }
}

// Head-truncation surgery, conservative case: the front ftyp was cut away
// whole, but mdat and moov survived intact. Every absolute sample offset in
// moov is then exactly one ftyp too large, so prepending a synthetic ftyp puts
// them back in register. We verify by probing the result; if it does not open,
// we return null and let the other strategies run.
export async function tryHeadFix(src, work, log) {
  const boxes = await inspectBoxes(src);
  if (!boxes.ok) return null;
  const types = boxes.boxes.map((b) => b.type);
  if (!types.includes('moov') || types.includes('ftyp')) return null;

  const first = boxes.boxes[0];
  if (!first || first.start !== 0) return null;
  if (!['mdat', 'free', 'skip', 'wide'].includes(first.type)) {
    log(`头部修复：首块是 ${first.type}，跳过（可能还有其他损坏）`);
    return null;
  }

  log('检测到头部缺 ftyp、而 mdat 与 moov 完整：补合成 ftyp 头');
  const out = join(work, 'headfixed.mp4');
  await copyWithPrefix(src, out, FTYP_ISOM);

  const p = await ffprobe(out);
  if (!p.ok) { log('补 ftyp 后仍无法解析，放弃该路径'); return null; }
  const info = summarize(p.raw);
  if (!info?.video) { log('补 ftyp 后无视频流，放弃该路径'); return null; }
  log(`补 ftyp 成功：时长 ${info.duration.toFixed(2)}s`);
  return out;
}
