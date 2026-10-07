// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { classifyStageChanges, type StageChange, withInstallRules } from "../classify.js";

const NO_INSTALL_RULES = { firstStage: false, activatedPlugins: [], previousNotClean: null };

function rules(changes: StageChange[]): string[] {
  return classifyStageChanges(changes).reasons.map((r) => r.rule);
}

describe("classifyStageChanges — audit", () => {
  it("module created or its html/css/js changed", () => {
    expect(rules([{ entity: "module", entityId: "m1", label: "Hero", change: "created" }])).toEqual(
      ["module_code"],
    );
    expect(
      rules([{ entity: "module", entityId: "m1", label: "Hero", change: "code_changed" }]),
    ).toEqual(["module_code"]);
  });

  it("layout, template and theme changes", () => {
    expect(
      rules([
        { entity: "layout", entityId: "s1", label: "layout chrome" },
        { entity: "template", entityId: "t1", label: "Blog" },
        { entity: "theme", entityId: "th1", label: "Default" },
      ]),
    ).toEqual(["layout", "template", "theme"]);
  });

  it("new pages: created, or published for the first time", () => {
    expect(
      rules([
        { entity: "page", entityId: "p1", label: "Pricing", change: "created" },
        { entity: "page", entityId: "p2", label: "About", change: "published" },
      ]),
    ).toEqual(["new_page", "new_page"]);
  });

  it("plugin configuration that renders on pages", () => {
    expect(rules([{ entity: "pluginConfig", entityId: "pl", label: "forms · fields" }])).toEqual([
      "plugin_config",
    ]);
  });
});

describe("classifyStageChanges — skip", () => {
  it("field values, placements, page metadata, lists and deletions only", () => {
    const c = classifyStageChanges([
      { entity: "content", entityId: "c1", label: "hero copy" },
      { entity: "placement", entityId: "p1", label: "Home" },
      { entity: "page", entityId: "p1", label: "Home", change: "updated" },
      { entity: "page", entityId: "p2", label: "Old", change: "deleted" },
      { entity: "list", entityId: "n1", label: "Main menu" },
      { entity: "module", entityId: "m1", label: "Hero", change: "other" },
      { entity: "module", entityId: "m2", label: "Gone", change: "deleted" },
    ]);
    expect(c.auditNeeded).toBe(false);
    expect(c.reasons).toEqual([]);
    expect(c.skipped).toEqual([
      "field values: hero copy",
      "placements: Home",
      "page updated: Home",
      "page deleted: Old",
      "list: Main menu",
      "module fields/metadata only: Hero",
      "module deleted: Gone",
    ]);
  });

  it("an empty Stage needs no audit", () => {
    expect(classifyStageChanges([]).auditNeeded).toBe(false);
  });

  it("one audit-worthy change among content edits is enough", () => {
    const c = classifyStageChanges([
      { entity: "content", entityId: "c1", label: "copy" },
      { entity: "module", entityId: "m1", label: "Hero", change: "code_changed" },
    ]);
    expect(c.auditNeeded).toBe(true);
    expect(c.reasons).toEqual([{ rule: "module_code", entityId: "m1", label: "Hero" }]);
  });
});

describe("withInstallRules", () => {
  const contentOnly = classifyStageChanges([{ entity: "content", entityId: "c", label: "copy" }]);

  it("keeps a content-only chat Stage skipped when nothing install-wide applies", () => {
    expect(withInstallRules(contentOnly, NO_INSTALL_RULES).auditNeeded).toBe(false);
  });

  it("audits a staging deploy without a chat", () => {
    expect(withInstallRules(null, NO_INSTALL_RULES).reasons.map((r) => r.rule)).toEqual([
      "no_chat_context",
    ]);
  });

  it("audits the first Stage, plugin activations and an unclean previous audit", () => {
    const c = withInstallRules(contentOnly, {
      firstStage: true,
      activatedPlugins: [{ id: "pl1", slug: "forms" }],
      previousNotClean: { auditRunId: "a0", status: "problems" },
    });
    expect(c.auditNeeded).toBe(true);
    expect(c.reasons.map((r) => r.rule)).toEqual([
      "first_stage",
      "plugin_activation",
      "previous_not_clean",
    ]);
    expect(c.skipped).toEqual(["field values: copy"]);
  });
});
