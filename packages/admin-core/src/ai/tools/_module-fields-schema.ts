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

/**
 * One local list entry for moduleize's structured output, `depth` levels
 * deep: closed objects (the provider requires them), shipped types only.
 */
function listEntrySchema(values: Record<string, unknown>, depth: number): Record<string, unknown> {
  const properties: Record<string, unknown> = { node: { type: "string" }, values };
  if (depth > 1) {
    properties.children = { type: "array", items: listEntrySchema(values, depth - 1) };
  }
  return { type: "object", additionalProperties: false, required: ["node", "values"], properties };
}

/**
 * A list entry as the module TOOLS take it. Deliberately lenient and
 * one level deep: this schema rides in every module-authoring tool, which
 * are always loaded, so each character is paid on every call. The full
 * three-level, field-by-field version cost ~4.6k characters per tool and
 * pushed the static context of a chat call up by ~16k tokens (PR #1121
 * e2e-livedit token ceiling). The handler validates every entry against
 * its list type with an actionable message, so nothing is lost but bytes.
 */
const TOOL_LIST_ENTRY_SCHEMA = {
  type: "object",
  required: ["node", "values"],
  description:
    'texts {node:"text", values:{text}} · links {node:"link", values:{label, link:{href}}} · menu {node:"entry", …, children}; keep `id` on resend.',
  properties: {
    id: { type: "string" },
    node: {
      type: "string",
      description:
        'NODE kind, not the listType slug: "text" (texts), "link" (links), "entry" (menu).',
    },
    values: { type: "object" },
    children: { type: "array", items: { type: "object" } },
  },
} as const;

/** One field object — mirrors the Zod `moduleFieldSchema` (`.strict()`). */
function moduleFieldItemSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "kind", "label"],
    properties: {
      name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      kind: { type: "string", enum: [...MODULE_FIELD_KINDS] },
      label: { type: "string", minLength: 1, maxLength: 128 },
      // The ORIGINAL value the placeholder replaced; its JSON shape varies
      // by `kind`. Each branch is concrete (an empty `{}` subschema is
      // refused by structured output, and a too-generic union let the model
      // emit shapes the Zod validator then rejected — issue #106 class).
      default: {
        description:
          'ORIGINAL value(s) replaced (never a placeholder): scalar -> value; local `list` -> entries; shared `list` -> `"caelo:list/<id>"`. Omit for `module`, `module-list`, `bind:"source"`.',
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "array", items: TOOL_LIST_ENTRY_SCHEMA },
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
          'REQUIRED for `kind:"list"`: "texts", "links", "menu", "categories", "tags", "site-texts", or a custom slug (`list_list_types`).',
      },
      bind: {
        type: "string",
        enum: ["local", "shared", "source"],
        description:
          'For `kind:"list"`: `local` (default; entries live with the placement) | `shared` (site-wide menus/nav/footer/categories/tags — check `list_lists` first, edit entries via `patch_list_items_many`, share a local list via `promote_local_list`) | `source` (generated per page; placement content may set the knobs the source marks `editable`).',
      },
      list: {
        type: "string",
        pattern: LIST_REF_PATTERN,
        description: 'Required when `bind:"shared"`.',
      },
      source: {
        type: "object",
        description:
          'bind "source": {kind:"query", editable, defaults} | {kind:"system", name: breadcrumbs|children|siblings|page_terms|term_pages|pagination} | {kind:"plugin", name} (a plugin list iterated by name needs no field).',
      },
      // #1257 — an overview listing every match over follow-up pages.
      paginate: {
        type: "object",
        additionalProperties: false,
        description:
          'Overview of ALL matching pages (query without `limit`, or term_pages): page 1 here, then <path>/page/2/…; one per module. Needs a pager field (source system "pagination": {{number}}, {{link}}, is_current/is_prev/is_next). A placement may override with value `paginate`.',
        properties: {
          per_page: { type: "integer", minimum: 1, maximum: 50, description: "Default 50." },
          follow_ups: {
            type: "string",
            enum: ["index", "noindex"],
            description: 'Default "index" (self-canonical, in sitemap).',
          },
        },
      },
      // issue #106 — mirror the Zod bound `z.array(slugSchema).max(32)`.
      allowedModuleTypes: {
        type: "array",
        maxItems: 32,
        description:
          'For `module`/`module-list`: whitelist of stable module `type`s (e.g. `["button"]`), NOT slugs. Widen if a valid module is rejected.',
        items: { type: "string", pattern: SLUG_PATTERN },
      },
      // Mirror the Zod list bounds exactly (z.number().int().positive().max(256)).
      min: { type: "integer", minimum: 0 },
      max: { type: "integer", minimum: 1, maximum: 256 },
    },
  };
}

/** The `fields` array property shared by every module-authoring tool. */
export const MODULE_FIELDS_JSON_SCHEMA: Record<string, unknown> = {
  type: "array",
  maxItems: 64,
  items: moduleFieldItemSchema(),
};

/** The field kinds moduleize emits (its SYSTEM prompt names exactly these). */
const MODULEIZE_FIELD_KINDS = [
  "text",
  "richtext",
  "url",
  "image",
  "number",
  "boolean",
  "link",
  "list",
] as const;

/**
 * The fields array for moduleize's SDK-native structured output
 * (`generateObject`): every object closed, which Anthropic's
 * `output_config.format` requires, and ONLY what moduleize produces —
 * scalar kinds plus local lists of the shipped types. Binding, sources,
 * min / max and nested-module whitelists are module-tool concerns: carried
 * here they pushed the schema to 28 optional parameters, past the
 * provider's grammar limit of 24, and every moduleize call failed with
 * "Schemas contains too many optional parameters" (PR #1121, e2e-livedit
 * run 40294659332). `moduleize-schema-budget.test.ts` pins the budget.
 *
 * @param listTypes the list types a `list` field may name — an enum, never
 *   a free slug (#1171): the model invented slugs the validator then
 *   refused on every repair attempt.
 */
export function moduleizeFieldsJsonSchema(listTypes: readonly string[]): Record<string, unknown> {
  return {
    type: "array",
    maxItems: 64,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind", "label"],
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        kind: { type: "string", enum: [...MODULEIZE_FIELD_KINDS] },
        label: { type: "string", minLength: 1, maxLength: 128 },
        default: {
          description:
            "The ORIGINAL value(s) this field replaced — NEVER empty/placeholder: " +
            "text/richtext/url/image/link/number/boolean → a string; " +
            'list → its entries with the REAL text + URLs, e.g. listType "links": ' +
            '[{"node":"link","values":{"label":"Home","link":{"href":"/"}}}]; listType "texts": [{"node":"text","values":{"text":"Fast"}}].',
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "array", items: listEntrySchema(STRICT_ENTRY_VALUES_SCHEMA, 2) },
            {
              type: "object",
              additionalProperties: false,
              required: ["label", "href"],
              properties: { label: { type: "string" }, href: { type: "string" } },
            },
          ],
        },
        listType: {
          type: "string",
          enum: [...new Set(listTypes)],
          description: "REQUIRED for a list field: the list type its entries follow.",
        },
      },
    },
  };
}

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
