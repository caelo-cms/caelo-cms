// SPDX-License-Identifier: MPL-2.0

/**
 * issue #301 — unit tests for the skill-allowlist op→tool translation
 * layer. Locks in:
 *   1. completeness — every op-notation entry that appears in a seeded
 *      skill allowlist (migration 0033) resolves against the REAL
 *      default tool registry (no entry can silently zero-match again);
 *   2. the migration-0157 target arrays are exactly what the table
 *      normalizes the seeded arrays to (SQL and code cannot drift);
 *   3. entry resolution semantics (exact / translated / context-served
 *      / unresolved + nearest-name suggestion);
 *   4. save-time validation (reject with entry + suggestion; normalize
 *      with order-preserving dedupe).
 */

import { describe, expect, it } from "bun:test";

import {
  OP_NAME_TO_TOOL_NAMES,
  resolveAllowlistEntries,
  resolveAllowlistEntry,
  suggestNearestToolName,
  validateAllowlistEntries,
} from "../chat-runner/allowlist-mapping.js";
import { liveToolNames } from "../tools/live-tool-names.js";

/**
 * Every op-notation allowlist entry seeded by migration 0033 (qa-check,
 * legal-check, menu-auditor, page-categorizer). If a future migration
 * seeds a new op-notation entry, add it here AND to the table — the
 * completeness test below fails otherwise.
 */
const SEEDED_OP_NOTATION_ENTRIES = [
  "pages.get_with_modules",
  "pages.get",
  "pages.list",
  "glossary.list",
  "style_guide.get",
  "ai_memory.list",
  "structured_sets.get",
  "structured_sets.list",
  "redirects.lookup",
  "redirects.list",
] as const;

describe("OP_NAME_TO_TOOL_NAMES completeness (issue #301)", () => {
  it("covers every op-notation entry seeded into skill allowlists", () => {
    for (const entry of SEEDED_OP_NOTATION_ENTRIES) {
      expect(OP_NAME_TO_TOOL_NAMES[entry]).toBeDefined();
    }
  });

  it("every seeded entry resolves against the REAL default registry — none can zero-match", () => {
    const live = liveToolNames();
    for (const entry of SEEDED_OP_NOTATION_ENTRIES) {
      const r = resolveAllowlistEntry(entry, live);
      expect(r.kind).not.toBe("unresolved");
    }
  });

  it("every table target is a live tool in the default registry", () => {
    const live = liveToolNames();
    for (const [op, toolNames] of Object.entries(OP_NAME_TO_TOOL_NAMES)) {
      for (const name of toolNames) {
        expect(live.has(name), `${op} maps to unknown tool ${name}`).toBe(true);
      }
    }
  });

  it("normalizes the 0033-seeded arrays to EXACTLY the 0157 migration targets", () => {
    const live = liveToolNames();
    const cases: Array<{ seeded: string[]; expected: string[] }> = [
      {
        // qa-check
        seeded: [
          "pages.get_with_modules",
          "pages.get",
          "pages.list",
          "glossary.list",
          "style_guide.get",
          "ai_memory.list",
          "structured_sets.get",
          "structured_sets.list",
        ],
        expected: [
          "inspect_page_render",
          "list_pages",
          "get_structured_set",
          "list_structured_sets",
        ],
      },
      {
        // legal-check
        seeded: ["pages.get_with_modules", "pages.get", "pages.list", "glossary.list"],
        expected: ["inspect_page_render", "list_pages"],
      },
      {
        // menu-auditor
        seeded: [
          "structured_sets.list",
          "structured_sets.get",
          "redirects.lookup",
          "redirects.list",
          "pages.list",
        ],
        expected: ["list_structured_sets", "get_structured_set", "find_redirects", "list_pages"],
      },
      {
        // page-categorizer
        seeded: ["pages.list", "pages.get"],
        expected: ["list_pages"],
      },
    ];
    for (const { seeded, expected } of cases) {
      const v = validateAllowlistEntries(seeded, live);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.normalized).toEqual(expected);
    }
  });
});

