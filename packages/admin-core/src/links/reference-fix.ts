// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — what a reference-integrity issue says and which
 * tool fixes it. Maintainer rule: every blocking finding is fixed by the
 * AI or decided by the Owner, so each message names the page, the place
 * (module / field / list / page / layout / template / default / plugin
 * data) and the tool — the AI fixes it without asking the operator
 * anything (CLAUDE.md §1A, §11).
 */

/** Where a stored link lives, in the operator's terms. */
export type ReferencePlace =
  /** A content instance's value (a page placement or a nested module). */
  | {
      readonly kind: "content";
      readonly moduleId: string;
      readonly moduleName: string;
      readonly contentInstanceId: string;
      readonly field: string;
      /** True for a nested module's content (no placement of its own). */
      readonly nested: boolean;
    }
  /** A module's HTML template — one fix for every page it is on. */
  | { readonly kind: "module-html"; readonly moduleId: string; readonly moduleName: string }
  /** A field default (layout chrome content lives here). */
  | {
      readonly kind: "module-default";
      readonly moduleId: string;
      readonly moduleName: string;
      readonly field: string;
    }
  | { readonly kind: "layout-html"; readonly layoutId: string; readonly layoutName: string }
  | { readonly kind: "template-html"; readonly templateId: string; readonly templateName: string }
  | { readonly kind: "plugin"; readonly pluginSlug: string; readonly label: string }
  /**
   * The definition of a module field (epic #1107): a `list` field's fixed
   * `list` or its `source` (query defaults, vocabulary).
   */
  | {
      readonly kind: "module-field";
      readonly moduleId: string;
      readonly moduleName: string;
      readonly field: string;
    }
  /** A shared list's entries (epic #1107) — one fix for every module that shows it. */
  | {
      readonly kind: "list";
      readonly listId: string;
      readonly listSlug: string;
      readonly listName: string;
    }
  /** A list type's source node defaults (epic #1107). */
  | { readonly kind: "list-type"; readonly listTypeId: string; readonly listTypeSlug: string }
  /** A page's terms or properties (epic #1107). */
  | { readonly kind: "page"; readonly pageId: string; readonly pagePath: string };

/**
 * What is wrong with a link:
 * - `missing-target`: a reference to a page or media file that no longer exists;
 * - `variant-missing`: the target has no version in the rendering page's
 *   language (rollout D's link-resolve point);
 * - `unpublished-target`: the target (or its same-language version) is a draft;
 * - `literal-link`: a literal path the link migration (rollout E) left as it
 *   is; it works, and saving it again stores the reference;
 * - `broken-literal`: a literal path or media URL that matches nothing (the
 *   migration report, `get_link_migration_report`, lists these too);
 * - `pending-import-link`: a link to a page an active site import has planned
 *   but not built yet — kept literal on purpose (`import_run_links`), it
 *   converts when the import finalises its links. Never blocks.
 * - `missing-list`: a `caelo:list/<id>` (a module's shared list, a
 *   vocabulary named by a source) whose list was deleted (epic #1107);
 * - `missing-term`: a `caelo:term/<listId>/<itemId>` whose vocabulary list
 *   or entry is gone (page terms, query `terms`, `term` field values);
 * - `missing-module`: a list entry's `module` field embeds a module or
 *   content instance that was deleted.
 */
export type ReferenceProblem =
  | "missing-target"
  | "variant-missing"
  | "unpublished-target"
  | "literal-link"
  | "broken-literal"
  | "pending-import-link"
  | "missing-list"
  | "missing-term"
  | "missing-module";

/** Every problem, in a stable order (op schemas enumerate them). */
export const REFERENCE_PROBLEMS = [
  "missing-target",
  "variant-missing",
  "unpublished-target",
  "literal-link",
  "broken-literal",
  "pending-import-link",
  "missing-list",
  "missing-term",
  "missing-module",
] as const satisfies readonly ReferenceProblem[];

