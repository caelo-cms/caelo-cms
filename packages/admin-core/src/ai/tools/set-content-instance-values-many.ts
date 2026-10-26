// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_content_instance_values_many — edits the values of 1..N
 * content_instances in one transaction (the former singular
 * set_content_instance_values is its n=1 case; retired-tools.ts maps old
 * calls here). Built from the `makeBulkTool` factory; dispatches
 * `content_instances.set_values_many`, which reuses the singular op handler
 * per item. All-or-nothing: any invalid item aborts the whole batch.
 *
 * The blast radius of each item equals that instance's placement count:
 * editing a shared instance propagates to every page bound to it, so the
 * result names, per item, where the edit shows.
 */

import { setContentInstanceValuesToolInput } from "@caelo-cms/shared";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import { makeBulkTool } from "./_make-bulk-tool.js";

/**
 * Where an edit shows. An instance listed in another instance's
 * `module` / `module-list` field has no placement of its own yet renders
 * inside its parents — calling it an orphan sent the AI looking for a
 * problem that was not there.
 */
export function reachSummary(placementCount: number, nestedParentCount: number): string {
  const nested =
    nestedParentCount > 0
      ? `Nested in ${nestedParentCount} parent content instance(s) — shows wherever those render.`
      : "";
  if (placementCount > 0) {
    return `Propagated to ${placementCount} placement(s).${nested ? ` ${nested}` : ""}`;
  }
  return nested || "Orphan — not placed on any page and not nested in another module.";
}

/** One `content_instances.set_values` result, as the bulk op returns it per item. */
interface SetValuesResult {
  readonly placementCount: number;
  readonly nestedParentCount: number;
  readonly version: number;
}

export const setContentInstanceValuesManyTool = makeBulkTool({
  name: "set_content_instance_values_many",
  description: [
    "Edit the values of shared content_instances — one call for 1..N instances (`items[]`), one transaction. Each item propagates to EVERY placement bound to that instance with sync_mode `synced` (blast radius = its placement count).",
    "USE FOR: deliberate shared-content changes — check `purpose`, sample pages and placement count first (`list_content_instances` / `get_content_instance`).",
    "DO NOT USE FOR: an edit meant for ONE page -> `set_page_module_content_many` (unsynced placement) or `fork_placement_content` first (synced placement); module structure -> `update_modules_many`.",
    "CORE RULES:",
    "- All-or-nothing: an invalid item aborts the batch (the error names `items[i]`) and nothing is written.",
    "- Optional metadata in the same write: `slug`, `displayName` (`null` clears), `purpose`.",
    "- The result names per item where the edit now shows — relay it when the reach is wider than the operator asked for.",
    INTERNAL_LINK_CONTRACT.trim(),
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
          "Nested `module`/`module-list`: `{moduleId, contentInstanceId}` | array of them; the module's stable `type` MUST be in the field's `allowedModuleTypes` when set (`list_modules` shows both) — reuse an allowed-type module, else create one with an allowed `type`. " +
          'Local `list`: entry array (`[{node:"text", values:{text:"Fast"}}]`, existing entries keep `id`). Shared `list`: `caelo:list/<id>` (switches the list shown; entries via `patch_list_items_many`). Source field: its editable knobs (`{limit:5}`, `{terms:[…]}` for term_pages).',
      },
      expectedVersion: { type: "integer", minimum: 0 },
      slug: { type: ["string", "null"], pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
      displayName: { type: ["string", "null"], minLength: 1, maxLength: 128 },
      purpose: {
        type: ["string", "null"],
        maxLength: 1000,
        description:
          "Why this shared row exists; rewrite when the operator's intent for it shifts.",
      },
    },
  },
  opName: "content_instances.set_values_many",
  formatResult: (value, input) => {
    const results = (value as { results: SetValuesResult[] }).results;
    const lines = results.map((r, i) => {
      const id = input.items[i]?.id ?? `items[${i}]`;
      return `- ${id} -> v${r.version}. ${reachSummary(r.placementCount, r.nestedParentCount)}`;
    });
    return `${results.length} content_instance(s) updated:\n${lines.join("\n")}`;
  },
});
