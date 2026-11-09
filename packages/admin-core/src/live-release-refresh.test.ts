// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { RedirectSyncOutcome } from "./deploy/redirect-sync.js";
import { refreshStaleLiveRelease } from "./redirect-sync-worker.js";

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

describe("#1380 refreshStaleLiveRelease (stale rewrite or fixed headers)", () => {
  it("does nothing off gcp-firebase (no Hosting release config to refresh)", async () => {
    let read = false;
    const r = await refreshStaleLiveRelease("gcp", {
      liveConfigIsCurrent: async () => {
        read = true;
        return false;
      },
      syncProduction: async () => [],
    });
    expect(r).toBe("not-applicable");
    expect(read).toBe(false);
  });

  it("leaves a current config alone (no release)", async () => {
    let synced = false;
    const r = await refreshStaleLiveRelease("gcp-firebase", {
      liveConfigIsCurrent: async () => true,
      syncProduction: async () => {
        synced = true;
        return [];
      },
    });
    expect(r).toBe("current");
    expect(synced).toBe(false);
  });

  it("reports nothing-live when no release exists yet", async () => {
    const r = await refreshStaleLiveRelease("gcp-firebase", {
      liveConfigIsCurrent: async () => null,
      syncProduction: async () => [outcome("applied")],
    });
    expect(r).toBe("nothing-live");
  });

  it("syncs the production targets when the rewrite or the fixed headers are stale", async () => {
    let synced = 0;
    const r = await refreshStaleLiveRelease("gcp-firebase", {
      liveConfigIsCurrent: async () => false,
      syncProduction: async () => {
        synced += 1;
        return [outcome("applied")];
      },
    });
    expect(r).toBe("refreshed");
    expect(synced).toBe(1);
  });

  it("fails loudly when the refreshing sync failed", async () => {
    await expect(
      refreshStaleLiveRelease("gcp-firebase", {
        liveConfigIsCurrent: async () => false,
        syncProduction: async () => [outcome("failed")],
      }),
    ).rejects.toThrow(
      /stale \/api\/\*\* rewrite or security headers: production: 403 from Hosting/,
    );
  });
});
