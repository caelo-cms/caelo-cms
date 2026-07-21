// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { parseSubagentResult, subagentSpec, validateSubagentResultValue } from "./subagents.js";

describe("subagentSpec", () => {
  it("accepts a minimal spec with role + task", () => {
    const r = subagentSpec.safeParse({ role: "qa", task: "QA the page" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.expectedReturnShape).toBe("verdict");
    // issue #304 — no schema default: an omitted cap means "derive from
    // the armed run budget" in the spawn orchestrator, and a default
    // here (the old 50M µ¢) would make omission indistinguishable from
    // an explicit choice.
    expect(r.data.maxCostMicrocents).toBeUndefined();
    // Default 300s — build children (Genesis draft, migration rebuild) need
    // minutes; the old 60s aborted them mid-work (0 drafts saved).
    expect(r.data.timeoutMs).toBe(300_000);
  });

  it("rejects empty role + task", () => {
    expect(subagentSpec.safeParse({ role: "", task: "x" }).success).toBe(false);
    expect(subagentSpec.safeParse({ role: "x", task: "" }).success).toBe(false);
  });

  it("rejects unknown fields (.strict)", () => {
    expect(subagentSpec.safeParse({ role: "x", task: "y", randomField: "z" }).success).toBe(false);
  });
});

describe("validateSubagentResultValue — double-encoded payload (submit_result bug)", () => {
  // Bug: a provider double-encodes the verdict as a JSON STRING
  // (`{"result":"{\"pass\":true,...}"}`); with `result` untyped in the
  // submit_result inputSchema the encoding-repair layer couldn't decode
  // it, so a well-formed verdict reached the validator as a string and
  // was rejected as "string (scalar)". The validator now decodes a
  // JSON-looking string for structured shapes as defense-in-depth.
  it("verdict — accepts a JSON-string-encoded object", () => {
    const encoded = JSON.stringify({ pass: true, issues: [], suggestions: ["add CTA"] });
    const r = validateSubagentResultValue(encoded, "verdict");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shape).toBe("verdict");
    expect(r.value.pass).toBe(true);
    expect(r.value.suggestions).toEqual(["add CTA"]);
  });

  it("verdict — still accepts a real object (unchanged path)", () => {
    const r = validateSubagentResultValue({ pass: false, issues: ["x"] }, "verdict");
    expect(r.ok).toBe(true);
  });

  it("rebuild — accepts a JSON-string-encoded object", () => {
    const encoded = JSON.stringify({ pages: [{ slug: "/home", status: "rebuilt" }] });
    const r = validateSubagentResultValue(encoded, "rebuild");
    expect(r.ok).toBe(true);
  });

  it("verdict — a genuine non-JSON string still fails with the scalar hint", () => {
    const r = validateSubagentResultValue("looks good to me", "verdict");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("scalar");
  });

  it("freeform — a bare prose string is NOT treated as JSON", () => {
    const r = validateSubagentResultValue("plain prose", "freeform");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("plain prose");
  });
});

describe("parseSubagentResult — verdict", () => {
  it("extracts JSON from a code fence", () => {
    const text = `\`\`\`json\n${JSON.stringify({ pass: true, issues: [], suggestions: ["add CTA"] })}\n\`\`\``;
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

describe("parseSubagentResult — rebuild (issue #264)", () => {
  it("validates a full migration-batch summary", () => {
    const text = JSON.stringify({
      pages: [
        {
          pageId: "11111111-1111-4111-8111-222222222222",
          slug: "pricing",
          status: "rebuilt",
          notes: "table modernised; footnote folded into caption",
        },
        { slug: "pricing-archive", status: "skipped", notes: "operator marked obsolete" },
      ],
      contentNotes: ["source hero carried a rotating quote widget; kept the first quote only"],
      skipped: [{ item: "legacy price calculator embed", reason: "third-party script, no data" }],
      summary: "2-page batch: 1 rebuilt, 1 skipped.",
    });
    const r = parseSubagentResult(text, "rebuild");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shape).toBe("rebuild");
    if (r.shape !== "rebuild") return;
    expect(r.value.pages).toHaveLength(2);
    expect(r.value.pages[0]?.status).toBe("rebuilt");
    expect(r.value.skipped[0]?.reason).toContain("third-party");
  });

  it("defaults contentNotes/skipped/summary when omitted", () => {
    const text = `\`\`\`json\n${JSON.stringify({ pages: [{ slug: "home", status: "rebuilt" }] })}\n\`\`\``;
    const r = parseSubagentResult(text, "rebuild");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.shape !== "rebuild") return;
    expect(r.value.contentNotes).toEqual([]);
    expect(r.value.skipped).toEqual([]);
    expect(r.value.summary).toBe("");
  });

  it("rejects an empty pages array — a rebuild subagent must account for its batch", () => {
    const r = parseSubagentResult(JSON.stringify({ pages: [] }), "rebuild");
    expect(r.ok).toBe(false);
  });

  it("names the expected shape + observed keys on mismatch", () => {
    const r = parseSubagentResult(JSON.stringify({ pass: true, issues: [] }), "rebuild");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("rebuild shape mismatch");
    expect(r.error).toContain("pass");
  });

  it("rejects an out-of-enum page status", () => {
    const r = parseSubagentResult(
      JSON.stringify({ pages: [{ slug: "home", status: "done" }] }),
      "rebuild",
    );
    expect(r.ok).toBe(false);
  });
});

describe("subagentSpec — rebuild shape accepted", () => {
  it("accepts expectedReturnShape rebuild with migration-scale caps", () => {
    const r = subagentSpec.safeParse({
      role: "rebuild:blog",
      task: "REBUILD TASK — rebuild the blog cluster",
      expectedReturnShape: "rebuild",
      timeoutMs: 600_000,
      maxCostMicrocents: 100_000_000,
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.expectedReturnShape).toBe("rebuild");
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

describe("subagentSpec — model tier (issue #306)", () => {
  it("defaults tier to inherit (single-model behaviour unchanged when omitted)", () => {
    const r = subagentSpec.safeParse({ role: "qa", task: "QA the page" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.tier).toBe("inherit");
  });

  it("accepts mid and small, rejects unknown tiers", () => {
    for (const tier of ["mid", "small", "inherit"]) {
      expect(subagentSpec.safeParse({ role: "x", task: "y", tier }).success).toBe(true);
    }
    expect(subagentSpec.safeParse({ role: "x", task: "y", tier: "large" }).success).toBe(false);
  });
});

describe("parseSubagentResult — needs_escalation (issue #306)", () => {
  it("accepts a needs_escalation page WITH a reason in notes", () => {
    const r = parseSubagentResult(
      JSON.stringify({
        pages: [
          { slug: "home", status: "rebuilt" },
          { slug: "pricing", status: "needs_escalation", notes: "no matching table module" },
        ],
      }),
      "rebuild",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.shape !== "rebuild") return;
    expect(r.value.pages[1]?.status).toBe("needs_escalation");
    expect(r.value.pages[1]?.notes).toBe("no matching table module");
  });

  it("REJECTS needs_escalation without notes — a blind escalation cannot be briefed", () => {
    for (const notes of [undefined, "", "   "]) {
      const r = parseSubagentResult(
        JSON.stringify({ pages: [{ slug: "pricing", status: "needs_escalation", notes }] }),
        "rebuild",
      );
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain("needs_escalation");
    }
  });
});
