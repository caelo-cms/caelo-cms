// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { registryManifestReader } from "@caelo-cms/admin-core";
import { withFetchTimeout } from "./release-check.js";

/** A registry that accepts the request and never answers (until aborted). */
const stalledFetch = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("withFetchTimeout", () => {
  it("aborts a request the registry never answers", async () => {
    const started = Date.now();
    await expect(
      withFetchTimeout(stalledFetch, 30)("https://registry.test/v2/x"),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps a signal the caller passed", async () => {
    const caller = new AbortController();
    const pending = withFetchTimeout(stalledFetch, 60_000)("https://registry.test/v2/x", {
      signal: caller.signal,
    });
    caller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });

  it("passes headers through and answers when the registry does", async () => {
    let seen: RequestInit | undefined;
    const ok = withFetchTimeout(async (_url, init) => {
      seen = init;
      return new Response("{}", { status: 200 });
    }, 1_000);
    const res = await ok("https://registry.test/v2/x", { headers: { Accept: "a/b" } });
    expect(res.status).toBe(200);
    expect(seen?.headers).toEqual({ Accept: "a/b" });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a stalled registry into a 'could not read' answer for the release check", async () => {
    const read = registryManifestReader({ fetch: withFetchTimeout(stalledFetch, 30) });
    const r = await read("99.0.0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("registry unreachable");
  });
});
