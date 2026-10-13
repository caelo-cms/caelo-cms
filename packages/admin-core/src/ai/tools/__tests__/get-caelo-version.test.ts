// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PlatformUpdateStatus } from "../../../ops/platform-updates.js";
import { formatCaeloVersion, getCaeloVersionTool } from "../get-caelo-version.js";

const base: PlatformUpdateStatus = {
  installedVersion: "0.10.43",
  latestVersion: "0.10.44",
  upgradeAvailable: true,
  releaseUrl: "https://github.com/caelo-cms/caelo-cms/releases/tag/v0.10.44",
  releaseNotes: "## Fixes",
  publishedAt: "2026-10-12T09:00:00Z",
  checkedAt: "2026-10-13T10:00:00Z",
  updatesPath: "/settings/updates",
};

describe("get_caelo_version", () => {
  it("reports the update and sends the operator to Settings → Updates", () => {
    const out = formatCaeloVersion(base);
    expect(out).toContain("Installed Caelo version: 0.10.43");
    expect(out).toContain(
      "Newest release: 0.10.44 (published 2026-10-12) — an update is available.",
    );
    expect(out).toContain("releases/tag/v0.10.44");
    expect(out).toContain("installed by the Owner at /settings/updates");
    expect(out).toContain("You cannot install or schedule an update");
  });

  it("says up to date, and why the newest release can be unknown", () => {
    expect(
      formatCaeloVersion({ ...base, latestVersion: "0.10.43", upgradeAvailable: false }),
    ).toContain("this install is up to date");
    expect(
      formatCaeloVersion({
        ...base,
        latestVersion: null,
        upgradeAvailable: false,
        checkedAt: null,
      }),
    ).toContain("has not run yet");
    expect(formatCaeloVersion({ ...base, latestVersion: null, upgradeAvailable: false })).toContain(
      "could not reach GitHub",
    );
  });

  it("tells the AI up front that it cannot install updates", () => {
    expect(getCaeloVersionTool.name).toBe("get_caelo_version");
    expect(getCaeloVersionTool.description).toContain("you cannot install updates");
  });
});