/** Where a fix goes: the tool and one sentence in its terms. */
export interface ReferenceFix {
  readonly tool: string;
  readonly hint: string;
}

/**
 * The place, as a message names it ("in field cta_href of module "Hero"").
 *
 * @param where the position inside the place; named for places whose
 *   kind alone does not say which value it is (a list entry, a page's
 *   terms or properties, a field definition).
 */
export function describePlace(
  place: ReferencePlace,
  pagePaths: readonly string[],
  where = "",
): string {
  const at = where ? ` at ${where}` : "";
  const on =
    pagePaths.length === 0
      ? ""
      : ` on ${pagePaths
          .slice(0, 5)
          .map((p) => `"${p}"`)
          .join(", ")}${pagePaths.length > 5 ? ` and ${pagePaths.length - 5} more page(s)` : ""}`;
  switch (place.kind) {
    case "content":
      return `in field "${place.field}" of ${place.nested ? "nested " : ""}module "${place.moduleName}"${on}`;
    case "module-html":
      return `in the HTML of module "${place.moduleName}" (${place.moduleId})${on}`;
    case "module-default":
      return `in the default of field "${place.field}" of module "${place.moduleName}" (${place.moduleId})${on}`;
    case "layout-html":
      return `in layout "${place.layoutName}" (${place.layoutId})`;
    case "template-html":
      return `in template "${place.templateName}" (${place.templateId})`;
    case "plugin":
      return `in data of plugin "${place.pluginSlug}": ${place.label}`;
    case "module-field":
      return `in the definition of field "${place.field}" of module "${place.moduleName}" (${place.moduleId})${at}${on}`;
    case "list":
      return `in shared list "${place.listName}" (${place.listSlug}, ${place.listId})${at}${on}`;
    case "list-type":
      return `in a source of list type "${place.listTypeSlug}" (${place.listTypeId})${at}${on}`;
    case "page":
      return where.startsWith("properties.")
        ? `in property "${where.slice("properties.".length)}" of page "${place.pagePath}"`
        : `in the terms of page "${place.pagePath}"`;
  }
}

/** The change to make, independent of where the link is stored. */
function remedy(problem: ReferenceProblem, target: string, variant: string | null): string {
  switch (problem) {
    case "missing-target":
      return `the link points at ${target}, which was deleted: point it at an existing page (list_pages) or media file (find_media), or remove it; if the deletion was a mistake, undo it (undo_this_chat)`;
    case "variant-missing":
      return `${target} has no "${variant}" version: create it (create_variant, then translate_variant) or point the link at a page that exists in "${variant}"`;
    case "unpublished-target":
      return `${target} is a draft: publish it (set_pages_status_many) or point the link at a published page`;
    case "literal-link":
      return `the link to ${target} is still a plain path that the link migration did not convert (get_link_migration_report lists these); it works — saving the same value again stores the page reference`;
    case "broken-literal":
      return `${target} is not the path of any page or media file (get_link_migration_report lists the links the migration could not convert): point it at an existing page (list_pages) or remove it`;
    case "pending-import-link":
      return `${target} is a page the running site import has planned but not built yet: build it; the import converts the link when it finishes (resolve_import_links), and only then does a still-unknown path count as broken`;
    case "missing-list":
      return `the reference points at ${target}, which was deleted while still in use: bind an existing list instead (list_lists shows them; store caelo:list/<id>), or remove the binding; if the deletion was a mistake, undo it (undo_this_chat)`;
    case "missing-term":
      return `the term points at ${target}: pick an existing entry of the vocabulary (get_list shows the entry ids; store caelo:term/<listId>/<entryId>) or remove the term; if the removal was a mistake, undo it (undo_this_chat)`;
    case "missing-module":
      return `the entry embeds ${target}: point the entry's module field at an existing module and one of its content instances (list_modules, list_content_instances) or remove the entry; if the deletion was a mistake, undo it (undo_this_chat)`;
  }
}

