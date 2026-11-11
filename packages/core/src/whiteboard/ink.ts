// BSD-263: Tinten-Codec. Ein Strich (Punkte x, y, Druck) als kompakte Bytes: Koordinaten auf 1/10 px quantisiert,
// erster Punkt absolut (Int32), danach Differenzen als Int16, Druck als Byte (0…255). Sprünge über Int16 werden als
// Escape (-32768) mit absolutem Punkt geschrieben. Little Endian, Version im ersten Byte (künftige Formate lesbar
// ablehnen statt falsch deuten).
//   [0] Version = 1  [1..4] Anzahl Punkte (Uint32)  dann je Punkt: erster Punkt Int32 x, Int32 y, Uint8 p;
//   weitere Punkte Int16 dx, Int16 dy, Uint8 p  bzw. Escape Int16 -32768, Int32 x, Int32 y, Uint8 p.

export interface InkPoint { x: number; y: number; /** Druck 0…1 (ohne Stift 0.5). */ p: number }

export const INK_VERSION = 1;
/** Auflösung: Koordinaten in 1/10 px. */
export const INK_SCALE = 10;
const ESC = -32768;

const q = (v: number) => Math.round(v * INK_SCALE);
const qp = (p: number) => Math.max(0, Math.min(255, Math.round((Number.isFinite(p) ? p : 0.5) * 255)));

export function encodeInk(points: readonly InkPoint[]): Uint8Array {
  // Obergrenze: Kopf 5 + je Punkt höchstens 11 Bytes (Escape)
  const buf = new ArrayBuffer(5 + points.length * 11);
  const v = new DataView(buf);
  v.setUint8(0, INK_VERSION);
  v.setUint32(1, points.length, true);
  let o = 5, px = 0, py = 0;
  points.forEach((pt, i) => {
    const x = q(pt.x), y = q(pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 0x7fffffff || Math.abs(y) > 0x7fffffff) throw new RangeError("ink point out of range");
    const dx = x - px, dy = y - py;
    if (i === 0) {
      v.setInt32(o, x, true); v.setInt32(o + 4, y, true); o += 8;
    } else if (dx > ESC && dx <= 32767 && dy > ESC && dy <= 32767) {
      v.setInt16(o, dx, true); v.setInt16(o + 2, dy, true); o += 4;
    } else {
      v.setInt16(o, ESC, true); v.setInt32(o + 2, x, true); v.setInt32(o + 6, y, true); o += 10;
    }
    v.setUint8(o, qp(pt.p)); o += 1;
    px = x; py = y;
  });
  return new Uint8Array(buf, 0, o).slice();
}

export class InkFormatError extends Error {}

export function decodeInk(bytes: Uint8Array): InkPoint[] {
  if (bytes.length < 5) throw new InkFormatError("ink data too short");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint8(0);
  if (version !== INK_VERSION) throw new InkFormatError(`ink format ${version} needs a newer version of Based`);
  const n = v.getUint32(1, true);
  const out: InkPoint[] = [];
  let o = 5, x = 0, y = 0;
  const need = (k: number) => { if (o + k > bytes.length) throw new InkFormatError("ink data truncated"); };
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      need(9); x = v.getInt32(o, true); y = v.getInt32(o + 4, true); o += 8;
    } else {
      need(5);
      const dx = v.getInt16(o, true);
      if (dx === ESC) { need(11); x = v.getInt32(o + 2, true); y = v.getInt32(o + 6, true); o += 10; }
      else { x += dx; y += v.getInt16(o + 2, true); o += 4; }
    }
    out.push({ x: x / INK_SCALE, y: y / INK_SCALE, p: v.getUint8(o) / 255 });
    o += 1;
  }
  return out;
}
