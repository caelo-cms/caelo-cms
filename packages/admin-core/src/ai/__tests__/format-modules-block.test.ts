// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — guards for the `## Modules` block's nested-field
 * rendering. The AI relies on `type` (distinct from slug) and each nested
 * field's `allowedModuleTypes` to fill a `module`/`module-list` slot with a
 * valid module without guessing — so those MUST always be surfaced, even
 * when a module has more than the 5 plain fields the block summarizes.
 */

import { describe, expect, it } from "bun:test";
import { formatModulesBlock } from "../system-prompt.js";

describe("formatModulesBlock — nested field surfacing (issue #106)", () => {
  it("renders type distinctly from slug", () => {
    const out = formatModulesBlock(
      [
        {
          id: "m1",
          slug: "button-mpqxq3ch",
          displayName: "Primary Button",
          description: "A CTA button",
          kind: "cta",
          type: "button",
          fields: [],
        },
      ],
      new Map(),
    );
    expect(out).toContain("button-mpqxq3ch");
    expect(out).toContain("type=`button`");
  });

  it("never truncates module/module-list fields even past the 5-field cap", () => {
    const out = formatModulesBlock(
      [
        {
          id: "cta1",
          slug: "cta-teaser-abc",
          displayName: "CTA Teaser",
          description: "Teaser with an embedded button",
          kind: "cta",
          type: "cta-teaser",
          fields: [
            { name: "f1", kind: "text" },
            { name: "f2", kind: "text" },
            { name: "f3", kind: "text" },
            { name: "f4", kind: "text" },
            { name: "f5", kind: "text" },
            { name: "f6", kind: "text" },
            // The nested field sits AFTER the 5-field plain cap; it must
            // still appear in full with its allowlist.
            { name: "cta", kind: "module", allowedModuleTypes: ["button"] },
          ],
        },
      ],
      new Map(),
    );
    expect(out).toContain("cta:module");
    expect(out).toContain("allowedModuleTypes=[button]");
  });

  it("marks an unconstrained nested field as accepting any type", () => {
    const out = formatModulesBlock(
      [
        {
          id: "wrap1",
          slug: "wrapper-xyz",
          displayName: "Wrapper",
          description: "Holds any module",
          kind: "content",
          type: "wrapper",
          fields: [{ name: "child", kind: "module" }],
        },
      ],
      new Map(),
    );
    expect(out).toContain("child:module");
    expect(out).toContain("(any type)");
  });
});
