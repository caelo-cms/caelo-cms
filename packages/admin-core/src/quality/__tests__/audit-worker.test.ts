// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type ClaimedAuditRun,
  processClaimedRun,
  resolveStagingOrigin,
  stagedPageUrl,
  stagedUrlOfPage,
  toDisplayUrl,
} from "../audit-worker.js";
import { testCheckRegistry } from "../checks/__tests__/fixtures/test-checks.js";
import { sampleMetrics } from "./fixtures/sample-metrics.js";

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";

function run(overrides: Partial<ClaimedAuditRun> = {}): ClaimedAuditRun {
  return {
    auditRunId: "00000000-0000-4000-8000-0000000000bb",
    deployRunId: RUN_ID,
    performanceRuns: 3,
    pageUrlStyle: "directory",
    stagingLocation: null,
    stagingOrigin: null,
    env: "staging",
    outDir: "output/staging",
    pages: [
      { pageId: "00000000-0000-4000-8000-0000000000cc", currentPath: "/", isNotFoundPage: false },
    ],
    checkPages: [
      { pageId: "00000000-0000-4000-8000-0000000000cc", currentPath: "/", isNotFoundPage: false },
    ],
    ...overrides,
  };
}

describe("stagedUrlOfPage (#802)", () => {
  it("loads the designated 404 page from /404.html, never from its own path", () => {
    // Its own path answers 404 by design; auditing it there failed the
    // gate with Chrome's error interstitial.
    for (const style of ["directory", "no-extension"] as const) {
      expect(
        stagedUrlOfPage(
          "https://staging.example.com/",
          { currentPath: "/404", isNotFoundPage: true },
          style,
        ),
      ).toBe("https://staging.example.com/404.html");
    }
    expect(
      stagedUrlOfPage(
        "https://staging.example.com",
        { currentPath: "/pricing", isNotFoundPage: false },
        "directory",
      ),
    ).toBe("https://staging.example.com/pricing/");
  });
});

describe("stagedPageUrl", () => {
  it("matches the generator's directory layout (trailing slash, no redirect)", () => {
    expect(stagedPageUrl("https://staging.example.com/", "/", "directory")).toBe(
      "https://staging.example.com/",
    );
    expect(stagedPageUrl("https://staging.example.com", "/de/pricing", "directory")).toBe(
      "https://staging.example.com/de/pricing/",
    );
  });

  it("collapses trailing slashes on the origin and the path", () => {
    expect(stagedPageUrl(`https://s${"/".repeat(5000)}`, "/a///", "directory")).toBe(
      "https://s/a/",
    );
  });

  it("matches the no-extension layout", () => {
    expect(stagedPageUrl("https://x--ch.web.app", "/pricing/", "no-extension")).toBe(
      "https://x--ch.web.app/pricing",
    );
  });
});

describe("resolveStagingOrigin", () => {
  let server: ReturnType<typeof Bun.serve>;
  let servedRunId = RUN_ID;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ runId: servedRunId }),
    });
  });
  afterAll(() => server.stop(true));

  it("a dev checkout: the staging base URL, once it serves this run", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await resolveStagingOrigin(run(), { provider: "", stagingBaseUrl: base })).toEqual({
      ok: true,
      baseUrl: base,
    });
  });

  it("self-hosted: fails loudly when staging serves another build", async () => {
    servedRunId = "00000000-0000-4000-8000-0000000000ff";
    const r = await resolveStagingOrigin(run(), {
      provider: "",
      stagingBaseUrl: `http://127.0.0.1:${server.port}`,
    });
    servedRunId = RUN_ID;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("staging-unreachable");
    expect(r.message).toContain(RUN_ID);
  });

  it("gcp / gcp-firebase / aws / azure: a loopback origin serving the run's files, closed after use (#1330: never the gated gateway)", async () => {
    for (const provider of ["gcp", "gcp-firebase", "self-hosted", "aws", "azure"]) {
      const r = await resolveStagingOrigin(
        run({ stagingLocation: "_slots/a", stagingOrigin: "https://staging.example.com" }),
        {
          provider,
          loopbackSource: () => ({
            read: async (key) =>
              key === "index.html"
                ? { bytes: new TextEncoder().encode("<h1>staged</h1>"), contentType: "text/html" }
                : null,
          }),
        },
      );
      if (!r.ok) throw new Error(r.message);
      expect(r.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(r.displayBaseUrl).toBe("https://staging.example.com");
      expect(await (await fetch(`${r.baseUrl}/`)).text()).toBe("<h1>staged</h1>");
      // A parallel Lighthouse task reads the same slot (gcp, gcp-firebase).
      expect(r.stagedBuild).toEqual(
        provider === "gcp" || provider === "gcp-firebase"
          ? { kind: "staging-slot", location: "_slots/a", runId: RUN_ID, baseUrl: r.baseUrl }
          : undefined,
      );
      await r.close?.();
    }
  });

  it("gcp / gcp-firebase: a run staged before the slots fails loudly", async () => {
    for (const provider of ["gcp", "gcp-firebase"]) {
      expect(await resolveStagingOrigin(run(), { provider })).toMatchObject({
        ok: false,
        code: "staging-unresolvable",
      });
    }
  });

  it("aws without the build on this instance fails loudly", async () => {
    expect(await resolveStagingOrigin(run(), { provider: "aws" })).toMatchObject({
      ok: false,
      code: "build-unavailable",
    });
  });

  it("unknown providers fail with an explanation instead of guessing", async () => {
    const r = await resolveStagingOrigin(run(), { provider: "mystery-cloud" });
    expect(r).toMatchObject({ ok: false, code: "provider-unsupported" });
  });
});

