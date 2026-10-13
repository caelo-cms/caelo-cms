// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #667 — the acceptance contract the model reads. The dogfood run
 * that opened #667 had the AI recommend accepting all remaining findings
 * ("I'd accept all four") and offer to request the approval; two of them
 * were Caelo bugs. These pin the wording that forbids that.
 */

import { describe, expect, it } from "bun:test";
import { getQualityAuditTool } from "./quality-audit-tools.js";
import { acceptQualityFindingsTool, publishDespiteFailedAuditTool } from "./quality-gate-tools.js";

describe("accept_quality_findings description", () => {
  const d = acceptQualityFindingsTool.description;

  it("is for the operator's explicit request only, like publish_despite_failed_audit", () => {
    expect(d.startsWith("ONLY when the operator explicitly asks")).toBe(true);
    expect(
      publishDespiteFailedAuditTool.description.startsWith("Only when the editor explicitly wants"),
    ).toBe(true);
    expect(d).toContain("Never on your own initiative");
  });

  it("forbids recommending an acceptance or offering to request it", () => {
    expect(d).toContain("never recommend, suggest or argue for an acceptance");
    expect(d).toContain("no offering to request the approval");
    expect(d).toContain("Publish live stays blocked until they are fixed or the operator decides");
    // The old wording invited the AI to ask for acceptance of anything it
    // could not fix.
    expect(d).not.toContain("something you cannot fix");
  });

  it("routes Caelo platform findings to bug_report", () => {
    expect(d).toContain("CAELO PLATFORM are Caelo bugs: report them with bug_report");
    expect(getQualityAuditTool.description).toContain("never propose accepting it");
  });

  it("stays approval-gated", () => {
    expect(acceptQualityFindingsTool.approvalMode).toBe("user-approval");
    expect(d).toContain("APPROVAL-GATED");
  });
});
