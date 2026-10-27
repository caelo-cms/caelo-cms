// SPDX-License-Identifier: MPL-2.0

/**
 * Discriminated-union flattening for the model-facing schema compaction
 * (`compact-input-schema.ts`).
 *
 * `z.discriminatedUnion` exports as a `oneOf` whose every branch repeats the
 * shared fields (5 base fields x 11 field types in `upsert_list_types_many`).
 * This turns it into ONE object: the discriminator becomes an `enum`, every
 * property appears once, and whatever was variant-specific — which variants
 * a property belongs to, where it is required, per-variant enums, patterns
 * and bounds — moves into that property's description. The flat object
 * accepts every branch's instances (a superset); the Zod parse at dispatch
 * still enforces the exact variant rules.
 */

import {
  addDescription,
  canonical,
  clone,
  formatValues,
  inlineJson,
  isSchema,
  type Schema,
  without,
} from "./_compact-schema-merge.js";

/** One union branch's view of a property: (discriminator value, schema). */
type Variant = readonly [discValue: unknown, schema: Schema];

/** Paired bounds: the merged schema takes the widest of each. */
const BOUNDS = [
  ["minimum", "maximum"],
  ["minLength", "maxLength"],
  ["minItems", "maxItems"],
] as const;
const BOUND_KEYS = new Set<string>(BOUNDS.flat());

/** Constraints whose per-variant difference is written into the description. */
const NOTED_KEYS = new Set([
  "enum",
  "const",
  "pattern",
  "format",
  "items",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
]);

function isDiscriminatorValue(prop: unknown): boolean {
  return (
    isSchema(prop) && ("const" in prop || (Array.isArray(prop.enum) && prop.enum.length === 1))
  );
}

function discriminatorValue(prop: Schema): unknown {
  return "const" in prop ? prop.const : (prop.enum as unknown[])[0];
}

function jsonType(value: unknown): string | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}

function noteFor(key: string, disc: unknown, value: unknown): string {
  const d = `\`${String(disc)}\``;
  if (key === "enum") return `${d}: ${formatValues(value as unknown[])}`;
  if (key === "const") return `${d}: ${formatValues([value])}`;
  if (key === "pattern" || key === "format") return `${d}: ${key} \`${String(value)}\``;
  return `${d}: ${key} \`${inlineJson(value)}\``;
}

/**
 * A dropped keyword can make a kept sibling stricter: `additionalProperties`
 * without the `properties` it complemented rejects every key, and `items`
 * without its `prefixItems` applies to the whole array. Drop the sibling too.
 */
function dropOrphanedSiblings(out: Schema, plain: readonly Schema[]): void {
  const lost = (k: string) => !(k in out) && plain.some((p) => k in p);
  if (lost("properties") || lost("patternProperties")) {
    delete out.additionalProperties;
    delete out.unevaluatedProperties;
  }
  if (lost("prefixItems")) delete out.items;
  if (lost("items")) delete out.additionalItems;
}

/** One property schema that accepts what each variant's schema accepted. */
export function mergeVariantSchemas(variants: readonly Variant[]): Schema {
  const plain = variants.map(([, s]) => without(s, "description"));
  const first = plain[0] as Schema;
  let out: Schema;
  if (plain.every((p) => canonical(p) === canonical(first))) {
    out = clone(first);
  } else if (
    first.type !== undefined &&
    plain.every((p) => canonical(p.type) === canonical(first.type))
  ) {
    out = mergeSameType(variants, plain);
  } else {
    const unique = new Map(plain.map((p) => [canonical(p), clone(p)]));
    out = { anyOf: [...unique.values()] };
  }
  const described = variants.filter(([, s]) => typeof s.description === "string");
  const texts = new Set(described.map(([, s]) => s.description as string));
  if (texts.size === 1) addDescription(out, [...texts][0], true);
  else if (texts.size > 1)
    addDescription(
      out,
      described.map(([d, s]) => `\`${String(d)}\`: ${s.description as string}`).join(" "),
      true,
    );
  return out;
}

/**
 * Variants of one type that differ in their constraints: bounds widen,
 * constraints shared by all variants stay, and per-variant ones move into
 * the description.
 */
