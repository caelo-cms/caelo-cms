// SPDX-License-Identifier: MPL-2.0

/**
 * issue #306 — unit tests for the pure tier→model mapping logic
 * (model-tiers.ts). No DB, no provider: the DB read lives in
 * provider-resolver; these tests pin the resolution CONTRACT:
 *
 *   - absent mapping = tiering disabled (the conservative default);
 *   - `inherit` always resolves to "use the parent's provider" (null);
 *   - a requested-but-unmapped tier is a LOUD error with recovery steps
 *     (CLAUDE.md §2 — never a silent downgrade to inherit);
 *   - malformed config fails loudly, naming what to fix;
 *   - error strings never contain model ids (brand rule: models are
 *     Owner-surface data; these errors flow to the editor-facing AI).
 */

import { describe, expect, it } from "bun:test";

import { availableMappedTiers, parseModelTierMap, resolveTierModel } from "../model-tiers.js";

describe("parseModelTierMap (issue #306)", () => {
  it("treats absent config as tiering-disabled, not an error", () => {
    for (const raw of [undefined, null]) {
      const r = parseModelTierMap(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeNull();
    }
  });

  it("parses a full mid+small mapping", () => {
    const r = parseModelTierMap({ mid: "model-m", small: "model-s" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ mid: "model-m", small: "model-s" });
  });

  it("parses a partial mapping (small only)", () => {
    const r = parseModelTierMap({ small: "model-s" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ small: "model-s" });
  });

  it("treats an explicitly empty object as tiering-disabled", () => {
    const r = parseModelTierMap({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it("fails loudly on a non-object value", () => {
    const r = parseModelTierMap("model-m");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("modelTiers is malformed");
    expect(r.error).toContain("/security/ai");
  });

  it("fails loudly on an unknown tier key (typo protection)", () => {
    const r = parseModelTierMap({ smal: "model-s" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"smal"');
  });

  it("fails loudly on a non-string model id", () => {
    const r = parseModelTierMap({ mid: 42 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("modelTiers.mid");
  });

  it("rejects mapping the implicit inherit tier", () => {
    const r = parseModelTierMap({ inherit: "model-x" });
    expect(r.ok).toBe(false);
  });
});

describe("resolveTierModel (issue #306)", () => {
  const tiers = { mid: "model-m", small: "model-s" } as const;

  it("inherit resolves to null (parent's provider) with or without a mapping", () => {
    for (const map of [tiers, null]) {
      const r = resolveTierModel("inherit", map);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeNull();
    }
  });

  it("resolves mapped tiers to their model ids", () => {
    const mid = resolveTierModel("mid", tiers);
    const small = resolveTierModel("small", tiers);
    expect(mid.ok && mid.value === "model-m").toBe(true);
    expect(small.ok && small.value === "model-s").toBe(true);
  });

  it("LOUD error when tiering is disabled and a tier is requested — no silent downgrade", () => {
    const r = resolveTierModel("mid", null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // AI-actionable (§11): both recoveries named, and an explicit
    // instruction not to claim success.
    expect(r.error).toContain('model tier "mid"');
    expect(r.error).toContain("WITHOUT");
    expect(r.error).toContain("/security/ai");
    expect(r.error).toContain("Do not claim");
  });

  it("LOUD error when the specific tier is unmapped, naming the configured ones", () => {
    const r = resolveTierModel("mid", { small: "model-s" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('model tier "mid" is not mapped');
    expect(r.error).toContain('"small"');
  });

  it("error strings never leak model ids (brand rule)", () => {
    const cases = [resolveTierModel("mid", null), resolveTierModel("mid", { small: "model-s" })];
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).not.toContain("model-s");
      expect(r.error).not.toMatch(/claude|sonnet|haiku|opus|anthropic|gpt|gemini/i);
    }
  });
});

describe("availableMappedTiers (issue #306)", () => {
  it("reflects exactly the mapped tiers", () => {
    expect([...availableMappedTiers(null)]).toEqual([]);
    expect([...availableMappedTiers({ small: "s" })]).toEqual(["small"]);
    expect([...availableMappedTiers({ mid: "m", small: "s" })].sort()).toEqual(["mid", "small"]);
  });
});
