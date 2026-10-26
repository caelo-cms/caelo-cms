// SPDX-License-Identifier: MPL-2.0

/** Google's GenerateContent Schema.enum accepts strings only. Keep numeric and
 * boolean argument types, expressing their choices in the description on the
 * wire. The original SDK tool schema and dispatch validator remain authoritative.
 * Walk schema positions only: property names such as "enum" are ordinary names.
 */
export function googleToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const result = { ...schema } as Record<string, unknown>;
  // A type list (`["object", "null"]`, which the model-facing compaction
  // writes for every nullable field) goes to Google as an anyOf of one
  // branch per type: the SDK otherwise puts properties beside anyOf instead
  // of inside its object branch, which Google's OpenAPI Schema rejects.
  if (Array.isArray(result.type)) return splitTypeList(result, result.type as unknown[]);
  const choices =
    Array.isArray(result.enum) && result.enum.some((value) => typeof value !== "string")
      ? result.enum
      : Object.hasOwn(result, "const") && typeof result.const !== "string"
        ? [result.const]
        : null;
  if (choices) {
    delete result.enum;
    delete result.const;
    result.description = [
      result.description,
      `Allowed values: ${choices.map((value) => JSON.stringify(value)).join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
    const children = result[key];
    if (children && typeof children === "object" && !Array.isArray(children))
      result[key] = Object.fromEntries(
        Object.entries(children).map(([name, child]) => [name, googleToolSchema(child)]),
      );
  }
  for (const key of ["items", "additionalProperties", "not", "if", "then", "else", "contains"])
    if (result[key] !== undefined)
      result[key] = Array.isArray(result[key])
        ? result[key].map(googleToolSchema)
        : googleToolSchema(result[key]);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    if (Array.isArray(result[key])) result[key] = result[key].map(googleToolSchema);
  return result;
}

/** Keywords that describe the whole value, not one type's branch. */
const ANNOTATIONS = ["description", "title", "default", "examples"];

/** Keywords that only constrain a value of the given JSON type. */
const TYPE_KEYWORDS: Record<string, readonly string[]> = {
  object: ["properties", "required", "additionalProperties", "patternProperties", "propertyNames"],
  array: ["items", "minItems", "maxItems", "prefixItems", "uniqueItems"],
  string: ["minLength", "maxLength", "pattern", "format"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
};

function hasJsonType(value: unknown, type: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  return typeof value === type;
}

/**
 * `{type: [a, b], ...}` -> `{annotations, anyOf: [{type: a, ...}, {type: b, ...}]}`.
 * Each branch keeps only its own type's keywords and enum values; the null
 * branch is bare. Annotations stay on the outer node, once.
 */
function splitTypeList(schema: Record<string, unknown>, types: readonly unknown[]): unknown {
  const outer: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.includes(key)) outer[key] = value;
    else if (key !== "type") rest[key] = value;
  }
  outer.anyOf = types.map((type) => {
    if (type === "null") return { type: "null" };
    const branch: Record<string, unknown> = { ...rest, type };
    const own = type === "integer" ? "number" : String(type);
    for (const [kind, keys] of Object.entries(TYPE_KEYWORDS))
      if (kind !== own) for (const key of keys) delete branch[key];
    if (Array.isArray(branch.enum)) {
      branch.enum = branch.enum.filter((value) => hasJsonType(value, type));
      if ((branch.enum as unknown[]).length === 0) delete branch.enum;
    }
    if (Object.hasOwn(branch, "const") && !hasJsonType(branch.const, type)) delete branch.const;
    return googleToolSchema(branch);
  });
  return outer;
}
