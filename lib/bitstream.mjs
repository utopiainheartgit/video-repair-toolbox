// Bit-level parsing for H.264 / HEVC.
//
// The raw-stream walk reads a length prefix and steps over that many bytes. In
// damaged data a run of noise often yields a plausible-looking length, so a
// walk that trusts it steps into the middle of a frame and keeps going, turning
// the rest of the stream into junk. Here we parse the slice header behind each
// length and check it against the stream's own parameter sets. A position that
// is not the start of a picture is rejected on the spot, so the walk stays on
// the rails through noise.

const H264_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

class BitReader {
  constructor(buf) { this.b = buf; this.bit = 0; }
  get left() { return this.b.length * 8 - this.bit; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.bit >> 3];
      if (byte === undefined) throw new Error('bitstream eof');
      v = (v << 1) | ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.left > 0 && this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw new Error('ue overflow');
    }
    if (zeros === 0) return 0;
    return (2 ** zeros - 1) + this.u(zeros);
  }
  se() {
    const k = this.ue();
    return (k & 1) ? (k + 1) / 2 : -(k / 2);
  }
}

// Strip H.264/H.265 emulation-prevention bytes (00 00 03 -> 00 00). Only the
// 03 that precedes a byte <= 0x03 is an escape; anything else is payload.
export function unescapeRbsp(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0, zeros = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (zeros >= 2 && b === 0x03 && (i + 1 >= buf.length || buf[i + 1] <= 0x03)) { zeros = 0; continue; }
    out[n++] = b;
    if (b === 0) zeros++; else zeros = 0;
  }
  return out.subarray(0, n);
}

function skipScalingList(br, size) {
  let last = 8, next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      const delta = br.se();
      next = (last + delta + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

// Parse the fields we need to validate slices: frame size, frame_num and POC
// bit widths. Anything we cannot read cleanly is reported as ok:false and the
// caller falls back to the weaker checks.
export function parseSpsH264(nal) {
  try {
    if (nal.length < 5) return { ok: false };
    const br = new BitReader(unescapeRbsp(nal.subarray(1)));
    const profileIdc = br.u(8);
    br.u(8);
    br.u(8);
    br.ue();
    let chromaFormatIdc = 1, separateColourPlane = false;
    if (H264_HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = br.ue();
      if (chromaFormatIdc === 3) separateColourPlane = br.u(1) === 1;
      br.ue();
      br.ue();
      br.u(1);
      if (br.u(1)) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) if (br.u(1)) skipScalingList(br, i < 6 ? 16 : 64);
      }
    }
    const log2MaxFrameNum = br.ue() + 4;
    const pocType = br.ue();
    let log2MaxPocLsb = 0;
    if (pocType === 0) log2MaxPocLsb = br.ue() + 4;
    else if (pocType === 1) {
      br.u(1);
      br.se();
      br.se();
      const n = br.ue();
      for (let i = 0; i < n; i++) br.se();
    }
    br.ue();
    br.u(1);
    const widthMbsMinus1 = br.ue();
    const heightMapUnitsMinus1 = br.ue();
    const frameMbsOnly = br.u(1) === 1;
    if (!frameMbsOnly) br.u(1);
    br.u(1);
    if (br.u(1)) { br.ue(); br.ue(); br.ue(); br.ue(); }
    const width = (widthMbsMinus1 + 1) * 16;
    const height = (2 - (frameMbsOnly ? 1 : 0)) * (heightMapUnitsMinus1 + 1) * 16;
    return {
      ok: true, profileIdc, chromaFormatIdc, separateColourPlane,
      log2MaxFrameNum, pocType, log2MaxPocLsb, frameMbsOnly,
      width, height, mbsInFrame: (widthMbsMinus1 + 1) * (heightMapUnitsMinus1 + 1),
    };
  } catch { return { ok: false }; }
}

export function parsePpsH264(nal) {
  try {
    if (nal.length < 2) return { ok: false };
    const br = new BitReader(unescapeRbsp(nal.subarray(1)));
    const ppsId = br.ue();
    const spsId = br.ue();
    const entropyCodingMode = br.u(1) === 1;
    const bottomFieldPicOrderInFramePresent = br.u(1) === 1;
    const numSliceGroupsMinus1 = br.ue();
    if (numSliceGroupsMinus1 > 0) {
      // Slice group maps make the rest of the header impractical to walk; keep
      // the fields we have and mark it unusable for deeper checks.
      return { ok: true, ppsId, spsId, entropyCodingMode, bottomFieldPicOrderInFramePresent, numSliceGroupsMinus1, usable: false };
    }
    br.ue();
    br.ue();
    br.u(1);
    br.u(2);
    br.se();
    br.se();
    br.se();
    br.u(1);
    br.u(1);
    const redundantPicCntPresent = br.u(1) === 1;
    return {
      ok: true, ppsId, spsId, entropyCodingMode, bottomFieldPicOrderInFramePresent,
      redundantPicCntPresent, numSliceGroupsMinus1: 0, usable: true,
    };
  } catch { return { ok: false }; }
}

