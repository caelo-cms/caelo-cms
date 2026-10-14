// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #667 — the acceptance contract the model reads. The dogfood run
 * that opened #667 had the AI recommend accepting all remaining findings
 * ("I'd accept all four") and offer to request the approval; two of them
 * were Caelo bugs. These pin the wording that forbids that.
 */

import { describe, expect, it } from "bun:test";
import { powerToolCatalogue } from "../../ops/security/mcp_power.js";
import { createDefaultToolRegistry } from "./index.js";
import { checkStageAuditTool, getQualityAuditTool } from "./quality-audit-tools.js";
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

describe("Lighthouse metrics on the quality read tools", () => {
  it("tell the agent the metrics are there and not to run Lighthouse itself", () => {
    for (const tool of [getQualityAuditTool, checkStageAuditTool]) {
      expect(tool.description).toContain("LCP");
      expect(tool.description).toContain("CLS");
      expect(tool.description).toContain(
        "Use this instead of running Lighthouse yourself: the audit runs against the real staged build",
      );
    }
  });

  it("are served to external agents in the Power-MCP catalogue with that wording", () => {
    const catalogue = powerToolCatalogue(createDefaultToolRegistry());
    for (const name of ["get_quality_audit", "check_stage_audit"]) {
      const entry = catalogue.find((t) => t.name === name);
      expect(entry).toBeDefined();
      expect(entry?.description).toContain("instead of running Lighthouse yourself");
      expect(entry?.gated).toBeUndefined();
    }
  });
});
