// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #667 / #727 — the acceptance contract the model reads. The dogfood
 * run that opened #667 had the AI recommend accepting all remaining
 * findings ("I'd accept all four"); two were Caelo bugs. #727: the target is
 * 100 and zero findings, and only the truly unfixable reaches the operator,
 * as a bulk decision. These pin that wording.
 */

import { describe, expect, it } from "bun:test";
import { powerToolCatalogue } from "../../ops/security/mcp_power.js";
import { createDefaultToolRegistry } from "./index.js";
import { checkStageAuditTool, getQualityAuditTool } from "./quality-audit-tools.js";
import { acceptQualityFindingsTool, publishDespiteFailedAuditTool } from "./quality-gate-tools.js";

describe("accept_quality_findings description", () => {
  const d = acceptQualityFindingsTool.description;

  // #727 "optimum, not good enough" — an AI once called a Performance 90
  // fine; sent back, it reached 100.
  it("holds the AI to the optimum before anything goes to the operator", () => {
    expect(d).toContain("Target = 100 per Lighthouse category + zero findings");
    expect(d).toContain("90 is NOT acceptable on its own");
    expect(d).toContain("Fix what is fixable");
    expect(d).toContain("never run Lighthouse yourself");
  });

  it("hands the truly unfixable to the operator as a bulk decision, never as a recommendation (#667)", () => {
    expect(d).toContain("truly CANNOT be fixed");
    expect(d).toContain("after explaining WHY it cannot be fixed");
    expect(d).toContain("never your recommendation");
    expect(JSON.stringify(acceptQualityFindingsTool.inputSchema)).toContain(
      "PREFERRED: one problem across pages",
    );
    expect(d).toContain("worse blocks again");
    expect(publishDespiteFailedAuditTool.description).toContain(
      "ONLY on the editor's explicit request",
    );
  });

  it("routes Caelo platform findings to bug_report", () => {
    expect(d).toContain("Caelo platform issue reported via `bug_report`");
    expect(getQualityAuditTool.description).toContain(
      "report via `bug_report`, never edit the site for them",
    );
  });

  it("stays approval-gated", () => {
    expect(acceptQualityFindingsTool.approvalMode).toBe("user-approval");
    expect(d).toContain("APPROVAL-GATED");
  });
});

describe("get_quality_audit holds the AI to 100", () => {
  it("says a 90 is not acceptable and to keep fixing", () => {
    const d = getQualityAuditTool.description;
    expect(d).toContain("TARGET 100 IN EVERY CATEGORY + ZERO FINDINGS");
    expect(d).toContain("90 is NOT acceptable");
    expect(d).toContain("repeat until Performance 100");
  });
});

describe("Lighthouse metrics on the quality read tools", () => {
  it("tell the agent the metrics are there and not to run Lighthouse itself", () => {
    for (const tool of [getQualityAuditTool, checkStageAuditTool]) {
      expect(tool.description).toContain("LCP");
      expect(tool.description).toContain("CLS");
      expect(tool.description).toContain(
        "Never run Lighthouse yourself: the audit runs on the real staged build",
      );
    }
  });

  it("are served to external agents in the Power-MCP catalogue with that wording", () => {
    const catalogue = powerToolCatalogue(createDefaultToolRegistry());
    for (const name of ["get_quality_audit", "check_stage_audit"]) {
      const entry = catalogue.find((t) => t.name === name);
      expect(entry).toBeDefined();
      expect(entry?.description).toContain("Never run Lighthouse yourself");
      expect(entry?.gated).toBeUndefined();
    }
  });
});
