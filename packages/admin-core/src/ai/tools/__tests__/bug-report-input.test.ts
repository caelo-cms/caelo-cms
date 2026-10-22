// SPDX-License-Identifier: MPL-2.0

/**
 * #644 — the bug_report input refuses a value that carries the call's
 * other parameters as markup, the shape a live run persisted (bug report
 * 76b50b4e: `suspectedTool` and `severity` written inside `evidence`).
 */

import { describe, expect, it } from "bun:test";
import { bugReportTool, bugReportToolInput, describeBugForwarding } from "../bug-report.js";

const base = {
  title: "translate_variant fails",
  whatHappened: "Called translate_variant and it threw.",
  expected: "A translated variant.",
};

describe("bug_report input", () => {
  it("refuses evidence that swallowed the following parameters", () => {
    const parsed = bugReportToolInput.safeParse({
      ...base,
      evidence:
        'Failed query: … LIMIT 1</evidence>\n<suspectedTool">translate_variant</suspectedTool>\n<severity>degraded</severity>\n',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues[0];
    expect(issue?.path).toEqual(["evidence"]);
    expect(issue?.message).toContain("</evidence>");
    expect(issue?.message).toContain("each value in its own field");
  });

  it("accepts evidence that quotes ordinary page markup, including <title>", () => {
    const parsed = bugReportToolInput.safeParse({
      ...base,
      suspectedTool: "translate_variant",
      evidence: "<head><title>Home</title></head><main><h1>Willkommen</h1></main>",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("bug_report forwarding wording (#902)", () => {
  it("only the sent state lets the AI say the Caelo team was told", () => {
    expect(describeBugForwarding("sent")).toContain("sent to the Caelo team");
    for (const state of ["local_only", "failed"] as const) {
      const text = describeBugForwarding(state);
      expect(text).toContain("stored on this site");
      expect(text).toMatch(/NOT notified|Do not tell the operator/);
    }
    expect(describeBugForwarding("queued")).toContain("will be sent");
  });

  it("a failed report points the AI at the Owner's one-click re-send (#982)", () => {
    const text = describeBugForwarding("failed");
    expect(text).toContain("Send unsent reports");
    expect(text).toContain("you cannot re-send it yourself");
  });

  it("the description forbids claiming notification the result does not confirm", () => {
    expect(bugReportTool.description).toContain(
      "never claim the Caelo team was notified unless the result says it was sent",
    );
  });
});