/**
 * The tool that changes the link where it is stored.
 *
 * @param instanceLevel content that must be fixed on its content instance:
 *   shared by several pages, or shown through a synced placement (which
 *   set_page_module_content_many refuses).
 */
export function fixFor(
  problem: ReferenceProblem,
  place: ReferencePlace,
  target: string,
  variant: string | null,
  where: string,
  instanceLevel: boolean,
): ReferenceFix {
  const what = remedy(problem, target, variant);
  switch (place.kind) {
    case "content":
      return place.nested || instanceLevel
        ? {
            tool: "set_content_instance_values_many",
            hint: clip(
              `in content instance ${place.contentInstanceId} (module "${place.moduleName}"), field "${place.field}": ${what}`,
            ),
          }
        : {
            tool: "set_page_module_content_many",
            hint: clip(
              `field "${place.field}" of module "${place.moduleName}" on this page: ${what}`,
            ),
          };
    case "module-html":
      return {
        tool: "edit_content",
        hint: clip(
          `module ${place.moduleId} html (read_content first; the link is in ${where}): ${what} — one fix for every page the module is on`,
        ),
      };
    case "module-default":
      return {
        tool: "update_modules_many",
        hint: clip(`module ${place.moduleId}, default of field "${place.field}": ${what}`),
      };
    case "layout-html":
      return {
        tool: "propose_update_layout",
        hint: clip(`layout ${place.layoutId} html: ${what}`),
      };
    case "template-html":
      return {
        tool: "edit_content",
        hint: clip(`template ${place.templateId} html (entityKind template): ${what}`),
      };
    case "plugin":
      return {
        tool: "get_plugin",
        hint: clip(
          `plugin "${place.pluginSlug}" stores this link (${place.label}); change it with that plugin's tools (get_plugin lists them): ${what}`,
        ),
      };
    case "module-field":
      return {
        tool: "update_modules_many",
        hint: clip(
          `module ${place.moduleId}, definition of field "${place.field}" (${where}): ${what}`,
        ),
      };
    case "list":
      return {
        tool: "patch_list_items_many",
        hint: clip(
          `list "${place.listSlug}" (${place.listId}), ${where}: ${what} — change it with an update patch {op: "update", itemId, values | query} (or remove the entry); one fix for every module that shows the list`,
        ),
      };
    case "list-type":
      return {
        tool: "upsert_list_types_many",
        hint: clip(`list type "${place.listTypeSlug}" (${place.listTypeId}), ${where}: ${what}`),
      };
    case "page":
      return {
        tool: "update_pages_many",
        hint: clip(`page ${place.pageId} ("${place.pagePath}"), ${where}: ${what}`),
      };
  }
}

const LABEL: Readonly<Record<ReferenceProblem, string>> = {
  "missing-target": "Link to a deleted target",
  "variant-missing": "Link without a same-language page",
  "unpublished-target": "Link to an unpublished page",
  "literal-link": "Legacy link path",
  "broken-literal": "Broken legacy link",
  "pending-import-link": "Link to a page the import has not built yet",
  "missing-list": "Reference to a deleted list",
  "missing-term": "Term of a removed vocabulary entry",
  "missing-module": "List entry embeds a deleted module",
};

/** One AI-actionable message: label, the link, its place, the next step. */
export function issueMessage(
  problem: ReferenceProblem,
  place: ReferencePlace,
  pagePaths: readonly string[],
  target: string,
  variant: string | null,
  fix: ReferenceFix,
  where = "",
): string {
  const named =
    place.kind === "list" ||
    place.kind === "list-type" ||
    place.kind === "page" ||
    place.kind === "module-field";
  return clip(
    `${LABEL[problem]}: ${describePlace(place, pagePaths, named ? where : "")} — ${remedy(problem, target, variant)}. Fix with ${fix.tool}.`,
    1000,
  );
}

function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
