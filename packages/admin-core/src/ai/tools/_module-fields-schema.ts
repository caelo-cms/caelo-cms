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
 * could not emit a list field (e.g. a footer nav menu — which CLAUDE.md §1A
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

/** The supported field kinds — identical set to `MODULE_FIELD_KINDS` in `@caelo-cms/shared`. */
const MODULE_FIELD_KINDS = [
  "text",
  "richtext",
  "url",
  "image",
  "number",
  "boolean",
  "link",
  "list",
  "module",
  "module-list",
] as const;

const SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";
const LIST_REF_PATTERN = "^caelo:list/[0-9a-f-]{36}$";

/** A link value of a list entry (`{ href, target? }`, docs/lists.md §2). */
const LINK_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["href"],
  properties: {
    href: { type: "string", minLength: 1, maxLength: 2000 },
    target: { type: "string", enum: ["_self", "_blank"] },
  },
} as const;

/**
 * The values of a local list entry in the STRICT shape structured output
 * accepts (every object closed): the fields of the shipped `texts`,
 * `links` and `menu` types. Moduleize authors those; custom list types
 * are authored through the module tools (lenient values below).
 */
const STRICT_ENTRY_VALUES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    label: { type: "string" },
    link: LINK_VALUE_SCHEMA,
  },
} as const;

/** Entry values for the module tools: any field of the named list type. */
const ENTRY_VALUES_SCHEMA = {
  type: "object",
  description:
    "The entry's values, keyed by the list type's field names (texts: {text}; links / menu: {label, link: {href}}).",
  additionalProperties: {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      LINK_VALUE_SCHEMA,
      { type: "array", items: { type: "string" } },
    ],
  },
} as const;

/** One local list entry, two levels deep (a menu entry and its children). */
function listEntrySchema(values: Record<string, unknown>): Record<string, unknown> {
  const leaf = {
    type: "object",
    additionalProperties: false,
    required: ["node", "values"],
    properties: { node: { type: "string" }, values },
  };
  return {
    ...leaf,
    properties: { ...leaf.properties, children: { type: "array", items: leaf } },
  };
}

/** A page query (docs/lists.md §6) — mirrors `pageQueryPartialSchema`. */
const PAGE_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    page_type: { type: "string", pattern: "^[a-z0-9-]+$" },
    terms: { type: "array", maxItems: 20, items: { type: "string" } },
    terms_mode: { type: "string", enum: ["any", "all"] },
    parent: { type: "string" },
    exclude_current: { type: "boolean" },
    order: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  },
} as const;

/** A `list` field's source (`bind: "source"`) — mirrors `sourceDefSchema`. */
const LIST_SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  description:
    'Where generated entries come from: {kind:"query", editable:[…knobs], defaults:{page_type, order, limit, …}}, ' +
    '{kind:"system", name:"breadcrumbs"|"children"|"siblings"|"page_terms"|"term_pages"} or {kind:"plugin", name}.',
  properties: {
    kind: { type: "string", enum: ["query", "system", "plugin"] },
    name: { type: "string" },
    editable: {
      type: "array",
      items: {
        type: "string",
        enum: ["page_type", "terms", "terms_mode", "parent", "exclude_current", "order", "limit"],
      },
    },
    defaults: PAGE_QUERY_SCHEMA,
  },
} as const;

/** One field object — mirrors the Zod `moduleFieldSchema` (`.strict()`). */
function moduleFieldItemSchema(entryValues: Record<string, unknown>): Record<string, unknown> {
  return {
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
      // Zod validator (`moduleFieldSchema`) then rejects: for a link list it
      // produced `default:[{}]`, which Zod's strict `{label,href}[]` refused
      // ("expected string, received undefined") AND which lost the real nav
      // values. So each branch is CONCRETE — the object-array branch pins the
      // list entry shape (`{node, values}`) so Anthropic's structure
      // enforcement makes the model fill the actual link text + URL, not `[{}]`.
      // The description states the per-kind shape (Anthropic reads it) so the
      // JSON schema and the Zod validator can't diverge (issue #106 class).
      default: {
        description:
          "The ORIGINAL value(s) this field replaced — NEVER empty/placeholder, matching the field's kind: " +
          "text/richtext/url/image/link/number/boolean → a string (exact text, href, src, or number/bool as text); " +
          'list (local) → an array of entries of the list type with the REAL text + URLs, e.g. listType "links": ' +
          '[{"node":"link","values":{"label":"Home","link":{"href":"/"}}},{"node":"link","values":{"label":"About","link":{"href":"/about"}}}]; ' +
          'listType "texts": [{"node":"text","values":{"text":"Fast"}}]; list (shared) → "caelo:list/<id>". ' +
          'Omit for module / module-list and for a list with bind "source".',
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "array", items: listEntrySchema(entryValues) },
          // Singular `link` kind: a single {label, href} default.
          {
            type: "object",
            additionalProperties: false,
            required: ["label", "href"],
            properties: { label: { type: "string" }, href: { type: "string" } },
          },
        ],
      },
      // Epic #1107 — a `list` field's binding (docs/lists.md §7).
      listType: {
        type: "string",
        pattern: SLUG_PATTERN,
        description:
          'list: the list type slug (shipped: "texts", "links", "menu", "categories", "tags").',
      },
      bind: {
        type: "string",
        enum: ["local", "shared", "source"],
        description:
          "list: local (default) = entries stored with this placement; shared = a list used in several places (menus, footer links); source = generated per page.",
      },
      list: {
        type: "string",
        pattern: LIST_REF_PATTERN,
        description: "list, bind shared: fix the list for every placement (caelo:list/<id>).",
      },
      source: LIST_SOURCE_SCHEMA,
      // issue #106 — `module`/`module-list` fields constrain nested refs to
      // modules whose stable `type` is in this allowlist. Mirror the Zod
      // bound `z.array(slugSchema).max(32)` exactly: a slug-shaped pattern
      // + maxItems 32 so the provider cannot generate an allowlist entry the
      // Validator then rejects (the same provider-vs-Zod divergence class the
      // footer bug came from). slugSchema regex = ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$.
      allowedModuleTypes: {
        type: "array",
        maxItems: 32,
        items: { type: "string", pattern: SLUG_PATTERN },
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
}

/** The `fields` array property shared by every module-authoring tool. */
export const MODULE_FIELDS_JSON_SCHEMA: Record<string, unknown> = {
  type: "array",
  maxItems: 64,
  items: moduleFieldItemSchema(ENTRY_VALUES_SCHEMA),
};

/**
 * The same fields array for SDK-native structured output (`generateObject`,
 * moduleize): every object closed, which Anthropic's `output_config.format`
 * requires, so local list entries take the shipped types' fields only.
 */
export const MODULE_FIELDS_STRUCTURED_JSON_SCHEMA: Record<string, unknown> = {
  type: "array",
  maxItems: 64,
  items: moduleFieldItemSchema(STRICT_ENTRY_VALUES_SCHEMA),
};

/**
 * The decision-support metadata properties every module-authoring tool
 * accepts: `description` (what the module is for + when to use it — surfaced
 * in `list_modules`), `kind` (coarse role tag), and the stable `type` (reusable
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
