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
    // A field's default is the ORIGINAL value the placeholder replaced; its
    // JSON shape varies by `kind`. This used to be `{}` (accept any) — fine as
    // a TOOL input (lenient), but the SDK-native structured-output path
    // (`generateObject` → Anthropic `output_config.format`) REJECTS an empty
    // `{}` subschema, and a too-generic union let the model emit shapes the
    // Zod validator (`moduleFieldSchema`) then rejects: for a `link-list` it
    // produced `default:[{}]`, which Zod's strict `{label,href}[]` refused
    // ("expected string, received undefined") AND which lost the real nav
    // values. So each branch is CONCRETE — the object-array branch pins the
    // link-list element shape to `{label,href}` so Anthropic's structure
    // enforcement makes the model fill the actual link text + URL, not `[{}]`.
    // The description states the per-kind shape (Anthropic reads it) so the
    // JSON schema and the Zod validator can't diverge (issue #106 class).
    default: {
      description:
        "The ORIGINAL value(s) this field replaced — NEVER empty/placeholder, matching the field's kind: " +
        "text/richtext/url/image/link/number/boolean → a string (exact text, href, src, or number/bool as text); " +
        "text-list → an array of strings; " +
        'link-list → an array of {label, href} objects with the REAL link text + URL, e.g. [{"label":"Home","href":"/"},{"label":"About","href":"/about"}]. ' +
        "Omit for module / module-list.",
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "array", items: { type: "string" } },
        {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "href"],
            properties: { label: { type: "string" }, href: { type: "string" } },
          },
        },
        // Singular `link` kind: a single {label, href} default.
        {
          type: "object",
          additionalProperties: false,
          required: ["label", "href"],
          properties: { label: { type: "string" }, href: { type: "string" } },
        },
      ],
    },
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
    // Mirror the Zod list bounds exactly: `min` = nonnegative int,
    // `max` = positive int capped at 256 (z.number().int().positive().max(256)).
    // Without the `maximum`, a provider could emit max: 9999 that the JSON
    // schema allows but the Validator rejects — the provider-vs-Zod divergence
    // this file exists to prevent.
    min: { type: "integer", minimum: 0 },
    max: { type: "integer", minimum: 1, maximum: 256 },
  },
};

/** The `fields` array property shared by every module-authoring tool. */
export const MODULE_FIELDS_JSON_SCHEMA: Record<string, unknown> = {
  type: "array",
  maxItems: 64,
  items: MODULE_FIELD_ITEM_SCHEMA,
};

/**
 * The decision-support metadata properties every module-authoring tool
 * accepts: `description` (what the module is for + when to use it — surfaced
 * in `## Modules`), `kind` (coarse role tag), and the stable `type` (reusable
 * class a parent's `allowedModuleTypes` matches against).
 *
 * Why shared (issue #106 — step-13 round-4 deviation): these three props lived
 * inline in `add_module_to_page` only. `add_module_to_layout` /
 * `add_module_to_template` omitted them while keeping `additionalProperties:
 * false`, so when the AI reused its page-authoring pattern (CLAUDE.md §1A —
 * one consistent authoring surface) and passed `kind`/`type`/`description` on
 * the layout/template tools, the dispatcher rejected the call with
 * `unrecognized_keys`. That is the exact issue-#106 class: the live-edit AI
 * builds a tool call the Validator rejects because the AI-facing surface is
 * inconsistent across sibling tools. Spreading this constant into all three
 * `inputSchema.properties` blocks (and the Zod schemas in `@caelo-cms/shared`)
 * keeps them in lockstep so the drift can't recur.
 *
 * Mirrors the Zod fields in `addModuleTo*ToolInput`. `type`'s pattern is the
 * `slugSchema` regex the Validator enforces, so a provider doing constrained
 * generation can't emit a `type` the handler then rejects.
 */
export const MODULE_META_JSON_SCHEMA_PROPS: Record<string, unknown> = {
  description: { type: "string", maxLength: 1000 },
  kind: {
    type: "string",
    enum: ["chrome", "hero", "content", "cta", "utility"],
  },
  type: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
  },
};
