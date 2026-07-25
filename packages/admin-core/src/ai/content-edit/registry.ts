// SPDX-License-Identifier: MPL-2.0

/**
 * The single source of truth for "which DB columns are editable bodies the
 * AI reads/edits like files" (CLAUDE.md §1A DRY, §11 read-surface design).
 *
 * `read_content`, `edit_content`, and `grep_content` all iterate this
 * registry, so adding a new large-text field anywhere — a new module column,
 * a skill's instructions, a Tier-2 plugin's source — is ONE entry here plus
 * the get/list/write ops it names, not a new tool. Each target declares:
 *  - which fields are editable bodies,
 *  - the read op (`get`) + how to pull the field text out of its value,
 *  - the list op + how to pull every row's bodies (for grep),
 *  - the write op + whether it is §11.A-gated (AI proposes, Owner approves).
 */

/** Entity kinds whose large-text columns are AI-editable as "files". */
export type ContentEntityKind = "module" | "template";

export interface ContentTarget {
  readonly entityKind: ContentEntityKind;
  /** Editable body columns, in read/display order. */
  readonly fields: readonly string[];
  /** The tool/op input key naming the row (e.g. "moduleId"). */
  readonly idArg: string;
  /** Read op returning the single row (branch-aware). */
  readonly getOp: string;
  /** Extract `{field: body}` for one row from the get op's value. */
  readonly readRow: (getValue: unknown) => Record<string, string>;
  /** List op returning every row incl. bodies (for grep). */
  readonly listOp: string;
  /** Extract `[{id, slug, fields}]` from the list op's value. */
  readonly listRows: (
    listValue: unknown,
  ) => ReadonlyArray<{ id: string; slug: string; fields: Record<string, string> }>;
  readonly write: {
    /** Write op — a direct update, or a §11.A propose op when `gated`. */
    readonly op: string;
    /**
     * true → the write op is a propose (AI-scoped) whose result is an
     * Owner-approval proposal, NOT an applied change. `edit_content` then
     * reports the two-step gate instead of claiming success.
     */
    readonly gated: boolean;
    /** Build the write op input for a full-body replacement of one field. */
    readonly buildInput: (
      entityId: string,
      field: string,
      newBody: string,
    ) => Record<string, unknown>;
    /** Owner queue path surfaced in the gated-result message. */
    readonly queuePath?: string;
  };
}

interface ModuleRow {
  id: string;
  slug: string;
  html: string;
  css: string;
  js: string;
}
interface TemplateRow {
  id: string;
  slug: string;
  html: string;
  css: string;
}

export const CONTENT_TARGETS: Readonly<Record<ContentEntityKind, ContentTarget>> = {
  module: {
    entityKind: "module",
    fields: ["html", "css", "js"],
    idArg: "moduleId",
    getOp: "modules.get",
    readRow: (v) => {
      const m = (v as { module: ModuleRow }).module;
      return { html: m.html, css: m.css, js: m.js };
    },
    listOp: "modules.list",
    listRows: (v) =>
      (v as { modules: ModuleRow[] }).modules.map((m) => ({
        id: m.id,
        slug: m.slug,
        fields: { html: m.html, css: m.css, js: m.js },
      })),
    write: {
      op: "modules.update",
      gated: false,
      buildInput: (id, field, body) => ({ moduleId: id, [field]: body }),
    },
  },
  template: {
    entityKind: "template",
    fields: ["html", "css"],
    idArg: "templateId",
    getOp: "templates.get",
    readRow: (v) => {
      const t = (v as { template: TemplateRow }).template;
      return { html: t.html, css: t.css };
    },
    listOp: "templates.list",
    listRows: (v) =>
      (v as { templates: TemplateRow[] }).templates.map((t) => ({
        id: t.id,
        slug: t.slug,
        fields: { html: t.html, css: t.css },
      })),
    // templates.update is AI-blocked (§11.A — HTML/CSS rewrites cascade to
    // every bound page). The AI edits through the propose gate; the Owner
    // approves on the chat's proposal card.
    write: {
      op: "templates.propose_update",
      gated: true,
      buildInput: (id, field, body) => ({ templateId: id, [field]: body }),
      queuePath: "/security/templates/pending",
    },
  },
};

export const CONTENT_ENTITY_KINDS = Object.keys(CONTENT_TARGETS) as ContentEntityKind[];

/** Resolve a target, or null when the kind is unknown. */
export function resolveContentTarget(kind: string): ContentTarget | null {
  return (CONTENT_TARGETS as Record<string, ContentTarget>)[kind] ?? null;
}
