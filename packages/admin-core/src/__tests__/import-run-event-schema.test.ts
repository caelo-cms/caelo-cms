// SPDX-License-Identifier: MPL-2.0

/**
 * issue #28 — the run-scoped error/warning ledger's WRITE-boundary Zod
 * schema (`importRunEventInput`). Pure-function test, no DB: it pins the
 * shape every ledger emitter (media migration, fidelity gate, crawl) must
 * satisfy before a row reaches `import_run_events`.
 */

import { describe, expect, it } from "bun:test";
import { importRunEventInput } from "../ops/imports.js";

describe("importRunEventInput", () => {
  const base = {
    runId: "11111111-1111-4111-8111-111111111111",
    severity: "warning" as const,
    message: "media asset not migrated: https://old.example/x.png (http-404)",
  };

  it("accepts a minimal warning event", () => {
    const r = importRunEventInput.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("accepts phase, arbitrary jsonb detail, and a page id", () => {
    const r = importRunEventInput.safeParse({
      ...base,
      severity: "error",
      phase: "fidelity",
      detail: { diffPct: 0.42, worstBand: "top" },
      pageId: "22222222-2222-4222-8222-222222222222",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown severity", () => {
    const r = importRunEventInput.safeParse({ ...base, severity: "fatal" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-uuid runId", () => {
    const r = importRunEventInput.safeParse({ ...base, runId: "not-a-uuid" });
    expect(r.success).toBe(false);
  });

  it("rejects an empty message", () => {
    const r = importRunEventInput.safeParse({ ...base, message: "" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = importRunEventInput.safeParse({ ...base, level: "high" });
    expect(r.success).toBe(false);
  });
});
