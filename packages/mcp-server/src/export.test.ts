// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — pure-renderer tests for the CLAUDE.md / skills export.
 * The HTTP + filesystem half (`runExport`) is a thin composition of
 * `postAdmin` + these renderers; the file contract is what matters.
 */

import { describe, expect, it } from "bun:test";
import { type ExportContext, renderClaudeMd, renderSkillMd } from "./export.js";

const context: ExportContext = {
  systemContext: "## Module model\n\nModules separate structure from content.",
  statusLine: "[Site status — base setup still missing] Theme: needs setup",
  skills: [
    {
      slug: "site-migrate",
      displayName: "Site migrate",
      description: "Staged flow for rebuilding an existing site.",
      allowlistedTools: ["build_page"],
      body: "Homepage first, then key page types.",
    },
  ],
};

describe("renderClaudeMd", () => {
  it("embeds the system context, status line, and a skills index pointing at .claude/skills", () => {
    const md = renderClaudeMd(context, "2026-08-03T00:00:00.000Z");
    expect(md).toContain("# Caelo site context");
    expect(md).toContain("2026-08-03T00:00:00.000Z");
    expect(md).toContain("## Module model");
    expect(md).toContain("Theme: needs setup");
    expect(md).toContain(".claude/skills/<slug>/SKILL.md");
    expect(md).toContain("- site-migrate: Staged flow for rebuilding an existing site.");
    // The generated file must set expectations about publish semantics.
    expect(md).toContain("preview branch");
  });

  it("renders a complete-setup line when the status line is null", () => {
    const md = renderClaudeMd({ ...context, statusLine: null }, "2026-08-03T00:00:00.000Z");
    expect(md).toContain("Base setup complete.");
  });
});

describe("renderSkillMd", () => {
  it("emits frontmatter (name, single-line description) followed by the body", () => {
    const md = renderSkillMd({
      ...context.skills[0]!,
      description: "Line one\nline two",
    });
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: site-migrate");
    expect(md).toContain("description: Line one line two");
    expect(md).toContain("Homepage first, then key page types.");
  });
});
