// SPDX-License-Identifier: MPL-2.0

/**
 * Single source of truth for the module-`fields[]` JSON Schema that the AI
 * provider generates module-authoring tool calls against.
 *
 * Why this exists (issue #106 follow-up): the `fields` shape used to be
 * hand-copied into every create/edit tool's `inputSchema`. The copies
 * drifted — `add_module_to_page` / `edit_module` carried the full field-kind
 * enum (incl. the list + nested-module kinds), but `add_module_to_layout` /
 * `add_module_to_template` carried a restricted 7-primitive enum with no
 * `allowedModuleTypes`/`min`/`max`. With `additionalProperties:false` and a
 * truncated `kind` enum, a provider doing constrained generation literally
 * could not emit a `link-list` (e.g. a footer nav menu — which CLAUDE.md §1A
 * mandates be a single list field, not numbered scalars). The model would
 * narrate the intended action ("adding a footer nav") and then end the turn
 * without emitting a schema-valid tool call. That presented as "the layout
 * path never fires add_module_to_layout" — a real schema defect in our layer,
 * not model nondeterminism (CLAUDE.md §4).
 *
 * This constant mirrors the Zod `moduleFieldSchema` in
 * `@caelo-cms/shared` (the Validator that actually runs on the handler input).
 * Keep the two in lockstep: the JSON Schema bounds what the provider can
 * generate; the Zod schema is the loud-failing defense-in-depth. Every
 * module-authoring tool's `inputSchema.properties.fields` MUST reference
 * `MODULE_FIELDS_JSON_SCHEMA` so they can never diverge again.
 */

/** The 11 supported field kinds — identical set to `moduleFieldKindSchema`. */
const MODULE_FIELD_KINDS = [
  "text",
  "richtext",
  "url",
  "image",
  "number",
  "boolean",
  "link",
  "text-list",
  "link-list",
  "module",
  "module-list",
] as const;

/** One field object — mirrors the Zod `moduleFieldSchema` (`.strict()`). */
const MODULE_FIELD_ITEM_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "kind", "label"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
    kind: { type: "string", enum: [...MODULE_FIELD_KINDS] },
    label: { type: "string", minLength: 1, maxLength: 128 },
    default: {},
    // issue #106 — `module`/`module-list` fields constrain nested refs to
    // modules whose stable `type` is in this allowlist. Mirror the Zod
    // bound `z.array(slugSchema).max(32)` exactly: a slug-shaped pattern
    // + maxItems 32 so the provider cannot generate an allowlist entry the
    // Validator then rejects (the same provider-vs-Zod divergence class the
    // footer bug came from). slugSchema regex = ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$.
    allowedModuleTypes: {
      type: "array",
      maxItems: 32,
      items: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
    },
    min: { type: "integer", minimum: 0 },
    max: { type: "integer", minimum: 1 },
  },
};

/** The `fields` array property shared by every module-authoring tool. */
export const MODULE_FIELDS_JSON_SCHEMA: Record<string, unknown> = {
  type: "array",
  maxItems: 64,
  items: MODULE_FIELD_ITEM_SCHEMA,
};
