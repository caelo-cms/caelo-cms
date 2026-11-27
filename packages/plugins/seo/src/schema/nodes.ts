// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's answer at the structured-data point (#1756): each page
 * of a mapped page type as typed nodes. Pure: the operation reads the
 * mappings and hands them in.
 *
 * - An article (Article, BlogPosting, NewsArticle) is one node
 *   `<page URL>#article`: headline, description, image, the live dates,
 *   `author` as references to each author's Person `<author page URL>#person`
 *   in the order the page names them, the site's Organization as publisher.
 *   Each author's Person is in the graph too (name, url, and what the
 *   author's own mapping adds), so every reference resolves on the page.
 * - A profile page (ProfilePage) is core's WebPage as `ProfilePage` with
 *   `mainEntity` → its Person `<page URL>#person`, the full Person: name,
 *   jobTitle, image, description, sameAs from the profile links, worksFor,
 *   knowsAbout.
 * - An overview (CollectionPage) is core's WebPage as `CollectionPage` with
 *   `mainEntity` → an ItemList `<page URL>#items` of the pages the page's
 *   lists show, in their order.
 * - `reviewer` / `reviewed_on` add `reviewedBy` (a Person) and
 *   `lastReviewed` to core's WebPage.
 *
 * Values only come from the page's own fields, which the page shows.
 */

