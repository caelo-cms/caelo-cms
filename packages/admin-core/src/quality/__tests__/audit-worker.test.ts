// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type ClaimedAuditRun,
  processClaimedRun,
  resolveStagingOrigin,
  stagedPageUrl,
  toDisplayUrl,
} from "../audit-worker.js";

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";

function run(overrides: Partial<ClaimedAuditRun> = {}): ClaimedAuditRun {
  return {
    auditRunId: "00000000-0000-4000-8000-0000000000bb",
    deployRunId: RUN_ID,
    performanceRuns: 3,
    pageUrlStyle: "directory",
    previewUrl: null,
    siteUrl: null,
    env: "staging",
    outDir: "output/staging",
    pages: [{ pageId: "00000000-0000-4000-8000-0000000000cc", currentPath: "/" }],
    ...overrides,
  };
}

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

  it("self-hosted: the staging base URL, once it serves this run", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect(
      await resolveStagingOrigin(run(), { provider: "self-hosted", stagingBaseUrl: base }),
    ).toEqual({
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

  it("gcp-firebase: audits the preview channel directly, reported as the staging host (#650)", async () => {
    const staged = {
      previewUrl: "https://site--ch.web.app",
      siteUrl: "https://staging.example.com",
    };
    expect(await resolveStagingOrigin(run(staged), { provider: "gcp-firebase" })).toEqual({
      ok: true,
      baseUrl: "https://site--ch.web.app",
      displayBaseUrl: "https://staging.example.com",
    });
    const missing = await resolveStagingOrigin(run({ siteUrl: staged.siteUrl }), {
      provider: "gcp-firebase",
    });
    expect(missing.ok).toBe(false);
    // Without the run's staging host the report could only name the internal origin.
    const noHost = await resolveStagingOrigin(run({ previewUrl: staged.previewUrl }), {
      provider: "gcp-firebase",
    });
    expect(noHost).toMatchObject({ ok: false, code: "staging-unresolvable" });
  });

  it("gcp-firebase: reports under the host the run was STAGED for, not a host set later (Codex review on #652)", async () => {
    // The Owner moved staging to preview.example.com while this audit of a
    // build rendered for staging.example.com was queued: the report keeps
    // the run's host. (OriginEnv no longer carries the mutable setting.)
    const r = await resolveStagingOrigin(
      run({ previewUrl: "https://site--ch.web.app", siteUrl: "https://staging.example.com" }),
      { provider: "gcp-firebase" },
    );
    expect(r).toMatchObject({ ok: true, displayBaseUrl: "https://staging.example.com" });
  });

  it("gcp / aws / azure: a loopback origin serving the run's files, closed after use", async () => {
    for (const provider of ["gcp", "aws", "azure"]) {
      const r = await resolveStagingOrigin(run(), {
        provider,
        loopbackSource: () => ({
          read: async (key) =>
            key === "index.html"
              ? { bytes: new TextEncoder().encode("<h1>staged</h1>"), contentType: "text/html" }
              : null,
        }),
      });
      if (!r.ok) throw new Error(r.message);
      expect(r.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await (await fetch(`${r.baseUrl}/`)).text()).toBe("<h1>staged</h1>");
      await r.close?.();
    }
  });

  it("gcp without its bucket env and aws without the build on this instance fail loudly", async () => {
    const saved = process.env.CAELO_STAGING_BUCKET;
    delete process.env.CAELO_STAGING_BUCKET;
    try {
      expect(await resolveStagingOrigin(run(), { provider: "gcp" })).toMatchObject({
        ok: false,
        code: "staging-unresolvable",
      });
    } finally {
      if (saved !== undefined) process.env.CAELO_STAGING_BUCKET = saved;
    }
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

describe("processClaimedRun on gcp-firebase (#650)", () => {
  it("runs Lighthouse against the preview origin but records only the staging host", async () => {
    const recorded: unknown[] = [];
    const jobs: unknown[] = [];
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
        env: { provider: "gcp-firebase" },
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
                        { url: "https://site--ch.web.app/_assets/logo.png" },
                        { url: "https://cdn.example.net/widget.js" },
                      ],
                    },
                  ],
                },
                performanceRuns: [],
              },
            ],
            pageErrors: [
              {
                pageId: "p2",
                url: "https://site--ch.web.app/b/",
                code: "load-failed",
                message: "could not load https://site--ch.web.app/b/",
              },
            ],
          };
        },
      },
      run({ previewUrl: "https://site--ch.web.app", siteUrl: "https://staging.example.com" }),
    );
    expect(JSON.stringify(jobs)).toContain("https://site--ch.web.app/");
    const text = JSON.stringify(recorded);
    expect(text).not.toContain("web.app");
    expect(text).toContain("https://staging.example.com/");
    expect(text).toContain("https://staging.example.com/_assets/logo.png");
    expect(text).toContain("https://cdn.example.net/widget.js");
  });
});
