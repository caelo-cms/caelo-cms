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

  it("other providers fail with an explanation instead of guessing", async () => {
    const r = await resolveStagingOrigin(run(), { provider: "gcp" });
    expect(r).toMatchObject({ ok: false, code: "provider-unsupported" });
  });
});
