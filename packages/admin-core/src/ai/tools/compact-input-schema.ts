// SPDX-License-Identifier: MPL-2.0

/**
 * Model-facing schema compaction: the JSON Schema a provider sees for a tool
 * is rewritten into a smaller shape that accepts a SUPERSET of what the
 * original accepted.
 *
 * Why: the Zod -> JSON Schema export explodes on discriminated unions (every
 * shared field copied into every `oneOf` branch), emits a ~60-token regex
 * next to every `format: uuid`, and writes `maximum: 9007199254740991` for
 * every `.int()`. Around 40 % of the catalogue's tokens were that structure,
 * paid on every turn and costing constrained-decoding latency on top.
 *
 * Validation is NOT weakened: the backend Zod parse at dispatch stays the
 * sole strict authority. The compact schema is only what the model reads,
 * so every rewrite here must (a) never reject a call the original schema
 * accepted, and (b) keep every constraint it can no longer express as text
 * in a `description`, so the model is told exactly what the Zod parse will
 * enforce. The tests check both over the real registry
 * (`__tests__/compact-input-schema.*.test.ts`).
 *
 * The walker is schema-aware: it descends only into schema positions, so a
 * tool property literally named `pattern`, `format` or `$ref` is a name in a
 * `properties` map, never mistaken for a keyword.
 */

import {
  addDescription,
  canonical,
  isSchema,
  mergeAllOf,
  mergeNullable,
  mergeStringUnion,
  type Schema,
} from "./_compact-schema-merge.js";
import { flattenDiscriminatedUnion } from "./_compact-schema-union.js";
import type { ToolInputSchema } from "./dispatch.js";

/** `Number.MAX_SAFE_INTEGER`, which Zod writes as the bound of every `.int()`. */
const MAX_SAFE = 9007199254740991;

/** Formats whose meaning a model knows; Zod's regex next to them is noise. */
const SELF_DESCRIBING_FORMATS = new Set(["uuid", "date-time", "date", "email", "uri"]);

/** Keywords whose value is a map of name -> schema. */
const SCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;

/** Keywords whose value is one schema (or, for legacy `items`, a list). */
const SCHEMA_KEYS = [
  "items",
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "not",
  "propertyNames",
  "contains",
  "if",
  "then",
  "else",
] as const;

/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYS = ["oneOf", "anyOf", "allOf", "prefixItems"] as const;

/**
 * Compact a tool's provider-facing input schema. Pure: the argument is not
 * mutated.
 *
 * @param schema the resolved input schema (generated from Zod or hand-written).
 * @returns an equivalent-or-wider schema with fewer tokens.
 */
export function compactInputSchema(schema: ToolInputSchema): ToolInputSchema {
  return compactNode(schema) as ToolInputSchema;
}

function compactNode(input: unknown): unknown {
  if (!isSchema(input)) return input;
  let node: Schema = { ...input };
  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (isSchema(map)) {
      node[key] = Object.fromEntries(
        Object.entries(map).map(([name, child]) => [name, compactNode(child)]),
      );
    }
  }
  for (const key of SCHEMA_KEYS) {
    const child = node[key];
    if (Array.isArray(child)) node[key] = child.map(compactNode);
    else if (child !== undefined) node[key] = compactNode(child);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const list = node[key];
    if (Array.isArray(list)) node[key] = list.map(compactNode);
  }

  dropZodArtifacts(node);
  if (Array.isArray(node.allOf)) node = mergeAllOf(node) ?? node;
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(node[key])) {
      node =
        flattenDiscriminatedUnion(node, key) ??
        mergeStringUnion(node, key) ??
        mergeNullable(node, key) ??
        node;
    }
  }
  dropNumberArtifacts(node);
  minimiseExt(node);
  return node;
}

/** Keywords Zod v4 emits that tell a model nothing (mutates `node`). */
function dropZodArtifacts(node: Schema): void {
  if (typeof node.format === "string" && SELF_DESCRIBING_FORMATS.has(node.format)) {
    delete node.pattern;
  }
  delete node.$schema;
  if (canonical(node.propertyNames) === canonical({ type: "string" })) {
    delete node.propertyNames;
  }
  if (isSchema(node.additionalProperties) && Object.keys(node.additionalProperties).length === 0) {
    delete node.additionalProperties;
  }
}

/**
 * `.int()` bounds at +-MAX_SAFE go; an integer's `exclusiveMinimum: 0`
 * (`.positive()`) is the same set as `minimum: 1` (mutates `node`).
 */
function dropNumberArtifacts(node: Schema): void {
  if (node.maximum === MAX_SAFE) delete node.maximum;
  if (node.minimum === -MAX_SAFE) delete node.minimum;
  if (node.type === "integer" && node.exclusiveMinimum === 0) {
    delete node.exclusiveMinimum;
    node.minimum = Math.max(1, typeof node.minimum === "number" ? node.minimum : 1);
  }
}

/**
 * `ext` is a rarely filled escape hatch (a record of plugin-namespaced
 * extras). Its key pattern and value shape cost tokens on every turn for a
 * field the model almost never writes; the backend still validates both.
 */
function minimiseExt(node: Schema): void {
  const props = node.properties;
  if (!isSchema(props)) return;
  const ext = props.ext;
  if (isSchema(ext) && ext.type === "object") {
    const compact: Schema = { type: "object" };
    if (typeof ext.description === "string") addDescription(compact, ext.description);
    props.ext = compact;
  }
}
