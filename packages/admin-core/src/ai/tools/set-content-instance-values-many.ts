// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_content_instance_values_many — edits the values of 1..N
 * content_instances in one transaction (the former singular
 * set_content_instance_values is its n=1 case; retired-tools.ts maps old
 * calls here). Built from the `makeBulkTool` factory; dispatches
 * `content_instances.set_values_many`, which reuses the singular op handler
 * per item. All-or-nothing: any invalid item aborts the whole batch.
 *
 * The blast radius of each item is every page the instance renders on —
 * its own placements and everything its parents render on — so the result
 * names, per item, where the edit shows.
 */

import { setContentInstanceValuesToolInput } from "@caelo-cms/shared";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import { makeBulkTool } from "./_make-bulk-tool.js";

/** One `content_instances.set_values` result, as the bulk op returns it per item. */
interface SetValuesResult {
  readonly placementCount: number;
  readonly nestedParentCount: number;
  /** Direct parents of any kind (instances, module defaults, shared lists). */
  readonly parentCount: number;
  /** Live pages the edit shows on, directly or through its parents (#627). */
  readonly renderedPageCount: number;
  /** It also renders in layout chrome or a shared list. */
  readonly rendersSiteWide: boolean;
  readonly version: number;
}

/**
 * Where an edit shows. An instance listed in another instance's
 * `module` / `module-list` field, a module default or a shared list has no
 * placement of its own yet renders inside its parents — calling it an
 * orphan sent the AI looking for a problem that was not there (#1067), and
 * counting only placements hid the pages the edit really changed (#627).
 */
export function reachSummary(r: SetValuesResult): string {
  const pages = `Shows on ${r.renderedPageCount} page(s)`;
  const siteWide = r.rendersSiteWide ? " plus site-wide (layout chrome or a shared list)" : "";
  const parents = r.parentCount > 0 ? `, through ${r.parentCount} parent(s) that show it` : "";
  if (r.placementCount === 0 && r.parentCount === 0) {
    return "Orphan — not placed on any page and not shown by any parent.";
  }
  return `${pages}${siteWide}: ${r.placementCount} placement(s) of its own${parents}.`;
}

export const setContentInstanceValuesManyTool = makeBulkTool({
  name: "set_content_instance_values_many",
  description: [
    "Edit values of 1..N shared content_instances in one transaction. Each item propagates to EVERY page it renders on: its `synced` placements and every page of the parents that show it (blast radius = `pages` in `list_content_instances`).",
    "USE FOR: deliberate shared-content changes — check `purpose`, pages and parents first (`list_content_instances` / `get_content_instance`).",
    "DO NOT USE FOR: an edit meant for ONE page -> `set_page_module_content_many` (unsynced placement) or `fork_placement_content` first (synced); module structure -> `update_modules_many`.",
    "CORE RULES:",
    "- All-or-nothing: an invalid item aborts the batch (error names `items[i]`); nothing is written.",
    "- Optional metadata in the same write: `slug`, `displayName` (`null` clears), `purpose`.",
    "- The result names per item where the edit now shows — relay it when the reach is wider than the operator asked for.",
    INTERNAL_LINK_CONTRACT,
  ].join("\n"),
  itemInputSchema: setContentInstanceValuesToolInput,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "values"],
    properties: {
      id: { type: "string", format: "uuid" },
      values: {
        type: "object",
        additionalProperties: true,
        description:
          "Keyed by the module's field names; fully REPLACES existing values (no merge) — read via `get_content_instance` to keep other fields. " +
          'Local `list` -> entries (`[{node:"text", values:{text:"Fast"}}]`, existing entries keep `id`); shared `list` -> `caelo:list/<id>` (switches the list shown; entries via `patch_list_items_many`); source field -> editable knobs (`{limit:5}`, `{terms:[…]}` for term_pages); ' +
          "nested `module`/`module-list` -> `{moduleId, contentInstanceId}` | array; the module's stable `type` MUST be in the field's `allowedModuleTypes` when set (`list_modules` shows both) — reuse an allowed-type module, else create one with an allowed `type`.",
      },
      expectedVersion: { type: "integer", minimum: 0 },
      slug: { type: ["string", "null"], pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
      displayName: { type: ["string", "null"], minLength: 1, maxLength: 128 },
      purpose: {
        type: ["string", "null"],
        maxLength: 1000,
        description: "Why this shared row exists; rewrite when the operator's intent shifts.",
      },
    },
  },
  opName: "content_instances.set_values_many",
  formatResult: (value, input) => {
    const results = (value as { results: SetValuesResult[] }).results;
    const lines = results.map((r, i) => {
      const id = input.items[i]?.id ?? `items[${i}]`;
      return `- ${id} -> v${r.version}. ${reachSummary(r)}`;
    });
    return `${results.length} content_instance(s) updated:\n${lines.join("\n")}`;
  },
});