// Slice header: read first_mb_in_slice, slice_type and pic_parameter_set_id,
// then frame_num when the SPS is known. These four fields agreeing with the
// declared geometry is rare on random bytes.
export function parseSliceH264(nal, ctx) {
  const type = nal[0] & 0x1f;
  if (type !== 1 && type !== 5) return { ok: false };
  try {
    const br = new BitReader(unescapeRbsp(nal.subarray(1)));
    const firstMb = br.ue();
    const sliceType = br.ue();
    const ppsId = br.ue();
    if (sliceType > 9 || ppsId > 255) return { ok: false };
    const sps = ctx.sps;
    if (sps?.ok && firstMb >= sps.mbsInFrame) return { ok: false };
    const pps = ctx.ppsMap.get(ppsId);
    // Once we have seen at least one PPS, a slice naming an unknown one is a
    // strong sign the walk is misaligned.
    if (!pps && ctx.ppsMap.size > 0) return { ok: false };
    let frameNum = null, pocLsb = null;
    if (sps?.ok) {
      if (sps.separateColourPlane) br.u(2);
      frameNum = br.u(sps.log2MaxFrameNum);
      if (frameNum >= 2 ** sps.log2MaxFrameNum) return { ok: false };
      const fieldPic = !sps.frameMbsOnly ? br.u(1) === 1 : false;
      if (!sps.frameMbsOnly && fieldPic) br.u(1);
      if (type === 5) br.ue();
      if (sps.pocType === 0) {
        pocLsb = br.u(sps.log2MaxPocLsb);
        if (pps?.usable && pps.bottomFieldPicOrderInFramePresent && !fieldPic) br.se();
      }
    }
    return { ok: true, firstMb, sliceType, ppsId, frameNum, pocLsb, idr: type === 5, isNewFrame: firstMb === 0 };
  } catch { return { ok: false }; }
}

// HEVC slice headers depend on many flags spread across the SPS/PPS. We do a
// lightweight structural check: the first-slice flag plus a plausible PPS id.
export function parseSliceHevc(nal, ctx) {
  if (nal.length < 3) return { ok: false };
  const type = (nal[0] >> 1) & 0x3f;
  const isSlice = type <= 9 || (type >= 16 && type <= 21);
  if (!isSlice) return { ok: false };
  try {
    const br = new BitReader(unescapeRbsp(nal.subarray(2)));
    const firstSlice = br.u(1) === 1;
    if (type >= 16 && type <= 23) br.u(1);
    const ppsId = br.ue();
    if (ppsId > 63) return { ok: false };
    return { ok: true, firstSlice, ppsId, idr: type >= 16 && type <= 23, isNewFrame: firstSlice };
  } catch { return { ok: false }; }
}

export function createContext(codec) {
  return { codec, sps: null, ppsMap: new Map(), vps: null };
}

// Remember parameter sets as they come past so later slices have something to
// validate against. A damaged in-stream SPS is ignored rather than adopted, so
// noise cannot fabricate a geometry that makes every real frame fail. When a
// reference SPS is already loaded, an in-stream one that disagrees with it is
// almost certainly a misread from the audio region, so it is dropped too.
export function feedParamSet(ctx, nal) {
  if (!nal.length) return;
  if (ctx.codec === 'hevc') {
    const t = (nal[0] >> 1) & 0x3f;
    if (t === 32) ctx.vps = Buffer.from(nal);
    return;
  }
  const t = nal[0] & 0x1f;
  if (t === 7) {
    const s = parseSpsH264(nal);
    if (!s.ok) return;
    if (ctx.sps && (s.width !== ctx.sps.width || s.mbsInFrame !== ctx.sps.mbsInFrame)) return;
    ctx.sps = s;
  } else if (t === 8) {
    const p = parsePpsH264(nal);
    if (!p.ok) return;
    const known = ctx.ppsMap.get(p.ppsId);
    if (known?.usable && !p.usable) return;
    ctx.ppsMap.set(p.ppsId, p);
  }
}

export function validateSlice(nal, ctx) {
  return ctx.codec === 'hevc' ? parseSliceHevc(nal, ctx) : parseSliceH264(nal, ctx);
}
