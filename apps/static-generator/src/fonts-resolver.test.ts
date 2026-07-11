// SPDX-License-Identifier: MPL-2.0

/**
 * issue #150 — font resolver unit coverage with an injected fetcher +
 * throwaway cache dir: resolve/cache/memo behaviour, per-family failure
 * isolation, and the system-stack no-op. Network is never touched.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThemeDocument } from "@caelo-cms/shared";
import { clearFontResolverMemo, resolveThemeFonts } from "./fonts-resolver.js";

const WOFF2_BYTES = new TextEncoder().encode("fake-woff2-bytes");

const CSS2_FIXTURE = (family: string) => `
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/x/${family.toLowerCase()}-400.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/x/${family.toLowerCase()}-700.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`;

function tokensWith(families: Record<string, string>): ThemeDocument {
  const typography: Record<string, unknown> = {};
  for (const [role, fontFamily] of Object.entries(families)) {
    typography[role] = { $type: "typography", $value: { fontFamily, fontWeight: 400 } };
  }
  return { typography } as unknown as ThemeDocument;
}

/** Fake fetch: css2 URLs → fixture CSS; gstatic URLs → bytes; records calls. */
function fakeFetcher(calls: string[], failFamilies: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    for (const fail of failFamilies) {
      if (url.includes(encodeURIComponent(fail).replace(/%20/g, "+"))) {
        return new Response("upstream down", { status: 503 });
      }
    }
    if (url.startsWith("https://fonts.googleapis.com/css2")) {
      const m = /family=([^:&]+)/.exec(url);
      const family = decodeURIComponent((m?.[1] ?? "").replace(/\+/g, " "));
      return new Response(CSS2_FIXTURE(family), { status: 200 });
    }
    if (url.startsWith("https://fonts.gstatic.com/")) {
      return new Response(WOFF2_BYTES, { status: 200 });
    }
    return new Response("unexpected url", { status: 404 });
  }) as typeof fetch;
}

let cacheDir: string;

beforeEach(async () => {
  clearFontResolverMemo();
  cacheDir = await mkdtemp(join(tmpdir(), "caelo-fonts-test-"));
});
afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

describe("resolveThemeFonts (issue #150)", () => {
  it("fetches, caches, and emits self-hosted css + preloads + files", async () => {
    const calls: string[] = [];
    const res = await resolveThemeFonts({
      tokens: tokensWith({ body: '"Poppins", sans-serif' }),
      cacheDir,
      publicBasePath: "/_assets/fonts",
      fetcher: fakeFetcher(calls),
    });
    expect(res.unresolved).toEqual([]);
    expect(res.css).toContain('font-family:"Poppins"');
    expect(res.css).toContain("font-display:swap");
    expect(res.css).toMatch(/url\(\/_assets\/fonts\/poppins\/[a-f0-9]{16}\.woff2\)/);
    expect(res.preloads).toHaveLength(1);
    expect(res.files).toHaveLength(2); // 400 + 700 faces
    // Bytes + manifest landed in the cache.
    const cached = await readdir(join(cacheDir, "poppins"));
    expect(cached.filter((f) => f.endsWith(".woff2"))).toHaveLength(2);
    expect(cached.some((f) => f.startsWith("manifest-"))).toBe(true);
    const bytes = await readFile(
      join(cacheDir, "poppins", cached.find((f) => f.endsWith(".woff2")) ?? ""),
    );
    expect(new TextDecoder().decode(bytes)).toBe("fake-woff2-bytes");
  });

  it("answers from the memo/disk cache without refetching", async () => {
    const calls: string[] = [];
    const args = {
      tokens: tokensWith({ body: "Poppins" }),
      cacheDir,
      publicBasePath: "/_caelo/fonts",
      fetcher: fakeFetcher(calls),
    };
    await resolveThemeFonts(args);
    const callsAfterFirst = calls.length;
    await resolveThemeFonts(args); // memo hit
    expect(calls.length).toBe(callsAfterFirst);

    clearFontResolverMemo(); // fresh process simulation → disk manifest hit
    await resolveThemeFonts(args);
    expect(calls.length).toBe(callsAfterFirst);
  });

  it("isolates per-family failures: broken family lands in unresolved, others resolve", async () => {
    const res = await resolveThemeFonts({
      tokens: tokensWith({ body: "Poppins", heading: "Playfair Display" }),
      cacheDir,
      publicBasePath: "/_assets/fonts",
      fetcher: fakeFetcher([], ["Playfair Display"]),
    });
    expect(res.unresolved).toEqual(["Playfair Display"]);
    expect(res.css).toContain("Poppins");
    expect(res.css).not.toContain("Playfair");
  });

  it("refuses font-file hosts outside the CDN allowlist (request-forgery pin)", async () => {
    const evilFetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://fonts.googleapis.com/css2")) {
        return new Response(
          "@font-face{font-family:'Poppins';font-style:normal;font-weight:400;src:url(https://evil.example/x.woff2) format('woff2');}",
          { status: 200 },
        );
      }
      return new Response(WOFF2_BYTES, { status: 200 });
    }) as typeof fetch;
    const res = await resolveThemeFonts({
      tokens: tokensWith({ body: "Poppins" }),
      cacheDir,
      publicBasePath: "/_assets/fonts",
      fetcher: evilFetcher,
    });
    expect(res.unresolved).toEqual(["Poppins"]);
    expect(res.css).toBe("");
  });

  it("is a no-op for system-stack-only themes", async () => {
    const calls: string[] = [];
    const res = await resolveThemeFonts({
      tokens: tokensWith({ body: "system-ui, sans-serif", mono: "Menlo, monospace" }),
      cacheDir,
      publicBasePath: "/_assets/fonts",
      fetcher: fakeFetcher(calls),
    });
    expect(res).toEqual({ css: "", preloads: [], files: [], unresolved: [] });
    expect(calls).toEqual([]);
  });
});
