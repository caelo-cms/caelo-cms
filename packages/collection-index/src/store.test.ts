// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyMissing,
  directoryStore,
  gcsStore,
  isStoreKey,
  scopedStore,
  storeFromUrl,
} from "./store.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

describe("store keys", () => {
  it("accepts plain relative paths only", () => {
    expect(isStoreKey("site-search/pages/t-abc.bin")).toBe(true);
    for (const bad of ["", "/abs", "a/../b", "a//b", "a\\b", "a/./b", "a\u0000b"])
      expect(isStoreKey(bad)).toBe(false);
  });
});

describe("directoryStore", () => {
  it("writes atomically, keeps immutable names, lists, deletes and refuses escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "caelo-store-"));
    const store = directoryStore(root);
    await store.write("p/c/a.bin", bytes("one"));
    await store.write("p/c/a.bin", bytes("two"), { immutable: true });
    expect(text(await store.read("p/c/a.bin"))).toBe("one");
    await store.write("p/c/a.bin", bytes("two"));
    expect(text(await store.read("p/c/a.bin"))).toBe("two");
    await store.write("p/c/sub/b.bin", bytes("b"));
    expect((await store.list("p/c")).sort()).toEqual(["p/c/a.bin", "p/c/sub/b.bin"]);
    expect(await store.has("p/c/missing")).toBe(false);
    expect(await store.readIfExists("p/c/missing")).toBeNull();
    await store.delete("p/c/a.bin");
    expect(await store.has("p/c/a.bin")).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), "caelo-outside-"));
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(root, "p", "link"));
    expect(await store.readIfExists("p/link")).toBeNull();
    await expect(store.read("../etc/passwd")).rejects.toThrow(/refused key/);
  });

  it("scopes a store to a prefix and copies only what the target lacks", async () => {
    const a = directoryStore(mkdtempSync(join(tmpdir(), "caelo-a-")));
    const b = directoryStore(mkdtempSync(join(tmpdir(), "caelo-b-")));
    const sa = scopedStore(a, "plug/coll");
    await sa.write("x.bin", bytes("x"));
    await sa.write("y.bin", bytes("y"));
    expect((await sa.list("")).length).toBe(0 + 2);
    expect(await copyMissing(a, b, ["plug/coll/x.bin", "plug/coll/y.bin"])).toBe(2);
    expect(await copyMissing(a, b, ["plug/coll/x.bin", "plug/coll/y.bin"])).toBe(0);
    expect(text(await b.read("plug/coll/y.bin"))).toBe("y");
  });
});

describe("gcsStore", () => {
  it("uses the JSON API with the instance token and treats an existing immutable name as written", async () => {
    const calls: { url: string; method: string; auth: string | null }[] = [];
    const fake: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization"),
      });
      if (url.includes("ifGenerationMatch=0")) return new Response("", { status: 412 });
      if (url.includes("alt=media") && url.includes("missing"))
        return new Response("", { status: 404 });
      if (url.includes("alt=media")) return new Response(bytes("data"));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const store = gcsStore("caelo-collections-live", "v1", async () => "tok", fake);
    expect(text(await store.read("p/c/a.bin"))).toBe("data");
    expect(await store.readIfExists("p/c/missing")).toBeNull();
    await store.write("p/c/a.bin", bytes("x"), { immutable: true });
    expect(calls[0]?.url).toBe(
      "https://storage.googleapis.com/storage/v1/b/caelo-collections-live/o/v1%2Fp%2Fc%2Fa.bin?alt=media",
    );
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls[2]?.method).toBe("POST");
    expect(() => gcsStore("Bad Bucket", "", async () => "t")).toThrow(/not a bucket/);
  });

  it("opens a store by URL", () => {
    expect(storeFromUrl("gs://b-1/pre/fix/").describe).toBe("gs://b-1/pre/fix");
    expect(storeFromUrl("file:///tmp/x").describe).toBe("/tmp/x");
    expect(() => storeFromUrl("s3://x")).toThrow(/neither/);
  });
});
