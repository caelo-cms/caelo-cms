// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { parseSubagentResult, subagentSpec } from "./subagents.js";

describe("subagentSpec", () => {
  it("accepts a minimal spec with role + task", () => {
    const r = subagentSpec.safeParse({ role: "qa", task: "QA the page" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.expectedReturnShape).toBe("verdict");
    expect(r.data.maxCostMicrocents).toBe(50_000_000);
    expect(r.data.timeoutMs).toBe(60_000);
  });

  it("rejects empty role + task", () => {
    expect(subagentSpec.safeParse({ role: "", task: "x" }).success).toBe(false);
    expect(subagentSpec.safeParse({ role: "x", task: "" }).success).toBe(false);
  });

  it("rejects unknown fields (.strict)", () => {
    expect(subagentSpec.safeParse({ role: "x", task: "y", randomField: "z" }).success).toBe(false);
  });
});

describe("parseSubagentResult — verdict", () => {
  it("extracts JSON from a code fence", () => {
    const text =
      "```json\n" + JSON.stringify({ pass: true, issues: [], suggestions: ["add CTA"] }) + "\n```";
    const r = parseSubagentResult(text, "verdict");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shape).toBe("verdict");
    expect(r.value.pass).toBe(true);
    expect(r.value.suggestions).toEqual(["add CTA"]);
  });

  it("extracts JSON from prose-wrapped output", () => {
    const text =
      'Here is my verdict:\n{"pass": false, "issues": ["missing disclaimer"], "suggestions": []}\nHope that helps.';
    const r = parseSubagentResult(text, "verdict");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pass).toBe(false);
    expect(r.value.issues).toEqual(["missing disclaimer"]);
  });

  it("returns error on shape mismatch", () => {
    const text = JSON.stringify({ pass: "yes", issues: [] });
    const r = parseSubagentResult(text, "verdict");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("pass");
  });

  it("returns error on non-JSON garbage", () => {
    const r = parseSubagentResult("not json at all", "verdict");
    expect(r.ok).toBe(false);
  });
});

describe("parseSubagentResult — tree", () => {
  it("validates tree shape", () => {
    const text = JSON.stringify({
      tree: [{ label: "Root", children: [] }],
      rationale: "minimal",
    });
    const r = parseSubagentResult(text, "tree");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shape).toBe("tree");
  });
});

describe("parseSubagentResult — freeform", () => {
  it("accepts {text: ...} JSON", () => {
    const r = parseSubagentResult(JSON.stringify({ text: "summary here" }), "freeform");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("summary here");
  });

  it("falls back to raw text when JSON parse fails", () => {
    const r = parseSubagentResult("plain text response from the subagent.", "freeform");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("plain text response from the subagent.");
  });

  it("returns error on empty text", () => {
    expect(parseSubagentResult("   ", "freeform").ok).toBe(false);
  });
});
