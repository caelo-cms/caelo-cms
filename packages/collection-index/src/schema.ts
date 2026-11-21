// SPDX-License-Identifier: MPL-2.0

/**
 * The schema of a plugin collection (epic #1644, R2).
 *
 * A collection is a set of documents with an id, a language and declared
 * fields. The engine knows five field kinds:
 *
 * - `text`: one string, searched with BM25F.
 * - `passages`: a list of `{ anchor, heading, text }` sections. Headings
 *   and texts are searched as two slots; the passage is what a snippet, a
 *   `read` and a vector point at.
 * - `keyword`: exact values (one or many) for filters, facets and lookups
 *   (`url`, `page_type`).
 * - `number` and `date`: one value for range filters and sorting.
 *
 * Every field is stored, so the store files are both what a hit returns
 * and the source a segment is rebuilt from (CLAUDE.md §2, maintained ==
 * rebuilt).
 */

/** One section of a `passages` field. */
export interface Passage {
  readonly anchor: string;
  readonly heading: string;
  readonly text: string;
}

/** Declaration of one field. */
export type FieldSpec =
  | { readonly kind: "text"; readonly prefix?: boolean }
  | { readonly kind: "passages"; readonly prefix?: boolean; readonly vector?: boolean }
  | { readonly kind: "keyword"; readonly facet?: boolean }
  | { readonly kind: "number" }
  | { readonly kind: "date" };

/** A collection's fields, in declaration order. */
export interface CollectionSchema {
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

/** A field value as a document carries it. */
export type FieldValue = string | readonly string[] | number | readonly Passage[] | null;

/** One document. `id` is the plugin's own identifier, unique in the collection. */
export interface CollectionDoc {
  readonly id: string;
  readonly lang: string;
  readonly values: Readonly<Record<string, FieldValue>>;
}

/** A document with the engine's numeric key, stable across releases. */
export interface KeyedDoc extends CollectionDoc {
  readonly key: number;
}

/** A searchable slot: a text field, or the heading or text half of a passages field. */
export interface Slot {
  readonly name: string;
  readonly field: string;
  readonly part: "text" | "heading" | "body";
  readonly prefix: boolean;
}

/** Field names that collide with the engine's own document attributes. */
const RESERVED = new Set(["id", "lang", "key"]);

/** The most searchable slots one collection may have; the field mask of a posting fits in one varint byte pair. */
export const MAX_SLOTS = 14;

/** Derived layout of a schema, computed once per segment. */
export interface SchemaLayout {
  readonly slots: readonly Slot[];
  readonly keywords: readonly string[];
  readonly facets: readonly string[];
  readonly numbers: readonly string[];
  readonly passages: readonly string[];
  readonly vectorFields: readonly string[];
}

/** Validates a schema and derives its slot layout. Throws on a schema no segment can hold. */
export function layoutOf(schema: CollectionSchema): SchemaLayout {
  const slots: Slot[] = [];
  const keywords: string[] = [];
  const facets: string[] = [];
  const numbers: string[] = [];
  const passages: string[] = [];
  const vectorFields: string[] = [];
  for (const [name, spec] of Object.entries(schema.fields)) {
    if (RESERVED.has(name))
      throw new RangeError(
        `collection schema: "${name}" is reserved for the document's own ${name}`,
      );
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name))
      throw new RangeError(`collection schema: field name "${name}" must be snake_case`);
    switch (spec.kind) {
      case "text":
        slots.push({ name, field: name, part: "text", prefix: spec.prefix ?? false });
        break;
      case "passages":
        slots.push({
          name: `${name}.heading`,
          field: name,
          part: "heading",
          prefix: spec.prefix ?? false,
        });
        slots.push({
          name: `${name}.text`,
          field: name,
          part: "body",
          prefix: spec.prefix ?? false,
        });
        passages.push(name);
        if (spec.vector) vectorFields.push(name);
        break;
      case "keyword":
        keywords.push(name);
        if (spec.facet) facets.push(name);
        break;
      case "number":
      case "date":
        numbers.push(name);
        break;
    }
  }
  if (slots.length === 0)
    throw new RangeError("collection schema: at least one text or passages field");
  if (slots.length > MAX_SLOTS)
    throw new RangeError(
      `collection schema: at most ${MAX_SLOTS} searchable slots, got ${slots.length}`,
    );
  if (vectorFields.length > 1)
    throw new RangeError("collection schema: at most one passages field carries vectors");
  return { slots, keywords, facets, numbers, passages, vectorFields };
}

/** The text of one slot of a document. */
export function slotText(doc: CollectionDoc, slot: Slot): string {
  const value = doc.values[slot.field];
  if (value === null || value === undefined) return "";
  if (slot.part === "text") return typeof value === "string" ? value : "";
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const p of value as readonly Passage[])
    parts.push(slot.part === "heading" ? p.heading : p.text);
  return parts.join("\n");
}

/** The keyword values of a field, deduplicated, empty strings dropped. */
export function keywordValues(doc: CollectionDoc, field: string): string[] {
  const value = doc.values[field];
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value))
    return [
      ...new Set(
        (value as readonly unknown[]).filter((v): v is string => typeof v === "string" && v !== ""),
      ),
    ];
  return [];
}

/** A number or date field as a number (dates as epoch milliseconds), NaN when missing. */
export function numberValue(doc: CollectionDoc, field: string): number {
  const value = doc.values[field];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? Number.NaN : t;
  }
  return Number.NaN;
}

/** Dictionary prefix of keyword terms: sorts before every analysed word. */
export const KEYWORD_PREFIX = "\u0001";

/** The dictionary term of a keyword value. */
export function keywordTerm(field: string, value: string): string {
  return `${KEYWORD_PREFIX}${field}\u0000${value}`;
}

/** The keyword term of a document id, so `read` finds a document without a key map. */
export function idTerm(id: string): string {
  return `${KEYWORD_PREFIX}\u0000id\u0000${id}`;
}

/** The keyword term of a document language. */
export function langTerm(lang: string): string {
  return `${KEYWORD_PREFIX}\u0000lang\u0000${lang.toLowerCase()}`;
}
