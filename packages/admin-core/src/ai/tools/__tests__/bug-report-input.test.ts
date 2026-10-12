// SPDX-License-Identifier: MPL-2.0

/**
 * #644 — the bug_report input refuses a value that carries the call's
 * other parameters as markup, the shape a live run persisted (bug report
 * 76b50b4e: `suspectedTool` and `severity` written inside `evidence`).
 */

import { describe, expect, it } from "bun:test";
import { bugReportToolInput } from "../bug-report.js";

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