describe("toDisplayUrl (#650)", () => {
  it("re-addresses URLs on the audited origin and leaves others alone", () => {
    const base = "https://site--ch.web.app";
    const shown = "https://staging.example.com";
    expect(toDisplayUrl(`${base}/a/`, base, shown)).toBe(`${shown}/a/`);
    expect(toDisplayUrl(base, base, shown)).toBe(shown);
    expect(toDisplayUrl(`${base}?x=1`, base, shown)).toBe(`${shown}?x=1`);
    expect(toDisplayUrl("https://elsewhere.example/a", base, shown)).toBe(
      "https://elsewhere.example/a",
    );
    // A host that merely starts with the origin is not the origin.
    expect(toDisplayUrl(`${base}.evil.example/a`, base, shown)).toBe(`${base}.evil.example/a`);
  });
});

describe("processClaimedRun on gcp-firebase (#650, #1330)", () => {
  it("runs Lighthouse against the loopback copy of the slot but records only the staging host", async () => {
    const recorded: unknown[] = [];
    const jobs: unknown[] = [];
    const fetched: string[] = [];
    const registry = {
      lookup: () => ({
        ok: true,
        value: {
          name: "quality_audits.record_result",
          actorScope: ["human", "ai", "system"],
          database: "cms_admin",
          input: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          output: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          handler: async (_c: unknown, input: unknown) => {
            recorded.push(input);
            return { ok: true, value: { status: "recorded" } };
          },
        },
      }),
    };
    const adapter = {
      runOperation: async (
        op: { handler: (c: unknown, i: unknown, tx: unknown) => unknown },
        ctx: unknown,
        input: unknown,
      ) => op.handler(ctx, input, {}),
    };
    await processClaimedRun(
      {
        registry: registry as never,
        adapter: adapter as never,
        env: {
          provider: "gcp-firebase",
          loopbackSource: () => ({ read: async () => null }),
        },
        checks: testCheckRegistry(async () => {
          throw new Error("runJob replaces the Lighthouse runner");
        }),
        // #727 — the page checks read the same preview origin.
        fetchPage: (async (url: string) => {
          fetched.push(url);
          return new Response(
            '<html><head><meta name="description" content="TODO"></head><body></body></html>',
          );
        }) as unknown as typeof fetch,
        runJob: async (job) => {
          jobs.push(job);
          return {
            ok: true,
            pages: [
              {
                pageId: job.pages[0]!.pageId,
                url: job.pages[0]!.url,
                finalUrl: job.pages[0]!.url,
                // #667 — flagged resource URLs move with the page URL, so a
                // same-site asset never reads as third-party in the report.
                measurement: {
                  scores: { performance: 93, accessibility: 100, "best-practices": 100, seo: 100 },
                  failingAudits: [
                    {
                      id: "cache-insight",
                      title: "Use efficient cache lifetimes",
                      score: 0.5,
                      categories: ["performance"],
                      elements: [
                        { url: `${new URL(job.pages[0]!.url).origin}/_assets/logo.png` },
                        { url: "https://cdn.example.net/widget.js" },
                      ],
                    },
                  ],
                  metrics: sampleMetrics(),
                },
                performanceRuns: [],
              },
            ],
            pageErrors: [
              {
                pageId: "p2",
                url: `${new URL(job.pages[0]!.url).origin}/b/`,
                code: "load-failed",
                message: `could not load ${new URL(job.pages[0]!.url).origin}/b/`,
              },
            ],
          };
        },
      },
      run({ stagingLocation: "_slots/a", stagingOrigin: "https://staging.example.com" }),
    );
    expect(JSON.stringify(jobs)).toMatch(/http:\/\/127\.0\.0\.1:\d+\//);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const text = JSON.stringify(recorded);
    // The registered page check's finding is reported too.
    expect(text).toContain("test-meta/placeholder-description");
    expect(text).not.toContain("127.0.0.1");
    expect(text).toContain("https://staging.example.com/");
    expect(text).toContain("https://staging.example.com/_assets/logo.png");
    expect(text).toContain("https://cdn.example.net/widget.js");
    // The Performance metrics reach record_result untouched.
    expect(text).toContain('"lcpElement":{"selector":"body > h1"');
  });
});
