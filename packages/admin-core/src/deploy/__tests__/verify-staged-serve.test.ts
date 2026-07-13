// SPDX-License-Identifier: MPL-2.0

/**
 * Migration run #9 R10 (issue #262) — regression tests for the staging
 * serve check. The regression class: deploy.trigger reported success
 * while the staging vhost kept serving a build from months earlier
 * (the generator wrote to a directory the serving layer never
 * mounted). Each case here is a way the serve layer can lie or be
 * absent, and each must come back `served: false` with a reason the
 * operator can act on.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { verifyStagedBuildServed } from "../verify-staged-serve.js";

const RUN_ID = "2c9f62a8-031a-48af-934e-0b0e41b50435";
const STALE_RUN_ID = "65d4201b-1dbf-43d7-90e8-18889c176127";

type ManifestBody = string | null;

function serveManifest(body: ManifestBody, status = 200) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/routing-manifest.json" && body !== null) {
        return new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

const servers: ReturnType<typeof Bun.serve>[] = [];
function track<T extends ReturnType<typeof Bun.serve>>(s: T): T {
  servers.push(s);
  return s;
}
afterAll(() => {
  for (const s of servers) s.stop(true);
});

describe("verifyStagedBuildServed", () => {
  it("passes when the served manifest carries this deploy's runId", async () => {
    const s = track(serveManifest(JSON.stringify({ runId: RUN_ID, pageCount: 3 })));
    const check = await verifyStagedBuildServed({
      stagingBaseUrl: s.url.origin,
      runId: RUN_ID,
    });
    expect(check.served).toBe(true);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const s = track(serveManifest(JSON.stringify({ runId: RUN_ID })));
    const check = await verifyStagedBuildServed({
      stagingBaseUrl: `${s.url.origin}/`,
      runId: RUN_ID,
    });
    expect(check.served).toBe(true);
  });

  it("fails loudly when staging serves a stale build (the run #9 lie)", async () => {
    const s = track(serveManifest(JSON.stringify({ runId: STALE_RUN_ID, pageCount: 1 })));
    const check = await verifyStagedBuildServed({
      stagingBaseUrl: s.url.origin,
      runId: RUN_ID,
      attempts: 1,
    });
    expect(check.served).toBe(false);
    if (check.served) return;
    expect(check.servedRunId).toBe(STALE_RUN_ID);
    expect(check.reason).toContain(STALE_RUN_ID);
    expect(check.reason).toContain(RUN_ID);
    expect(check.reason).toContain("not mounted");
  });

  it("fails when the serve root has no manifest at all (404)", async () => {
    const s = track(serveManifest(null));
    const check = await verifyStagedBuildServed({
      stagingBaseUrl: s.url.origin,
      runId: RUN_ID,
      attempts: 1,
    });
    expect(check.served).toBe(false);
    if (check.served) return;
    expect(check.reason).toContain("404");
  });

  it("fails when the manifest is not JSON", async () => {
    const s = track(serveManifest("<html>default site</html>"));
    const check = await verifyStagedBuildServed({
      stagingBaseUrl: s.url.origin,
      runId: RUN_ID,
      attempts: 1,
    });
    expect(check.served).toBe(false);
    if (check.served) return;
    expect(check.reason).toContain("non-JSON");
  });

  it("fails when the manifest JSON has no runId", async () => {
    const s = track(serveManifest(JSON.stringify({ pageCount: 3 })));
    const check = await verifyStagedBuildServed({
      stagingBaseUrl: s.url.origin,
      runId: RUN_ID,
      attempts: 1,
    });
    expect(check.served).toBe(false);
    if (check.served) return;
    expect(check.servedRunId).toBeUndefined();
    expect(check.reason).toContain("<missing>");
  });

  it("fails when the serve layer is unreachable", async () => {
    // Bind + immediately stop a server so the port is known-dead.
    const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const origin = s.url.origin;
    s.stop(true);
    const check = await verifyStagedBuildServed({
      stagingBaseUrl: origin,
      runId: RUN_ID,
      timeoutMs: 1500,
      attempts: 1,
    });
    expect(check.served).toBe(false);
    if (check.served) return;
    expect(check.reason).toContain("unreachable");
  });
});
