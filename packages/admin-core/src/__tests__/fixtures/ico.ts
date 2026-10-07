// SPDX-License-Identifier: MPL-2.0

/**
 * A minimal, structurally valid 16x16 32-bit ICO built in memory, so the
 * favicon tests need no binary fixture in the repo. Layout: ICONDIR
 * (6 bytes) + one ICONDIRENTRY (16) + a BMP image (BITMAPINFOHEADER, the
 * XOR pixel rows and the 1-bit AND mask; the BMP height is doubled per
 * the ICO convention). The first four bytes are the ICO magic 00 00 01 00.
 */
export function minimalIco(): Uint8Array {
  const size = 16;
  const pixels = size * size * 4;
  const mask = size * 4; // 1 bpp rows padded to 32 bits
  const image = 40 + pixels + mask;
  const out = new Uint8Array(6 + 16 + image);
  const v = new DataView(out.buffer);
  // ICONDIR: reserved 0, type 1 (icon), count 1.
  v.setUint16(2, 1, true);
  v.setUint16(4, 1, true);
  // ICONDIRENTRY: width, height, colours 0, reserved 0, planes 1, 32 bpp, size, offset.
  out[6] = size;
  out[7] = size;
  v.setUint16(10, 1, true);
  v.setUint16(12, 32, true);
  v.setUint32(14, image, true);
  v.setUint32(18, 22, true);
  // BITMAPINFOHEADER: header size, width, doubled height, planes, bpp, image size.
  v.setUint32(22, 40, true);
  v.setInt32(26, size, true);
  v.setInt32(30, size * 2, true);
  v.setUint16(34, 1, true);
  v.setUint16(36, 32, true);
  v.setUint32(42, pixels + mask, true);
  // Opaque pixels (BGRA); the AND mask stays zero, i.e. every pixel visible.
  for (let i = 0; i < size * size; i++) out.set([0xd0, 0x60, 0x20, 0xff], 62 + i * 4);
  return out;
}