describe("resolveAllowlistEntry", () => {
  const live = new Set(["edit_module", "list_pages", "list_structured_sets"]);

  it("exact live tool name wins before the translation table", () => {
    expect(resolveAllowlistEntry("edit_module", live)).toEqual({
      kind: "tool",
      toolNames: ["edit_module"],
    });
  });

  it("op notation translates via the table", () => {
    expect(resolveAllowlistEntry("structured_sets.list", live)).toEqual({
      kind: "translated",
      toolNames: ["list_structured_sets"],
    });
  });

  it("context-served ops (system-prompt reads) resolve to nothing, explicitly", () => {
    expect(resolveAllowlistEntry("glossary.list", live)).toEqual({ kind: "context-served" });
    expect(resolveAllowlistEntry("ai_memory.list", live)).toEqual({ kind: "context-served" });
  });

  it("a table entry whose tool is not registered in THIS process surfaces the mapped name", () => {
    // structured_sets.get maps to get_structured_set, absent from `live`.
    expect(resolveAllowlistEntry("structured_sets.get", live)).toEqual({
      kind: "unresolved",
      suggestion: "get_structured_set",
    });
  });

  it("unknown names are unresolved with a nearest-name suggestion", () => {
    expect(resolveAllowlistEntry("edit_modul", live)).toEqual({
      kind: "unresolved",
      suggestion: "edit_module",
    });
  });
});

describe("resolveAllowlistEntries", () => {
  it("partitions a mixed allowlist and dedupes the resolved set", () => {
    const live = new Set(["edit_module", "list_pages"]);
    const r = resolveAllowlistEntries(
      ["edit_module", "pages.list", "pages.get", "glossary.list", "no.such_op"],
      live,
    );
    expect([...r.resolvedToolNames].sort()).toEqual(["edit_module", "list_pages"]);
    expect(r.translated).toEqual([
      { entry: "pages.list", toolNames: ["list_pages"] },
      { entry: "pages.get", toolNames: ["list_pages"] },
    ]);
    expect(r.contextServed).toEqual(["glossary.list"]);
    expect(r.unresolved.length).toBe(1);
    expect(r.unresolved[0]?.entry).toBe("no.such_op");
  });
});

describe("validateAllowlistEntries (save-time gate)", () => {
  const live = new Set(["edit_module", "list_pages", "list_structured_sets"]);

  it("normalizes op notation to tool names with order-preserving dedupe", () => {
    const v = validateAllowlistEntries(
      ["pages.get", "pages.list", "edit_module", "glossary.list"],
      live,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.normalized).toEqual(["list_pages", "edit_module"]);
  });

  it("rejects unknown entries, naming each with its suggestion", () => {
    const v = validateAllowlistEntries(["edit_modul", "wholly_unrelated_xyz"], live);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems).toEqual([
        { entry: "edit_modul", suggestion: "edit_module" },
        { entry: "wholly_unrelated_xyz", suggestion: null },
      ]);
    }
  });

  it("an empty allowlist is valid and stays empty (no narrowing)", () => {
    const v = validateAllowlistEntries([], live);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.normalized).toEqual([]);
  });
});

describe("suggestNearestToolName", () => {
  const live = new Set(["list_pages", "get_structured_set", "edit_module"]);

  it("flips op notation to verb_domain and finds the exact tool", () => {
    expect(suggestNearestToolName("pages.list", live)).toBe("list_pages");
  });

  it("catches singular/plural drift within the edit-distance cap", () => {
    expect(suggestNearestToolName("get_structured_sets", live)).toBe("get_structured_set");
  });

  it("suppresses suggestions too far away to be a plausible typo", () => {
    expect(suggestNearestToolName("qqqqqqqqqqqq", live)).toBeNull();
  });
});
