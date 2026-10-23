// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — what a reference-integrity issue says and which
 * tool fixes it. Maintainer rule: every blocking finding is fixed by the
 * AI or decided by the Owner, so each message names the page, the place
 * (module / field / set / layout / template / default / plugin data) and
 * the tool — the AI fixes it without asking the operator anything
 * (CLAUDE.md §1A, §11).
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
  | {
      readonly kind: "structured-set";
      readonly setId: string;
      /** `<kind>/<slug>`, the name set_structured_set takes. */
      readonly set: string;
      readonly setName: string;
    }
  | { readonly kind: "plugin"; readonly pluginSlug: string; readonly label: string };

/**
 * What is wrong with a link:
 * - `missing-target`: a reference to a page or media file that no longer exists;
 * - `variant-missing`: the target has no version in the rendering page's
 *   language (rollout D's link-resolve point);
 * - `unpublished-target`: the target (or its same-language version) is a draft;
 * - `literal-link`: a literal path to an existing page (pre-#724 content the
 *   link migration left, or a write that skipped canonicalisation, #1028);
 *   it renders verbatim, and saving it again stores the reference;
 * - `broken-literal`: a literal path or media URL that matches nothing (the
 *   migration report, `get_link_migration_report`, lists these too);
 * - `pending-import-link`: a link to a page an active site import has planned
 *   but not built yet — kept literal on purpose (`import_run_links`), it
 *   converts when the import finalises its links. Never blocks.
 */
export type ReferenceProblem =
  | "missing-target"
  | "variant-missing"
  | "unpublished-target"
  | "literal-link"
  | "broken-literal"
  | "pending-import-link";

/** Where a fix goes: the tool and one sentence in its terms. */
export interface ReferenceFix {
  readonly tool: string;
  readonly hint: string;
}

/** The place, as a message names it ("in field cta_href of module "Hero""). */
export function describePlace(place: ReferencePlace, pagePaths: readonly string[]): string {
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
    case "structured-set":
      return `in navigation/structured set "${place.setName}" (${place.set})`;
    case "plugin":
      return `in data of plugin "${place.pluginSlug}": ${place.label}`;
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
      return `the link to ${target} is a plain path, not a page reference: it renders as written (not in the site's URL style, e.g. missing its trailing slash) and does not follow page moves. Fix: save the value again with the link unchanged — every write stores internal links as page references (edit_content needs a non-empty edit: add or drop the trailing slash)`;
    case "broken-literal":
      return `${target} is not the path of any page or media file (get_link_migration_report lists the links the migration could not convert): point it at an existing page (list_pages) or remove it`;
    case "pending-import-link":
      return `${target} is a page the running site import has planned but not built yet: build it; the import converts the link when it finishes (resolve_import_links), and only then does a still-unknown path count as broken`;
  }
}

/**
 * The tool that changes the link where it is stored.
 *
 * @param instanceLevel content that must be fixed on its content instance:
 *   shared by several pages, or shown through a synced placement (which
 *   set_page_module_content refuses).
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
            tool: "set_content_instance_values",
            hint: clip(
              `in content instance ${place.contentInstanceId} (module "${place.moduleName}"), field "${place.field}": ${what}`,
            ),
          }
        : {
            tool: "set_page_module_content",
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
        tool: "edit_module",
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
    case "structured-set":
      return {
        tool: "set_structured_set",
        hint: clip(`set ${place.set}, ${where}: ${what}`),
      };
    case "plugin":
      return {
        tool: "get_plugin",
        hint: clip(
          `plugin "${place.pluginSlug}" stores this link (${place.label}); change it with that plugin's tools (get_plugin lists them): ${what}`,
        ),
      };
  }
}

const LABEL: Readonly<Record<ReferenceProblem, string>> = {
  "missing-target": "Link to a deleted target",
  "variant-missing": "Link without a same-language page",
  "unpublished-target": "Link to an unpublished page",
  "literal-link": "Link stored as a plain path",
  "broken-literal": "Broken legacy link",
  "pending-import-link": "Link to a page the import has not built yet",
};

/** One AI-actionable message: label, the link, its place, the next step. */
export function issueMessage(
  problem: ReferenceProblem,
  place: ReferencePlace,
  pagePaths: readonly string[],
  target: string,
  variant: string | null,
  fix: ReferenceFix,
): string {
  return clip(
    `${LABEL[problem]}: ${describePlace(place, pagePaths)} — ${remedy(problem, target, variant)}. Fix with ${fix.tool}.`,
    1000,
  );
}

function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
