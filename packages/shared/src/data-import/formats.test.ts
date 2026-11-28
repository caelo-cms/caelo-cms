// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  decodeDataFile,
  detectDataFileFormat,
  MAX_DATA_FILE_BYTES,
  parseDataFile,
} from "./formats.js";

function csv(text: string) {
  const r = parseDataFile(text, "csv");
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("CSV", () => {
  it("reads a header and rows", () => {
    const r = csv("sourceKey,authorName\nwp:1,Anna\nwp:2,Ben\n");
    expect(r.columns).toEqual(["sourceKey", "authorName"]);
    expect(r.records.map((x) => x.values)).toEqual([
      { sourceKey: "wp:1", authorName: "Anna" },
      { sourceKey: "wp:2", authorName: "Ben" },
    ]);
    expect(r.records[1]?.at).toBe("line 3");
  });

  it("keeps quotes, separators and line breaks inside quoted fields", () => {
    const r = csv('a,b\n"x, ""y""","line one\nline two"\n3,4');
    expect(r.records[0]?.values).toEqual({ a: 'x, "y"', b: "line one\nline two" });
    expect(r.records[1]?.values).toEqual({ a: "3", b: "4" });
    expect(r.records[1]?.at).toBe("line 4");
  });

  it("reads CRLF files and skips blank lines", () => {
    const r = csv("a,b\r\n1,2\r\n\r\n3,4\r\n");
    expect(r.records.map((x) => x.values)).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("takes the separator the header uses", () => {
    expect(csv("a;b\n1;2,5").records[0]?.values).toEqual({ a: "1", b: "2,5" });
    expect(csv("a\tb\n1\t2").records[0]?.values).toEqual({ a: "1", b: "2" });
  });

  it("reports a row with the wrong number of fields and keeps the others", () => {
    const r = csv("a,b\n1,2\n3\n4,5");
    expect(r.records).toHaveLength(2);
    expect(r.unreadable).toEqual([{ at: "line 3", detail: "has 1 fields, the header has 2" }]);
  });

  it("refuses an unclosed quote, a stray quote, and broken headers", () => {
    expect(parseDataFile('a,b\n"x,1', "csv")).toMatchObject({ ok: false });
    expect(parseDataFile('a,b\nx"y,1', "csv")).toMatchObject({ ok: false });
    expect(parseDataFile('a,b\n"x"y,1', "csv")).toMatchObject({ ok: false });
    expect(parseDataFile("a,,b\n1,2,3", "csv")).toMatchObject({ ok: false });
    expect(parseDataFile("a,a\n1,2", "csv")).toMatchObject({ ok: false });
    expect(parseDataFile("", "csv")).toMatchObject({ ok: false });
  });
});

describe("JSON Lines and JSON", () => {
  it("reads one object per line and reports bad lines", () => {
    const r = parseDataFile('{"a":1}\n\nnot json\n[1]\n{"b":"x"}', "jsonl");
    if (!r.ok) throw new Error(r.error);
    expect(r.columns).toEqual(["a", "b"]);
    expect(r.records.map((x) => x.at)).toEqual(["line 1", "line 5"]);
    expect(r.unreadable.map((x) => x.at)).toEqual(["line 3", "line 4"]);
  });

  it("reads an array of objects", () => {
    const r = parseDataFile('[{"a":1},{"a":2,"b":true},3]', "json");
    if (!r.ok) throw new Error(r.error);
    expect(r.records).toHaveLength(2);
    expect(r.unreadable).toEqual([{ at: "item 3", detail: "is not a JSON object" }]);
    expect(parseDataFile('{"a":1}', "json")).toMatchObject({ ok: false });
  });
});

describe("decoding and detection", () => {
  it("decodes UTF-8, drops a byte order mark, refuses other bytes", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62]);
    expect(decodeDataFile(bom)).toEqual({ ok: true, text: "a,b" });
    expect(decodeDataFile(new Uint8Array([0xff, 0xfe, 0x00]))).toMatchObject({ ok: false });
    expect(decodeDataFile(new Uint8Array([0x61, 0x00]))).toMatchObject({ ok: false });
    expect(decodeDataFile(new Uint8Array(0))).toMatchObject({ ok: false });
    expect(decodeDataFile(new Uint8Array(MAX_DATA_FILE_BYTES + 1))).toMatchObject({ ok: false });
  });

  it("detects the format from the name, else from the content", () => {
    expect(detectDataFileFormat("comments.csv", "a,b")).toBe("csv");
    expect(detectDataFileFormat("x.ndjson", "{}")).toBe("jsonl");
    expect(detectDataFileFormat("x.json", " [ ]")).toBe("json");
    expect(detectDataFileFormat("x.json", '{"a":1}\n{"a":2}')).toBe("jsonl");
    expect(detectDataFileFormat("export", "[{}]")).toBe("json");
    expect(detectDataFileFormat("export", "a,b")).toBeNull();
  });
});
