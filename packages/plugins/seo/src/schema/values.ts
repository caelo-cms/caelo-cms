// SPDX-License-Identifier: MPL-2.0

/**
 * Reading a page's values for the structured-data answer (#1756, #1761):
 * each role's sources (a page property or a core field of the page) as
 * scalars of the core vocabulary. Values only come from the page's own
 * fields, which the page shows.
 */

import type {
  StructuredDataArgs,
  StructuredDataPage,
  StructuredDataScalar,
  StructuredDataValue,
} from "@caelo-cms/plugin-sdk";
import { type SchemaMapping, sourcesOf } from "./mapping.js";
import { SCHEMA_TYPES } from "./types.js";

/** What one answer reads besides the call's arguments. */
export interface NodeContext {
  readonly args: StructuredDataArgs;
  /** The stored mappings by page type slug. */
  readonly mappings: ReadonlyMap<string, SchemaMapping>;
}

const PAGE_REF_RE = /^caelo:page\/([0-9a-f-]{36})$/i;
const MEDIA_REF_RE = /^caelo:media\/([0-9a-f-]{36})$/i;
const TERM_REF_RE = /^caelo:term\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/** The text of a richtext value: tags dropped, the common entities read, whitespace collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, e: string) => ENTITIES[e] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The field type of a page's property, from its page type. */
export function propertyType(
  ctx: NodeContext,
  page: StructuredDataPage,
  name: string,
): string | null {
  const def = ctx.args.pageTypes[page.pageType]?.properties.find((p) => p.name === name);
  return def ? def.type : null;
}

/** The pages a `page` property names, in order. */
export function pageIdsOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: string[] = [];
  for (const v of list) {
    const m = typeof v === "string" ? PAGE_REF_RE.exec(v) : null;
    if (m && !out.includes((m[1] as string).toLowerCase()))
      out.push((m[1] as string).toLowerCase());
  }
  return out;
}

/**
 * The values one source gives on a page, as scalars of the vocabulary
 * (empty when the page has none). A `page` source gives page ids as
 * `{page}` values; the builders turn authors into Person references.
 */
export function valuesOf(
  ctx: NodeContext,
  page: StructuredDataPage,
  source: string,
): StructuredDataScalar[] {
  switch (source) {
    case "title":
      return page.title ? [page.title] : [];
    case "short_title":
      return page.shortTitle ? [page.shortTitle] : [];
    case "description":
      return page.description ? [page.description] : [];
    case "share_image":
      return page.shareImage ? [{ media: page.shareImage }] : [];
    case "organization":
      return ctx.args.site.organization ? [{ ref: "organization" }] : [];
  }
  const name = source.slice("prop:".length);
  const raw = page.properties[name];
  if (raw === undefined || raw === null || raw === "") return [];
  switch (propertyType(ctx, page, name)) {
    case "text":
    case "select":
      return typeof raw === "string" ? [raw] : [];
    case "richtext": {
      const text = typeof raw === "string" ? plainText(raw) : "";
      return text ? [text] : [];
    }
    case "number":
      return typeof raw === "number" ? [raw] : [];
    case "boolean":
      return typeof raw === "boolean" ? [raw] : [];
    case "date":
      return typeof raw === "string" && DATE_RE.test(raw) ? [{ date: raw }] : [];
    case "media": {
      const m = typeof raw === "string" ? MEDIA_REF_RE.exec(raw) : null;
      return m ? [{ media: (m[1] as string).toLowerCase() }] : [];
    }
    case "page":
      return pageIdsOf(raw).map((id) => ({ page: id }));
    case "link": {
      // `raw` is not null here (checked above).
      const href = typeof raw === "object" ? (raw as { href?: unknown }).href : raw;
      if (typeof href !== "string") return [];
      const internal = PAGE_REF_RE.exec(href);
      if (internal) return [{ page: (internal[1] as string).toLowerCase() }];
      return /^https?:\/\//i.test(href) ? [{ url: href }] : [];
    }
    case "term": {
      const refs = Array.isArray(raw) ? raw : [raw];
      const names: string[] = [];
      for (const ref of refs) {
        const m = typeof ref === "string" ? TERM_REF_RE.exec(ref) : null;
        const term = m
          ? page.terms.find(
              (t) =>
                t.listId.toLowerCase() === (m[1] as string).toLowerCase() &&
                t.itemId.toLowerCase() === (m[2] as string).toLowerCase(),
            )
          : undefined;
        if (term && !names.includes(term.name)) names.push(term.name);
      }
      return names;
    }
    default:
      return [];
  }
}

/** The values of one role on a page: its mapped sources, else its default. */
export function roleValues(
  ctx: NodeContext,
  page: StructuredDataPage,
  mapping: SchemaMapping,
  role: string,
): StructuredDataScalar[] {
  const spec = SCHEMA_TYPES[mapping.schemaType]?.roles[role];
  const mapped = sourcesOf(mapping.roles[role]);
  const sources = mapped.length > 0 ? mapped : spec?.default ? [spec.default] : [];
  return sources.flatMap((s) => valuesOf(ctx, page, s));
}

/** One value or the list of them; undefined when there is none. */
export function oneOrMany(
  values: readonly StructuredDataScalar[],
): StructuredDataValue | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

/** Set `name` on `props` when there is a value. */
export function put(
  props: Record<string, StructuredDataValue>,
  name: string,
  value: StructuredDataValue | undefined,
) {
  if (value !== undefined) props[name] = value;
}
