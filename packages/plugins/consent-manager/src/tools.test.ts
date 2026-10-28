// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { DEFAULT_CATEGORIES } from "./categories.js";
import { CONSENT_TOOLS } from "./tools.js";

const tool = (name: string) => {
  const spec = CONSENT_TOOLS.find((t) => t.name === name);
  if (!spec) throw new Error(`no tool ${name}`);
  return spec;
};

describe("embed decisions", () => {
  // A module that renders for every visitor sends its requests before any
  // consent, which the operator cannot take back once a page was served.
  // The AI used to make that call alone via classify_external_embed's
  // `allow` flag; it now needs the Owner's click (CLAUDE.md §11.A).
  it("renders an embed for everyone only through the approval-gated tool", () => {
    const allow = tool("allow_external_embed");
    expect(allow.approvalMode).toBe("user-approval");
    expect(allow.requiredPermission).toBe("settings.write");
    expect(allow.approvalPreviewFullArgs).toEqual(["hosts", "reason"]);
    // Judged on the chat's draft, where the module the Owner saw lives.
    expect(allow.approvedOnChatBranch).toBe(true);
  });

  it("lets the ungated tool only keep an embed withheld until consent", () => {
    const classify = tool("classify_external_embed");
    expect(classify.approvalMode).toBeUndefined();
    const props = (classify.inputJsonSchema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(Object.keys(props).sort()).toEqual(["category", "moduleId"]);
    const alwaysOn = DEFAULT_CATEGORIES.filter((c) => c.required).map((c) => c.key);
    expect(alwaysOn.length).toBeGreaterThan(0);
    for (const key of alwaysOn) expect(props.category?.enum).not.toContain(key);
  });

  it("gives each embed decision its own operation", () => {
    // The host finds a tool by its operation; two tools on one operation
    // would let the ungated one stand in for the gated one.
    expect(tool("classify_external_embed").operationName).toBe("classify_embed");
    expect(tool("allow_external_embed").operationName).toBe("allow_embed");
    const ops = CONSENT_TOOLS.map((t) => t.operationName);
    expect(new Set(ops).size).toBe(ops.length);
  });
});