import type {
  StructuredDataAnswer,
  StructuredDataArgs,
  StructuredDataNode,
  StructuredDataPage,
  StructuredDataPageAnswer,
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
function propertyType(ctx: NodeContext, page: StructuredDataPage, name: string): string | null {
  const def = ctx.args.pageTypes[page.pageType]?.properties.find((p) => p.name === name);
  return def ? def.type : null;
}

/** The pages a `page` property names, in order. */
function pageIdsOf(raw: unknown): string[] {
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
      const href = typeof raw === "object" && raw !== null ? (raw as { href?: unknown }).href : raw;
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
function roleValues(
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
function oneOrMany(values: readonly StructuredDataScalar[]): StructuredDataValue | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

/** Set `name` on `props` when there is a value. */
function put(
  props: Record<string, StructuredDataValue>,
  name: string,
  value: StructuredDataValue | undefined,
) {
  if (value !== undefined) props[name] = value;
}

/** The page record of a related page (an author), when the render has it. */
function relatedPage(ctx: NodeContext, pageId: string): StructuredDataPage | undefined {
  return (
    ctx.args.related.find((p) => p.pageId.toLowerCase() === pageId) ??
    ctx.args.pages.find((p) => p.pageId.toLowerCase() === pageId)
  );
}

/**
 * The Person of a person's own page (`<page URL>#person`): everything its
 * profile mapping maps, or, for a page whose type is not a profile, its
 * name (short title) and URL.
 */
function personNode(
  ctx: NodeContext,
  person: StructuredDataPage,
  full: boolean,
): StructuredDataNode {
  const id = person.pageId.toLowerCase();
  const props: Record<string, StructuredDataValue> = {};
  const mapping = ctx.mappings.get(person.pageType);
  if (mapping?.schemaType === "ProfilePage") {
    put(props, "name", oneOrMany(roleValues(ctx, person, mapping, "name").slice(0, 1)));
    put(props, "url", { page: id });
    put(props, "jobTitle", oneOrMany(roleValues(ctx, person, mapping, "job_title").slice(0, 1)));
    put(props, "image", oneOrMany(roleValues(ctx, person, mapping, "image").slice(0, 1)));
    if (full) {
      put(props, "description", oneOrMany(roleValues(ctx, person, mapping, "bio").slice(0, 1)));
      put(
        props,
        "sameAs",
        oneOrMany(
          roleValues(ctx, person, mapping, "same_as").filter(
            (v) => typeof v === "object" && "url" in v,
          ),
        ),
      );
      const worksFor = roleValues(ctx, person, mapping, "works_for")[0];
      put(
        props,
        "worksFor",
        typeof worksFor === "string"
          ? { node: { type: "Organization", properties: { name: worksFor } } }
          : worksFor,
      );
      put(props, "knowsAbout", oneOrMany(roleValues(ctx, person, mapping, "knows_about")));
    }
  } else {
    put(props, "name", person.shortTitle || person.title);
    put(props, "url", { page: id });
  }
  return {
    type: "Person",
    id: full ? { fragment: "person" } : { page: id, fragment: "person" },
    properties: props,
  };
}

/** References to the Persons of the pages a role names, adding their nodes. */
function personRefs(
  ctx: NodeContext,
  page: StructuredDataPage,
  mapping: SchemaMapping,
  role: string,
  nodes: StructuredDataNode[],
): StructuredDataScalar[] {
  const refs: StructuredDataScalar[] = [];
  for (const v of roleValues(ctx, page, mapping, role)) {
    if (typeof v !== "object" || !("page" in v)) continue;
    const person = relatedPage(ctx, v.page);
    // A page the build does not ship (a draft author) is left out, as on the page.
    if (!person) continue;
    refs.push({ ref: { page: person.pageId.toLowerCase(), fragment: "person" } });
    // One node per id: the page's own Person (a profile page reviewed by
    // its own person) or an author named twice is written once.
    const id = `${person.pageId.toLowerCase()}#person`;
    const ownId = page.pageId.toLowerCase();
    if (!nodes.some((n) => `${(n.id.page ?? ownId).toLowerCase()}#${n.id.fragment}` === id)) {
      nodes.push(personNode(ctx, person, false));
    }
  }
  return refs;
}

/** `reviewedBy` and `lastReviewed` of core's WebPage. */
function reviewProperties(
  ctx: NodeContext,
  page: StructuredDataPage,
  mapping: SchemaMapping,
  nodes: StructuredDataNode[],
): Record<string, StructuredDataValue> {
  const props: Record<string, StructuredDataValue> = {};
  put(props, "reviewedBy", oneOrMany(personRefs(ctx, page, mapping, "reviewer", nodes)));
  put(props, "lastReviewed", oneOrMany(roleValues(ctx, page, mapping, "reviewed_on").slice(0, 1)));
  return props;
}

/** The answer for one page of a mapped type. */
export function pageAnswer(
  ctx: NodeContext,
  page: StructuredDataPage,
  mapping: SchemaMapping,
): StructuredDataPageAnswer | null {
  const spec = SCHEMA_TYPES[mapping.schemaType];
  if (!spec) return null;
  const nodes: StructuredDataNode[] = [];
  switch (spec.builder) {
    case "article": {
      const props: Record<string, StructuredDataValue> = {};
      put(props, "headline", page.title);
      put(props, "description", page.description || undefined);
      put(props, "image", oneOrMany(roleValues(ctx, page, mapping, "image").slice(0, 1)));
      props.datePublished = { live: "published" };
      props.dateModified = { live: "modified" };
      put(props, "author", oneOrMany(personRefs(ctx, page, mapping, "authors", nodes)));
      if (ctx.args.site.organization) props.publisher = { ref: "organization" };
      props.mainEntityOfPage = { ref: "webpage" };
      props.inLanguage = page.lang;
      nodes.unshift({ type: spec.schemaType, id: { fragment: "article" }, properties: props });
      const review = reviewProperties(ctx, page, mapping, nodes);
      return Object.keys(review).length > 0
        ? { webPage: { properties: review }, nodes }
        : { nodes };
    }
    case "profile": {
      nodes.push(personNode(ctx, page, true));
      return {
        webPage: {
          type: "ProfilePage",
          properties: { mainEntity: { ref: { fragment: "person" } } },
        },
        nodes,
      };
    }
    case "collection": {
      if (page.listed.length === 0) return { webPage: { type: "CollectionPage" } };
      nodes.push({
        type: "ItemList",
        id: { fragment: "items" },
        properties: {
          itemListElement: page.listed.map((id, i) => ({
            node: { type: "ListItem", properties: { position: i + 1, url: { page: id } } },
          })),
          numberOfItems: page.listed.length,
        },
      });
      return {
        webPage: {
          type: "CollectionPage",
          properties: { mainEntity: { ref: { fragment: "items" } } },
        },
        nodes,
      };
    }
    case "webpage": {
      const review = reviewProperties(ctx, page, mapping, nodes);
      return Object.keys(review).length > 0 ? { webPage: { properties: review }, nodes } : null;
    }
    case "entity":
      return null;
  }
}

/** The answer for every asked page of a mapped type. */
export function structuredDataAnswer(ctx: NodeContext): StructuredDataAnswer {
  const pages: Record<string, StructuredDataPageAnswer> = {};
  for (const page of ctx.args.pages) {
    const mapping = ctx.mappings.get(page.pageType);
    if (!mapping) continue;
    const answer = pageAnswer(ctx, page, mapping);
    if (answer) pages[page.pageId] = answer;
  }
  return { pages };
}
