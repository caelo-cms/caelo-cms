// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  isSafeStagedLocation,
  isSafeStagedPath,
  nextStagingSlot,
  originRewritePairs,
  originRewriteStream,
  stagedKeysFor,
  stagedManifestSchema,
  stagingSlotLocation,
} from "./staged-site.js";

async function rewriteInChunks(text: string, sizes: number[]): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let at = 0;
  let i = 0;
  while (at < bytes.length) {
    const n = Math.max(1, sizes[i++ % sizes.length] ?? 1);
    chunks.push(bytes.slice(at, at + n));
    at += n;
  }
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const out = source.pipeThrough(
    originRewriteStream(originRewritePairs("https://example.com", "https://staging.example.com")),
  );
  return await new Response(out).text();
}

describe("#1330 originRewriteStream", () => {
  const page =
    '<a href="https://example.com/about/">x</a><script>{"u":"https:\\/\\/example.com\\/p"}</script> https://example.com https://example.community/ü€';
  const expected =
    '<a href="https://staging.example.com/about/">x</a><script>{"u":"https:\\/\\/staging.example.com\\/p"}</script> https://staging.example.com https://example.community/ü€';

  it("rewrites the live origin and its JSON-escaped form", async () => {
    expect(await rewriteInChunks(page, [100000])).toBe(expected);
  });

  it("rewrites a match split across any chunk boundary", async () => {
    for (const size of [1, 2, 3, 5, 7, 11, 18, 19, 20, 31]) {
      expect(await rewriteInChunks(page, [size])).toBe(expected);
    }
    expect(await rewriteInChunks(page, [3, 17, 1, 40, 2])).toBe(expected);
  });

  it("rewrites only whole origins", async () => {
    for (const size of [1, 4, 19, 20, 1000]) {
      expect(
        await rewriteInChunks("https://example.com:8443/ https://example.community", [size]),
      ).toBe("https://example.com:8443/ https://example.community");
      expect(await rewriteInChunks("x https://example.com", [size])).toBe(
        "x https://staging.example.com",
      );
    }
  });

  it("passes text without the origin through unchanged", async () => {
    expect(await rewriteInChunks("nothing to see", [4])).toBe("nothing to see");
    expect(await rewriteInChunks("", [4])).toBe("");
  });
});

describe("#1330 staged paths and locations", () => {
  it("maps request paths to manifest paths", () => {
    expect(stagedKeysFor("/")).toEqual(["index.html"]);
    expect(stagedKeysFor("/about/")).toEqual(["about/index.html"]);
    expect(stagedKeysFor("/about?x=1")).toEqual(["about", "about/index.html"]);
    expect(stagedKeysFor("/a/../b")).toBeNull();
    expect(stagedKeysFor("/%2e%2e/x")).toBeNull();
    expect(stagedKeysFor("/%E0%A4%A")).toBeNull();
  });

  it("refuses unsafe manifest paths and locations", () => {
    expect(isSafeStagedPath("about/index.html")).toBe(true);
    expect(isSafeStagedPath("../x")).toBe(false);
    expect(isSafeStagedPath("/x")).toBe(false);
    expect(isSafeStagedPath("a//b")).toBe(false);
    expect(isSafeStagedPath("a\\b")).toBe(false);
    expect(isSafeStagedLocation("_slots/a")).toBe(true);
    expect(isSafeStagedLocation("builds/0b7c0d6e-1111-4111-8111-111111111111")).toBe(true);
    expect(isSafeStagedLocation("_slots/../x")).toBe(false);
    expect(isSafeStagedLocation("/abs")).toBe(false);
  });

  it("alternates the slots", () => {
    expect(nextStagingSlot(null)).toBe("a");
    expect(nextStagingSlot(stagingSlotLocation("a"))).toBe("b");
    expect(nextStagingSlot(stagingSlotLocation("b"))).toBe("a");
  });

  it("refuses a manifest with a traversal path", () => {
    const base = {
      version: 1,
      runId: "0b7c0d6e-1111-4111-8111-111111111111",
      pageUrlStyle: "directory",
    };
    expect(
      stagedManifestSchema.safeParse({
        ...base,
        files: { "index.html": { type: "text/html", hash: "x" } },
      }).success,
    ).toBe(true);
    expect(
      stagedManifestSchema.safeParse({
        ...base,
        files: { "../etc/passwd": { type: "text/plain", hash: "x" } },
      }).success,
    ).toBe(false);
  });
});
