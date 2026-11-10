// SPDX-License-Identifier: MPL-2.0

/** #1271 — the generator's stdout as whole lines (stdout-lines.ts). */

import { heapStats } from "bun:jsc";
import { describe, expect, it } from "bun:test";
import { LineSplitter } from "../stdout-lines.js";

/** Feed `chunks` through one splitter; the lines it handed on. */
function linesOf(chunks: readonly Buffer[]): string[] {
  const splitter = new LineSplitter();
  const out: string[] = [];
  for (const c of chunks) splitter.push(c, (line) => out.push(line));
  return out;
}

describe("LineSplitter", () => {
  it("hands on every line a chunk ends, and keeps the rest for the next chunk", () => {
    expect(
      linesOf([Buffer.from('{"a":1}\n{"b"'), Buffer.from(":2}\n\n"), Buffer.from('{"c":3}')]),
    ).toEqual(['{"a":1}', '{"b":2}', ""]);
  });

  it("joins a line that spans many chunks", () => {
    const line = "x".repeat(10_000);
    const chunks: Buffer[] = [];
    const bytes = Buffer.from(`${line}\n`);
    for (let at = 0; at < bytes.length; at += 64) chunks.push(bytes.subarray(at, at + 64));
    expect(linesOf(chunks)).toEqual([line]);
  });

  it("decodes a character split across two chunks whole", () => {
    // The old string buffer decoded each chunk on its own: two U+FFFD.
    const bytes = Buffer.from('{"title":"Größe"}\n');
    const cut = bytes.indexOf(Buffer.from("ö")) + 1;
    expect(linesOf([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(['{"title":"Größe"}']);
  });

  it("keeps nothing of a line once its handler returned", () => {
    // A streamed file's line (24 MiB of base64 here), in 64 KiB chunks as
    // the pipe delivers them, then the next event's start.
    const size = 24 * 1024 * 1024;
    const splitter = new LineSplitter();
    let seen = 0;
    const live = (): number => {
      Bun.gc(true);
      return heapStats().heapSize;
    };
    const before = live();
    {
      const bytes = Buffer.alloc(size + 1, "QUJD");
      bytes[size] = 0x0a;
      for (let at = 0; at < bytes.length; at += 65_536) {
        // A copy per chunk, like a pipe read: nothing shares the big buffer.
        splitter.push(Buffer.from(bytes.subarray(at, at + 65_536)), (line) => {
          seen = line.length;
        });
      }
    }
    splitter.push(Buffer.from('{"kind":"pro'), () => undefined);
    expect(seen).toBe(size);
    expect(live() - before).toBeLessThan(1024 * 1024);
  });
});
