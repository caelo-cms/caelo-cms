// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { RedirectSyncOutcome } from "./deploy/redirect-sync.js";
import { repointStaleGatewayRewrite } from "./redirect-sync-worker.js";

function outcome(status: RedirectSyncOutcome["status"]): RedirectSyncOutcome {
  return {
    targetId: "t",
    targetName: "production",
    env: "production",
    status,
    revision: 2,
    redirectCount: 0,
    unservedTargets: [],
    location: null,
    error: status === "failed" ? "403 from Hosting" : null,
  };
}

describe("#1380 repointStaleGatewayRewrite", () => {
  it("does nothing off gcp-firebase (no Hosting rewrite to repoint)", async () => {
    let read = false;
    const r = await repointStaleGatewayRewrite("gcp", {
      liveRewriteIsCurrent: async () => {
        read = true;
        return false;
      },
      syncProduction: async () => [],
    });
    expect(r).toBe("not-applicable");
    expect(read).toBe(false);
  });

  it("leaves a current rewrite alone (no release)", async () => {
    let synced = false;
    const r = await repointStaleGatewayRewrite("gcp-firebase", {
      liveRewriteIsCurrent: async () => true,
      syncProduction: async () => {
        synced = true;
        return [];
      },
    });
    expect(r).toBe("current");
    expect(synced).toBe(false);
  });

  it("reports nothing-live when no release exists yet", async () => {
    const r = await repointStaleGatewayRewrite("gcp-firebase", {
      liveRewriteIsCurrent: async () => null,
      syncProduction: async () => [outcome("applied")],
    });
    expect(r).toBe("nothing-live");
  });

  it("syncs the production targets when the rewrite names an older gateway", async () => {
    let synced = 0;
    const r = await repointStaleGatewayRewrite("gcp-firebase", {
      liveRewriteIsCurrent: async () => false,
      syncProduction: async () => {
        synced += 1;
        return [outcome("applied")];
      },
    });
    expect(r).toBe("repointed");
    expect(synced).toBe(1);
  });

  it("fails loudly when the repointing sync failed", async () => {
    await expect(
      repointStaleGatewayRewrite("gcp-firebase", {
        liveRewriteIsCurrent: async () => false,
        syncProduction: async () => [outcome("failed")],
      }),
    ).rejects.toThrow(/previous gateway: production: 403 from Hosting/);
  });
});
