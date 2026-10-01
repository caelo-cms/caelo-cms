// SPDX-License-Identifier: MPL-2.0

/** Google's GenerateContent Schema.enum accepts strings only. Keep numeric and
 * boolean argument types, expressing their choices in the description on the
 * wire. The original SDK tool schema and dispatch validator remain authoritative.
 * Walk schema positions only: property names such as "enum" are ordinary names.
 */
export function googleToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const result = { ...schema } as Record<string, unknown>;
  // The SDK otherwise puts properties beside anyOf instead of inside its
  // object branch, which Google's OpenAPI Schema rejects.
  if (Array.isArray(result.type)) {
    return {
      anyOf: result.type.map((type) => {
        const branch: Record<string, unknown> = { ...result, type };
        if (type !== "object")
          for (const key of ["properties", "required", "additionalProperties", "patternProperties"])
            delete branch[key];
        if (type !== "array")
          for (const key of ["items", "minItems", "maxItems", "prefixItems"]) delete branch[key];
        return googleToolSchema(branch);
      }),
    };
  }
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
