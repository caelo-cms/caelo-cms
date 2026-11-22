// SPDX-License-Identifier: MPL-2.0

/**
 * Compact binary encoding for index files: unsigned LEB128 varints and
 * length-prefixed UTF-8 strings. Segment files are read in the browser-free
 * gateway and in jobs alike, so the format stays dependency-free.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A growable byte buffer that writes varints, strings and raw bytes. */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
  }

  /** Bytes written so far. */
  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Writes a non-negative integer below 2^53 as an unsigned LEB128 varint. */
  uint(value: number): void {
    if (!Number.isInteger(value) || value < 0)
      throw new RangeError(`uint: ${value} is not a non-negative integer`);
    this.ensure(8);
    let v = value;
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.len++] = v;
  }

  /** Writes raw bytes. */
  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  /** Writes a UTF-8 string, prefixed with its byte length. */
  string(value: string): void {
    const data = encoder.encode(value);
    this.uint(data.length);
    this.bytes(data);
  }

  /** Returns a copy of the written bytes. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Reads what {@link ByteWriter} wrote, in the same order. */
export class ByteReader {
  pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }

  /** True once every byte has been read. */
  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Reads an unsigned LEB128 varint. */
  uint(): number {
    let result = 0;
    let factor = 1;
    for (;;) {
      if (this.pos >= this.buf.length)
        throw new RangeError("uint: read past the end of the buffer");
      const byte = this.buf[this.pos++] as number;
      result += (byte & 0x7f) * factor;
      if (byte < 0x80) return result;
      factor *= 0x80;
    }
  }

  /** Returns a view of the next `length` bytes. */
  bytes(length: number): Uint8Array {
    if (this.pos + length > this.buf.length)
      throw new RangeError("bytes: read past the end of the buffer");
    const view = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return view;
  }

  /** Reads a length-prefixed UTF-8 string. */
  string(): string {
    return decoder.decode(this.bytes(this.uint()));
  }
}
