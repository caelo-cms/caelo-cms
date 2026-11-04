// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describeManifestChanges } from "../ops/plugins/manifest-changes.js";

describe("#1420 — what a plugin release changes", () => {
  it("names added, removed and changed entries by their manifest name", () => {
    const changes = describeManifestChanges(
      {
        tools: [
          { name: "keep", description: "a" },
          { name: "gone", description: "b" },
        ],
      },
      {
        tools: [
          { name: "keep", description: "changed" },
          { name: "fresh", description: "c" },
        ],
      },
    );
    expect(changes).toEqual([
      { area: "AI tools", added: ["fresh"], removed: ["gone"], changed: ["keep"] },
    ]);
  });

  it("compares maps by key and treats a field that appears as added entries", () => {
    expect(describeManifestChanges({}, { tableKinds: { comments: "inbox" } })).toEqual([
      { area: "Who can reach its tables", added: ["comments"], removed: [], changed: [] },
    ]);
  });

  it("reports a flag as one change and ignores a flag that stays off", () => {
    expect(describeManifestChanges({}, { hasBuildAssets: false })).toEqual([]);
    expect(describeManifestChanges({ hasBuildAssets: false }, { hasBuildAssets: true })).toEqual([
      {
        area: "Files added to every page",
        added: [],
        removed: [],
        changed: ["Files added to every page"],
      },
    ]);
  });

  it("does not count the key order of stored jsonb as a change", () => {
    expect(
      describeManifestChanges(
        { workers: [{ name: "w", cron: "* * * * *" }] },
        { workers: [{ cron: "* * * * *", name: "w" }] },
      ),
    ).toEqual([]);
  });

  it("leaves identity and capabilities to the approval itself", () => {
    expect(
      describeManifestChanges(
        { version: "1.0.0", requestedCapabilities: ["email"] },
        { version: "2.0.0", requestedCapabilities: ["email", "snapshots"] },
      ),
    ).toEqual([]);
  });
});
