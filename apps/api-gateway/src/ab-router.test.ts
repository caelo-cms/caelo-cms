// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pickVariant, VARIANT_SCRIPT } from "./ab-router.js";

describe("ab-router pickVariant", () => {
  const variants = [
    { label: "a", weight: 0.5 },
    { label: "b", weight: 0.5 },
  ];

  it("returns the same variant for the same visitor", () => {
    const v1 = pickVariant("visitor-1", "exp-1", variants);
    const v2 = pickVariant("visitor-1", "exp-1", variants);
    expect(v1).toBe(v2);
  });

  it("distributes ~50/50 across many visitors", () => {
    let aCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const v = pickVariant(`visitor-${i}`, "exp-1", variants);
      if (v === "a") aCount += 1;
    }
    const ratio = aCount / N;
    // Within 10pp of 50/50.
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it("respects weights skewed 80/20", () => {
    const skewed = [
      { label: "a", weight: 0.8 },
      { label: "b", weight: 0.2 },
    ];
    let aCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (pickVariant(`visitor-${i}`, "skew", skewed) === "a") aCount += 1;
    }
    expect(aCount / N).toBeGreaterThan(0.7);
    expect(aCount / N).toBeLessThan(0.9);
  });

  it("returns null on empty variants", () => {
    expect(pickVariant("v", "e", [])).toBeNull();
  });
});

/**
 * #649 — the script ran its request off `document.cookie`, where the
 * HttpOnly visitor cookie never appears, so a real browser never asked
 * for a variant. These run the served script against a browser-shaped
 * stub in which the visitor cookie is invisible, as it is in a browser.
 */
describe("VARIANT_SCRIPT", () => {
  interface Call {
    url: string;
    init: RequestInit | undefined;
  }

  function runScript(variantFile: { status: number; html: string }): {
    calls: Call[];
    main: { replacedWith: unknown };
    settle: () => Promise<void>;
  } {
    const calls: Call[] = [];
    const main = {
      replacedWith: null as unknown,
      replaceWith(n: unknown) {
        main.replacedWith = n;
      },
    };
    const doc = {
      currentScript: {
        getAttribute: (name: string) =>
          ({ "data-experiment": "hero-cta", "data-page": "/blog/spring" })[name] ?? null,
      },
      // What a page sees when the only cookie is HttpOnly.
      cookie: "",
      querySelector: (sel: string) => (sel === "main" ? main : null),
      body: main,
    };
    const fetchStub = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("/api/variant/assign")) {
        return new Response(JSON.stringify({ ok: true, data: { variant: "b" } }));
      }
      return new Response(variantFile.html, { status: variantFile.status });
    };
    class DOMParserStub {
      parseFromString(html: string) {
        const node = { html };
        return { querySelector: () => node, body: node };
      }
    }
    new Function("document", "fetch", "DOMParser", VARIANT_SCRIPT)(doc, fetchStub, DOMParserStub);
    return {
      calls,
      main,
      settle: async () => {
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
      },
    };
  }

  it("asks the gateway for a variant without being able to read the visitor id", async () => {
    const run = runScript({ status: 200, html: "<main>variant b</main>" });
    await run.settle();
    const [assign] = run.calls;
    expect(assign?.url).toBe("/api/variant/assign?exp=hero-cta");
    expect(assign?.init?.method).toBe("POST");
    // The browser attaches the HttpOnly cookie only with credentials on.
    expect(assign?.init?.credentials).toBe("same-origin");
    // Nothing client-side may steer bucketing.
    expect(assign?.init?.body).toBeUndefined();
  });

  it("loads the assigned variant's page and swaps <main>", async () => {
    const run = runScript({ status: 200, html: "<main>variant b</main>" });
    await run.settle();
    expect(run.calls.map((c) => c.url)).toEqual([
      "/api/variant/assign?exp=hero-cta",
      "/_variants/hero-cta__b/blog/spring",
    ]);
    expect(run.main.replacedWith).toEqual({ html: "<main>variant b</main>" });
  });

  it("keeps the page as served when the variant file is missing", async () => {
    const run = runScript({ status: 404, html: "<main>Not found</main>" });
    await run.settle();
    expect(run.calls).toHaveLength(2);
    expect(run.main.replacedWith).toBeNull();
  });
});
