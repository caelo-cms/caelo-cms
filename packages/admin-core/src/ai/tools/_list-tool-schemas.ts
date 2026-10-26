// SPDX-License-Identifier: MPL-2.0

/**
 * Hand-written, compact JSON Schemas for the large list / page-type write
 * tools (epic #1107).
 *
 * Every catalogue tool's definition counts toward each chat call's input,
 * deferred ones included. Generated from the ops' Zod inputs, these five
 * schemas spelled the field-definition union out once per position and
 * the entry tree with `$defs`: ~28k characters, most of the ~11k tokens
 * per call the lists epic added, enough to push the real-AI homepage
 * scenario over its input ceiling (v0.11.0 release, PR #1143). These keep
 * the top-level shape exact (names, required keys, closed objects where a
 * stray key is a likely mistake) and describe the nested shapes in one
 * line each; the op's own Zod schema still validates every call (it is
 * the tool's `schema`), and its refusals name the path and the fix.
 */

const ENTRY = {
  type: "object",
  description:
    "{node, values, children?, query?, id?} — node = the node KIND (list_list_types); values keyed by its fields; keep `id` of existing entries.",
} as const;

/** upsert_lists_many */
export const UPSERT_LISTS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lists"],
  properties: {
    lists: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "name", "purpose", "type", "items"],
        properties: {
          slug: { type: "string" },
          name: { type: "string" },
          purpose: { type: "string" },
          type: { type: "string", description: "list type slug" },
          items: { type: "array", items: ENTRY },
          expectedVersion: { type: "integer" },
        },
      },
    },
  },
} as const;

/** patch_list_items_many */
export const PATCH_LIST_ITEMS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lists"],
  properties: {
    lists: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "patches"],
        properties: {
          slug: { type: "string" },
          expectedVersion: { type: "integer" },
          patches: {
            type: "array",
            items: {
              type: "object",
              required: ["op"],
              description:
                '{op:"add", parentId?, position?, item} | {op:"update", itemId, values?, query?} | {op:"move", itemId, parentId?, position} | {op:"remove", itemId}',
              properties: { op: { type: "string", enum: ["add", "update", "move", "remove"] } },
            },
          },
        },
      },
    },
  },
} as const;

/** preview_list_source */
export const PREVIEW_LIST_SOURCE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "Name the source ONE way: `source` (+ value, vocabulary) | `list` + `itemId` (a saved source entry) | `list` + `node` (+ value) | `moduleId` + `field` (+ contentInstanceId).",
  properties: {
    pageId: { type: "string", description: "the page the entries are generated for" },
    source: { type: "object", description: "a source definition (query / system / plugin)" },
    value: { type: "object", description: "query knob overrides, or {terms} for term_pages" },
    vocabulary: { type: "string" },
    list: { type: "string", description: "slug or caelo:list/<id>" },
    itemId: { type: "string" },
    node: { type: "string" },
    moduleId: { type: "string" },
    field: { type: "string" },
    contentInstanceId: { type: "string" },
  },
} as const;

/** upsert_list_types_many */
export const UPSERT_LIST_TYPES_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["listTypes"],
  properties: {
    listTypes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "name", "purpose", "role", "root", "nodes"],
        properties: {
          slug: { type: "string" },
          name: { type: "string" },
          purpose: { type: "string" },
          role: { type: "string", enum: ["navigation", "vocabulary", "content"] },
          root: {
            type: "object",
            required: ["allow"],
            properties: {
              allow: { type: "array", items: { type: "string" } },
              max: { type: "integer" },
            },
          },
          nodes: {
            type: "object",
            description:
              "{<kind>: {label, fields:[{name, label, type, required?, default?, options?, list?, multiple?, accepts?, ext?}], children?:{name, allow, max?}, current_from?, source?}}",
          },
          max_depth: { type: "integer" },
          expectedVersion: { type: "integer" },
        },
      },
    },
    dropValues: { type: "boolean" },
  },
} as const;

/** upsert_page_types_many */
export const UPSERT_PAGE_TYPES_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pageTypes"],
  properties: {
    pageTypes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "name", "purpose", "templates", "defaultTemplate"],
        properties: {
          slug: { type: "string" },
          name: { type: "string" },
          purpose: { type: "string" },
          templates: { type: "array", items: { type: "string" } },
          defaultTemplate: { type: "string" },
          properties: {
            type: "array",
            items: {
              type: "object",
              description: "a field: {name, label, type, required?, default?, options?, …}",
            },
          },
          vocabularies: {
            type: "array",
            items: {
              type: "object",
              description: "{list: <vocabulary list id>, cardinality: one|many, required?}",
            },
          },
          expectedVersion: { type: "integer" },
        },
      },
    },
    dropValues: { type: "boolean" },
  },
} as const;
