// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ClaimedAuditRun, resolveStagingOrigin, stagedPageUrl } from "../audit-worker.js";

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";

function run(overrides: Partial<ClaimedAuditRun> = {}): ClaimedAuditRun {
  return {
    auditRunId: "00000000-0000-4000-8000-0000000000bb",
    deployRunId: RUN_ID,
    performanceRuns: 3,
    pageUrlStyle: "directory",
    previewUrl: null,
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

  it("gcp-firebase: the deploy run's preview channel", async () => {
    expect(
      await resolveStagingOrigin(run({ previewUrl: "https://site--ch.web.app" }), {
        provider: "gcp-firebase",
      }),
    ).toEqual({ ok: true, baseUrl: "https://site--ch.web.app" });
    const missing = await resolveStagingOrigin(run(), { provider: "gcp-firebase" });
    expect(missing.ok).toBe(false);
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
