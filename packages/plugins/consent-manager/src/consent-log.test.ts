// SPDX-License-Identifier: MPL-2.0

/**
 * Consent statistics (#1131): counts only, from visitor-written rows that
 * are validated before they are counted.
 */

import { describe, expect, it } from "bun:test";
import type { PluginQuery } from "@caelo-cms/plugin-sdk";
import type { CategoryRow } from "./categories.js";
import { consentStats, describeConsentLog } from "./consent-log.js";

const CATEGORIES: CategoryRow[] = ["necessary", "functional", "analytics", "marketing"].map(
  (key, position) => ({
    id: key,
    key,
    display_name: key,
    description: "",
    required: key === "necessary",
    position,
  }),
);

/** `created_at > since`, ordered, limited — the host's semantics. */
function logQuery(rows: Array<Record<string, unknown>>, pageSize: { calls: number }): PluginQuery {
  return {
    list: async (_t: string, f: { since?: string; limit?: number } = {}) => {
      pageSize.calls += 1;
      return rows
        .filter((r) => !f.since || new Date(String(r.created_at)) > new Date(f.since))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, f.limit ?? 100) as never;
    },
  } as unknown as PluginQuery;
}

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

describe("consentStats", () => {
  it("splits decisions into accept-all, reject-all and custom over the offered categories", async () => {
    const rows = [
      {
        id: "1",
        granted: ["necessary", "analytics", "marketing"],
        policy_version: 1,
        created_at: at(50),
      },
      { id: "2", granted: ["necessary"], policy_version: 1, created_at: at(40) },
      { id: "3", granted: ["necessary", "analytics"], policy_version: 2, created_at: at(30) },
      // Unused `functional` does not make an accept-all a custom choice.
      {
        id: "4",
        granted: ["necessary", "analytics", "marketing"],
        policy_version: 2,
        created_at: at(20),
      },
      // Outside the window.
      { id: "5", granted: ["necessary"], policy_version: 1, created_at: at(60 * 24 * 40) },
      // Not the declared shape: never classified.
      { id: "6", granted: "everything", policy_version: 2, created_at: at(10) },
    ];
    const calls = { calls: 0 };
    const out = await consentStats(
      logQuery(rows, calls),
      { days: 30 },
      CATEGORIES,
      new Set(["necessary", "analytics", "marketing"]),
    );
    expect(out.decisions).toBe(4);
    expect(out.acceptAll).toEqual({ count: 2, percent: 50 });
    expect(out.rejectAll).toEqual({ count: 1, percent: 25 });
    expect(out.custom).toEqual({ count: 1, percent: 25 });
    expect(out.perCategory.find((c) => c.key === "analytics")?.granted).toBe(3);
    expect(out.perPolicyVersion).toEqual([
      { policyVersion: 1, decisions: 2, acceptAll: 1, rejectAll: 1, custom: 0 },
      { policyVersion: 2, decisions: 2, acceptAll: 1, rejectAll: 0, custom: 1 },
    ]);
    expect(out.unreadableRecords).toBe(1);
    // Nothing that identifies a decision leaves the op.
    expect(JSON.stringify(out)).not.toMatch(/"id"|visitor/);
  });

  it("rejects an out-of-range window with the expected bounds", async () => {
    await expect(
      consentStats(logQuery([], { calls: 0 }), { days: 0 }, CATEGORIES, new Set()),
    ).rejects.toThrow(/consent_stats: days/);
  });
});

describe("describeConsentLog (#1132)", () => {
  it("states the retention in the copyable privacy-policy paragraph", () => {
    const d = describeConsentLog(180);
    expect(d.privacyPolicyText).toContain("180 days");
    expect(d.storedFields.map((f) => f.field)).toEqual([
      "created_at",
      "granted",
      "policy_version",
      "visitor_id",
      "ip_hash",
    ]);
    expect(d.notStored).toContain("user agent");
  });
});
