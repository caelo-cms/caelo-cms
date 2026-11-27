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
  StructuredDataNode,
  StructuredDataPage,
  StructuredDataPageAnswer,
  StructuredDataScalar,
  StructuredDataValue,
} from "@caelo-cms/plugin-sdk";
import { entityAnswer } from "./entities.js";
import type { SchemaMapping } from "./mapping.js";
import { SCHEMA_TYPES } from "./types.js";
import { type NodeContext, oneOrMany, put, roleValues } from "./values.js";

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
      return entityAnswer(ctx, page, mapping, spec);
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
