// SPDX-License-Identifier: MPL-2.0

/**
 * Building blocks of the model-facing schema compaction
 * (`compact-input-schema.ts`). Every merge returns `null` when it cannot
 * produce a schema that accepts at least everything the input accepted;
 * the caller then keeps the node unchanged. That "bail out, never narrow"
 * rule is what lets the compaction run over every tool unattended.
 */

/** A JSON Schema node (or any plain JSON object). */
export type Schema = Record<string, unknown>;

/** True for a plain JSON object (a schema node or a name -> schema map). */
export function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key-order-insensitive JSON, for structural equality of schemas. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isSchema(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
}

/** Deep copy of a JSON value. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Append (or, with `front`, prepend) `text` to a node's description, unless
 * it already says it (mutates `node`).
 */
export function addDescription(node: Schema, text: string | undefined, front = false): void {
  if (!text) return;
  const old = typeof node.description === "string" ? node.description : "";
  if (old.includes(text)) return;
  node.description = old ? (front ? `${text} ${old}` : `${old} ${text}`) : text;
}

/** `a`|`b` — how per-variant values are named in descriptions. */
export function formatValues(values: readonly unknown[]): string {
  return values.map((v) => `\`${String(v)}\``).join("|");
}

/** Compact JSON for a constraint written into a description. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value);
}

/** The node without one keyword (shallow). */
export function without(node: Schema, key: string): Schema {
  const { [key]: _dropped, ...rest } = node;
  return rest;
}

/**
 * `allOf` of plain object schemas -> one object. Bails when two parts
 * declare the same property differently (the intersection is not
 * expressible as one property schema) or the node already has properties.
 * Parts' `additionalProperties` are dropped: that only widens.
 */
export function mergeAllOf(node: Schema): Schema | null {
  const parts = node.allOf as unknown[];
  if (!parts.every((p) => isSchema(p) && p.type === "object")) return null;
  if ("properties" in node || "required" in node) return null;
  const out = without(node, "allOf");
  const properties: Schema = {};
  const required: string[] = [];
  for (const part of parts as Schema[]) {
    for (const [name, prop] of Object.entries(isSchema(part.properties) ? part.properties : {})) {
      if (name in properties && canonical(properties[name]) !== canonical(prop)) return null;
      properties[name] = prop;
    }
    for (const r of Array.isArray(part.required) ? (part.required as string[]) : []) {
      if (!required.includes(r)) required.push(r);
    }
    if (typeof part.description === "string") addDescription(out, part.description);
  }
  out.type = "object";
  out.properties = properties;
  if (required.length > 0) out.required = required;
  return out;
}

/** Escape a literal for a JS `u`-flag regex (what ajv and most providers use). */
function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * The body of an anchored pattern (`^body$`), or null when the pattern is
 * not anchored at both ends or alternates at its top level (`^a|b$` means
 * `(^a)|(b$)`, which re-anchoring would narrow).
 */
function anchoredBody(pattern: string): string | null {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return null;
  const body = pattern.slice(1, -1);
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      // An escaped final `$` (`^a\$`) is a literal, so the pattern is unanchored.
      if (i === body.length - 1) return null;
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) return null;
  }
  return body;
}

/**
 * `anyOf`/`oneOf` of plain strings (each an enum, const or anchored pattern)
 * -> one string with one combined anchored pattern: the same language,
 * one branch instead of several.
 */
export function mergeStringUnion(node: Schema, key: "oneOf" | "anyOf"): Schema | null {
  const branches = node[key] as unknown[];
  const allowed = new Set(["type", "enum", "const", "pattern", "description"]);
  if (branches.length < 2) return null;
  if ("pattern" in node || "enum" in node || "const" in node || "type" in node) return null;
  const alternatives: string[] = [];
  const descriptions: string[] = [];
  for (const branch of branches) {
    if (!isSchema(branch) || branch.type !== "string") return null;
    if (!Object.keys(branch).every((k) => allowed.has(k))) return null;
    if ("const" in branch) alternatives.push(escapeRegex(String(branch.const)));
    else if (Array.isArray(branch.enum))
      alternatives.push(...branch.enum.map((v) => escapeRegex(String(v))));
    else if (typeof branch.pattern === "string") {
      const body = anchoredBody(branch.pattern);
      if (body === null) return null;
      alternatives.push(body);
    } else return null; // an unconstrained branch: the union is just "string"
    if (typeof branch.description === "string") descriptions.push(branch.description);
  }
  const out = without(node, key);
  out.type = "string";
  out.pattern = `^(?:${alternatives.join("|")})$`;
  for (const d of descriptions) addDescription(out, d);
  return out;
}

/**
 * `anyOf [X, {type: "null"}]` with a simply typed X -> X with
 * `type: [t, "null"]`. An enum/const on X gains `null`, so the merged
 * schema still accepts the null the union accepted.
 */
export function mergeNullable(node: Schema, key: "oneOf" | "anyOf"): Schema | null {
  const branches = node[key] as unknown[];
  if (branches.length !== 2) return null;
  const isNull = (b: unknown) => canonical(b) === canonical({ type: "null" });
  const nullIndex = branches.findIndex(isNull);
  if (nullIndex === -1) return null;
  const other = branches[1 - nullIndex];
  if (!isSchema(other) || typeof other.type !== "string" || other.type === "null") return null;
  if ("anyOf" in other || "oneOf" in other || "allOf" in other) return null;
  const out = without(node, key);
  for (const [k, v] of Object.entries(other)) {
    if (k === "description") addDescription(out, v as string);
    else if (k in out && canonical(out[k]) !== canonical(v)) return null;
    else out[k] = v;
  }
  out.type = [other.type, "null"];
  if ("const" in out) {
    out.enum = [out.const];
    delete out.const;
  }
  if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
}