function mergeSameType(variants: readonly Variant[], plain: readonly Schema[]): Schema {
  const out: Schema = { type: clone(plain[0]?.type) };
  const notes: string[] = [];
  for (const [lo, hi] of BOUNDS) {
    for (const [key, pickWidest, op] of [
      [lo, Math.min, ">="],
      [hi, Math.max, "<="],
    ] as const) {
      const values = plain.map((p) => p[key]);
      const defined = values.filter((v): v is number => typeof v === "number");
      if (defined.length === values.length) out[key] = pickWidest(...defined);
      if (defined.length > 0 && new Set(values).size > 1) {
        notes.push(
          variants
            .flatMap(([d], i) =>
              typeof values[i] === "number" ? [`\`${String(d)}\` ${op} ${values[i]}`] : [],
            )
            .join(", "),
        );
      }
    }
  }
  for (const key of new Set(plain.flatMap((p) => Object.keys(p)))) {
    if (key === "type" || BOUND_KEYS.has(key)) continue;
    const values = plain.map((p) => canonical(p[key]));
    if (values.every((v) => v === values[0]) && plain[0]?.[key] !== undefined) {
      out[key] = clone(plain[0][key]);
    } else if (NOTED_KEYS.has(key)) {
      const per = variants.flatMap(([d], i) =>
        plain[i]?.[key] !== undefined ? [noteFor(key, d, plain[i]?.[key])] : [],
      );
      if (per.length > 0) notes.push(per.join("; "));
    }
  }
  dropOrphanedSiblings(out, plain);
  if (notes.length > 0) addDescription(out, `${notes.join("; ")}.`);
  return out;
}

/**
 * `oneOf`/`anyOf` of object branches that share a const (or single-value
 * enum) discriminator -> one object. Returns null when the node is not
 * such a union, or already carries its own properties beside it.
 */
export function flattenDiscriminatedUnion(node: Schema, key: "oneOf" | "anyOf"): Schema | null {
  const branches = node[key] as unknown[];
  if (branches.length < 2) return null;
  if (!branches.every((b) => isSchema(b) && b.type === "object" && isSchema(b.properties)))
    return null;
  if ("properties" in node || "required" in node) return null;
  const objects = branches as (Schema & { properties: Schema })[];
  const required = (b: Schema) => (Array.isArray(b.required) ? (b.required as string[]) : []);

  const common = Object.keys(objects[0]?.properties ?? {}).filter((p) =>
    objects.every((b) => p in b.properties),
  );
  const disc = common
    .sort()
    .find((p) => objects.every((b) => isDiscriminatorValue(b.properties[p])));
  if (disc === undefined) return null;
  const values = objects.map((b) => discriminatorValue(b.properties[disc] as Schema));
  if (new Set(values.map(String)).size !== values.length) return null;

  const order: string[] = [];
  for (const b of objects)
    for (const p of Object.keys(b.properties)) if (!order.includes(p)) order.push(p);

  const properties: Schema = {};
  const alwaysRequired: string[] = [];
  for (const prop of order) {
    if (prop === disc) {
      properties[prop] = discriminatorSchema(objects, disc, values);
      continue;
    }
    const having = objects.flatMap((b, i) =>
      prop in b.properties ? [[values[i], b] as const] : [],
    );
    const merged = mergeVariantSchemas(having.map(([v, b]) => [v, b.properties[prop] as Schema]));
    const requiredIn = having.filter(([, b]) => required(b).includes(prop)).map(([v]) => v);
    if (requiredIn.length === objects.length) alwaysRequired.push(prop);
    else if (requiredIn.length > 0)
      addDescription(merged, `Required when \`${disc}\`: ${formatValues(requiredIn)}.`);
    else if (having.length < objects.length)
      addDescription(merged, `For \`${disc}\`: ${formatValues(having.map(([v]) => v))}.`);
    properties[prop] = merged;
  }

  const out = without(node, key);
  out.type = "object";
  out.properties = properties;
  const req = objects.every((b) => required(b).includes(disc))
    ? [disc, ...alwaysRequired]
    : alwaysRequired;
  if (req.length > 0) out.required = req;
  if (objects.every((b) => b.additionalProperties === false)) out.additionalProperties = false;
  return out;
}

/** The discriminator as one enum, carrying each branch's own description. */
function discriminatorSchema(
  objects: readonly (Schema & { properties: Schema })[],
  disc: string,
  values: readonly unknown[],
): Schema {
  const types = new Set(values.map(jsonType));
  const out: Schema = types.size === 1 && !types.has(undefined) ? { type: [...types][0] } : {};
  out.enum = [...values];
  const own = new Set(
    objects.flatMap((b) => {
      const d = (b.properties[disc] as Schema).description;
      return typeof d === "string" ? [d] : [];
    }),
  );
  for (const d of own) addDescription(out, d);
  const branchDescriptions = objects.flatMap((b, i) =>
    typeof b.description === "string" ? [`\`${String(values[i])}\`: ${b.description}`] : [],
  );
  if (branchDescriptions.length > 0) addDescription(out, branchDescriptions.join(" | "));
  return out;
}
