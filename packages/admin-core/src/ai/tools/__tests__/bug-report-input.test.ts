// SPDX-License-Identifier: MPL-2.0

/**
 * #644 — the bug_report input refuses a value that carries the call's
 * other parameters as markup, the shape a live run persisted (bug report
 * 76b50b4e: `suspectedTool` and `severity` written inside `evidence`).
 */

import { describe, expect, it } from "bun:test";
import {
  bugReportTool,
  bugReportToolInput,
  describeBugForwarding,
  isPlaceholderValue,
} from "../bug-report.js";

const base = {
  kind: "defect" as const,
  title: "translate_variant fails",
  whatHappened: "Called translate_variant and it threw.",
  expected: "A translated variant row.",
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
    expect(text).toContain("you cannot send it yourself");
  });

  it("the description forbids claiming notification the result does not confirm", () => {
    expect(bugReportTool.description).toContain(
      "never claim the team was notified unless it says sent",
    );
  });
});

describe("bug_report refuses placeholder reports (#1010)", () => {
  it("refuses the exact report a real-AI run filed", () => {
    const parsed = bugReportToolInput.safeParse({
      kind: "defect",
      title: "placeholder",
      whatHappened: "n/a",
      expected: "n/a",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("whatHappened");
    expect(paths).toContain("expected");
    for (const issue of parsed.error.issues) {
      expect(issue.message).toContain("concrete observation");
      expect(issue.message).toContain("search for that tool");
    }
  });

  it("refuses a placeholder title that is long enough to pass the length floor", () => {
    const parsed = bugReportToolInput.safeParse({ ...base, title: "Placeholder" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["title"]);
    expect(parsed.error.issues[0]?.message).toContain("is a placeholder");
  });

  it.each(["placeholder", "N/A.", "[TBD]", "todo", "test", "none", "-", "...", "lorem ipsum"])(
    "treats %p as a placeholder",
    (value) => {
      expect(isPlaceholderValue(value)).toBe(true);
    },
  );

  it("refuses a placeholder in an optional field and says to leave it out", () => {
    const parsed = bugReportToolInput.safeParse({ ...base, evidence: "n/a" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["evidence"]);
    expect(parsed.error.issues[0]?.message).toContain("leave evidence out");
  });

  it("accepts a real report that mentions a placeholder word inside a sentence", () => {
    const parsed = bugReportToolInput.safeParse({
      kind: "defect",
      title: "build_page leaves placeholder text",
      whatHappened: "build_page wrote the literal value 'placeholder' into hero_title.",
      expected: "The hero_title I passed.",
    });
    expect(parsed.success).toBe(true);
  });

  it("the JSON schema the model sees carries the same length floor", () => {
    const props = bugReportTool.inputSchema.properties as Record<string, { minLength?: number }>;
    expect(props.title?.minLength).toBe(10);
    expect(props.whatHappened?.minLength).toBe(10);
    expect(props.expected?.minLength).toBe(10);
  });

  it("the description says when a report is warranted", () => {
    expect(bugReportTool.description).toContain("Only after a concrete observation");
    expect(bugReportTool.description).toContain(
      "a tool missing from YOUR list — search for it first",
    );
  });
});

describe("bug_report kind (#1192)", () => {
  const suggestion = {
    kind: "suggestion" as const,
    title: "add_tracking_tag has no page/locale filter",
    whatHappened:
      "Leadinfo had to run on German product pages only; add_tracking_tag has no page, path or locale scope, so the tag loads site-wide.",
    expected: "add_tracking_tag accepts a scope (pages, path prefixes, locales).",
    suspectedTool: "add_tracking_tag",
  };

  it("takes a suggestion without severity", () => {
    const parsed = bugReportToolInput.parse(suggestion);
    expect(parsed.kind).toBe("suggestion");
    expect(parsed.severity).toBeUndefined();
  });

  it("requires the kind: the AI decides on every report", () => {
    const { kind: _k, ...noKind } = suggestion;
    const parsed = bugReportToolInput.safeParse(noKind);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toContain("kind");
  });

  it("refuses a graded suggestion and names both ways forward", () => {
    const parsed = bugReportToolInput.safeParse({ ...suggestion, severity: "cosmetic" });
    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues[0];
    expect(issue?.path).toEqual(["severity"]);
    expect(issue?.message).toContain('Leave it out for kind="suggestion"');
    expect(issue?.message).toContain('file kind="defect"');
  });

  it("the description decides defect vs suggestion with the real reports as examples", () => {
    const d = bugReportTool.description;
    expect(d).toContain("did something MISBEHAVE?");
    expect(d).toContain('kind="defect"');
    expect(d).toContain('kind="suggestion"');
    // #1138, #1131, #1132: a missing option, a missing view, a docs gap.
    expect(d).toContain("add_tracking_tag has no page/locale filter");
    expect(d).toContain("no consent-rate overview");
    expect(d).toContain("consent log fields undocumented");
    expect(d).toContain("works as described but should do more is a suggestion");
  });

  it("the JSON schema the model sees requires kind with the contract's values", () => {
    expect(bugReportTool.inputSchema.required).toContain("kind");
    const props = bugReportTool.inputSchema.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >;
    expect(props.kind?.enum).toEqual(["defect", "suggestion"]);
    expect(props.severity?.description).toContain("Defects only");
  });
});
