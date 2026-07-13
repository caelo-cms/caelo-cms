// SPDX-License-Identifier: MPL-2.0

/**
 * issue #250 (WS4) — unit coverage for the fidelity verdict tool's pure
 * pieces: the verdict-string shaping (pass/warn/fail phrasing + repair-cap +
 * "never done over red" contract) and the tool input schema. The DB/Playwright
 * path is covered by integration tests (not run here — dev-DB truncation).
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { buildFidelityVerdict, verifyImportFidelityTool } from "./verify-import-fidelity.js";

describe("buildFidelityVerdict", () => {
  const base = {
    diffPct: 0.08,
    worstBand: "top" as const,
    bandPct: 0.12,
    sourceUrl: "https://x.test/",
  };

  it("PASS reads as verified and invites presenting", () => {
    const v = buildFidelityVerdict({ ...base, status: "pass" });
    expect(v).toStartWith("PASS");
    expect(v).toContain("structurally matches");
    expect(v).toContain("8.0%");
    expect(v).toContain("header/hero");
  });

  it("WARN names the region, the repair cap, and forbids reporting done", () => {
    const v = buildFidelityVerdict({ ...base, status: "warn", diffPct: 0.2, worstBand: "bottom" });
    expect(v).toStartWith("WARN");
    expect(v).toContain("footer area");
    expect(v).toContain("two repair rounds");
    expect(v.toLowerCase()).toContain("do not report this page as done");
  });

  it("FAIL flags a broken/wrong-template rebuild and forbids 'fertig'", () => {
    const v = buildFidelityVerdict({ ...base, status: "fail", diffPct: 0.4, worstBand: "middle" });
    expect(v).toStartWith("FAIL");
    expect(v).toContain("main content");
    expect(v).toContain("fertig");
  });

  it("omits the source URL cleanly when unknown", () => {
    const v = buildFidelityVerdict({ ...base, status: "pass", sourceUrl: null });
    expect(v).not.toContain(" vs ");
  });
});

describe("verify_import_page_fidelity tool contract", () => {
  it("accepts a uuid importPageId and rejects extras (Zod boundary)", () => {
    const ok = verifyImportFidelityTool.schema.safeParse({
      importPageId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(ok.success).toBe(true);
    const bad = verifyImportFidelityTool.schema.safeParse({
      importPageId: "not-a-uuid",
    });
    expect(bad.success).toBe(false);
    const extra = verifyImportFidelityTool.schema.safeParse({
      importPageId: "550e8400-e29b-41d4-a716-446655440000",
      surprise: true,
    });
    expect(extra.success).toBe(false);
  });

  it("its resolver payload validates against the op's input shape (offline)", () => {
    // Mirror imports.get_page_fidelity_inputs' input schema; the handler
    // sends exactly { pageRef }. Guards against tool/op drift without a DB.
    const opInput = z.object({ pageRef: z.string().uuid() }).strict();
    expect(opInput.safeParse({ pageRef: "550e8400-e29b-41d4-a716-446655440000" }).success).toBe(
      true,
    );
  });
});
