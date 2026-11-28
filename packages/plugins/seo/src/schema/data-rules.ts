// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — the structured data rules of the Stage audit: what the staged
 * page's JSON-LD graph says, read from the build (`facts.jsonLd`), against
 * the page type's schema mapping (#1756) and the page itself. Objective
 * only (maintainer decision 2026-11-26): what is missing or contradicts
 * the page; recommended properties stay write hints.
 *
 * - `structured-data-required`: the page's main node lacks a property its
 *   rich result requires (the type table's `required`).
 * - `overview-empty`: an overview (CollectionPage) whose lists show no
 *   page: a page of nothing, which search engines treat as a soft 404.
 * - `structured-data-not-visible`: the main node's headline or name is not
 *   on the page (Google: markup must match the visible content).
 * - `article-author-missing`: the page type maps authors and this article
 *   names none.
 * - `author-page-incomplete` (a warning): a person's page without a
 *   biography, portrait or profile link. A warning because a person's page
 *   need not be an author's (a team member, a speaker), which this check
 *   cannot tell from the page alone.
 * - `author-page-noindex`: an article names an author whose page is
 *   noindex, so the author reference leads search engines to a page they
 *   may not show.
 *
 * Only pages search engines take as themselves are judged: indexable (not
 * noindex, which also covers the 404 page) and canonical to themselves,
 * the pages the duplicates check and llms.txt read. A noindex page gets no
 * live dates from core and its rich result is never shown; a page whose
 * canonical names another URL has its nodes under that URL and is not the
 * page search engines index. A broken JSON-LD block is core's finding
 * (`structured-data/invalid-json`), not this check's.
 *
 * Main node: the graph node of the type's main schema type whose `@id`
 * is the page's own URL with a fragment (an article's author Persons have
 * their own pages' URLs). A page whose JSON-LD the facts budget cut
 * (`omitted`, or `jsonLd` in `truncatedFacts`) is not judged: its graph is
 * not all there.
 */

import type {
  PluginAuditFinding,
  PluginAuditPageFacts,
  PluginContextTier1,
} from "@caelo-cms/plugin-sdk";
import { z } from "@caelo-cms/plugin-sdk";
import type { SeoAuditRule } from "../checks/index.js";
import { type SchemaMapping, sourcesOf } from "./mapping.js";
import { readMappings } from "./operations.js";
import { SCHEMA_TYPES, type SchemaTypeSpec } from "./types.js";

type Ctx = PluginContextTier1;
type Node = Record<string, unknown>;

/** Pages one overview / staged-pages call names. */
const IDS_PER_CALL = 1000;

const head = z
  .object({ pageId: z.string(), path: z.string(), pageType: z.string(), noindex: z.boolean() })
  .passthrough();
const overviewAnswer = z
  .object({ pages: z.array(head), nextCursor: z.string().nullable() })
  .strict();
const stagedAnswer = z
  .object({ pages: z.array(z.object({ pageId: z.string(), path: z.string() }).passthrough()) })
  .passthrough();

/**
 * A site path as core's page facts key it (admin-core `pathKey`): decoded,
 * `/index.html` folded, no trailing slash (the root stays `/`). Every side
 * of a comparison goes through it: the facts' paths, a node's `@id`, a
 * staged page's path.
 */
function bare(path: string): string {
  let p: string;
  try {
    p = decodeURIComponent(path);
  } catch {
    p = path;
  }
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "" ? "/" : p;
}

/** The path key of an absolute or root-relative URL, or null. */
function pathOf(url: string): string | null {
  try {
    return bare(new URL(url, "https://site.invalid").pathname);
  } catch {
    return null;
  }
}

/** Every node of the page's parsed JSON-LD blocks (`@graph`, arrays, single objects). */
export function graphNodes(blocks: readonly unknown[]): Node[] {
  const out: Node[] = [];
  const add = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) add(x);
    else if (v !== null && typeof v === "object") {
      const o = v as Node;
      if (Array.isArray(o["@graph"])) add(o["@graph"]);
      else out.push(o);
    }
  };
  for (const b of blocks) add(b);
  return out;
}

function typesOf(node: Node): string[] {
  const t = node["@type"];
  return typeof t === "string"
    ? [t]
    : Array.isArray(t)
      ? t.filter((x) => typeof x === "string")
      : [];
}

/** The page's own node of `type`: its `@id` is the page's URL with a fragment. */
export function mainNode(nodes: readonly Node[], type: string, pagePath: string): Node | null {
  const own = bare(pagePath);
  for (const n of nodes) {
    if (!typesOf(n).includes(type)) continue;
    const id = typeof n["@id"] === "string" ? n["@id"] : null;
    if (id === null || !id.includes("#")) continue;
    // A fragment alone names a node of this document (no base URL yet).
    if (id.startsWith("#") || pathOf(id.split("#")[0] ?? "") === own) return n;
  }
  return null;
}

/** Whether a JSON-LD value says something (not absent, empty or an empty list). */
function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(present);
  return true;
}

/**
 * What stands in for a required property (Google's job posting
 * documentation): a fully remote job has `jobLocationType: "TELECOMMUTE"`
 * and no `jobLocation`, but then names the countries applicants may live in
 * (`applicantLocationRequirements`; schema/entities.ts writes it from the
 * `country` role). A remote job without one has neither.
 */
const REQUIRED_STAND_INS: Readonly<Record<string, (node: Node) => boolean>> = {
  jobLocation: (node) =>
    node.jobLocationType === "TELECOMMUTE" && present(node.applicantLocationRequirements),
};

/** Whether `node` carries `property`, or what stands in for it. */
function hasRequired(node: Node, property: string): boolean {
  return present(node[property]) || (REQUIRED_STAND_INS[property]?.(node) ?? false);
}

/** How a missing required property is named: a remote job lacks the country. */
function missingLabel(node: Node, property: string): string {
  return property === "jobLocation" && node.jobLocationType === "TELECOMMUTE"
    ? "applicantLocationRequirements (a remote job names the country applicants may live in)"
    : property;
}

/**
 * Text as compared with the page: lower case, punctuation and symbols as
 * spaces, one space. Markup splits text into runs at tags and entities
 * (`<strong>Dr.</strong> Anna Berg`, `Anna Berg,&nbsp;PhD`), so a run's
 * punctuation sits where the split put it; compared without it, "Dr. Anna
 * Berg" is the runs "Dr." and "Anna Berg", and a headline "Why we test?"
 * is the h1 "Why we test".
 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters of `text`, never half of one (a surrogate pair). */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** Does the page ask to stay out of search (`<meta name="robots">` noindex or none)? */
function robotsNoindex(f: PluginAuditPageFacts): boolean {
  return (f.robots ?? "")
    .toLowerCase()
    .split(",")
    .some((d) => d.trim() === "noindex" || d.trim() === "none");
}

/**
 * Why the page is not judged, or null when it is: noindex (the facts or the
 * build's record say so), canonical to another URL, or a graph the facts
 * budget cut.
 */
function notJudged(f: PluginAuditPageFacts, info: PageInfo | undefined): string | null {
  if (robotsNoindex(f) || info?.noindex) return "noindex";
  // An external canonical has no site path; a same-site one names a page.
  if (f.canonical !== null && f.canonical.path !== bare(f.path)) return "canonical elsewhere";
  if (f.jsonLd.some((b) => b.kind === "omitted") || f.truncatedFacts.includes("jsonLd")) {
    return "graph cut";
  }
  return null;
}

/** Whether `value` is on the page: in a heading or a visible text run. */
function visible(f: PluginAuditPageFacts, value: string): boolean | null {
  const v = norm(value);
  if (v === "") return true;
  const runs = [...f.headings.map((h) => h.text), ...f.texts.map((t) => t.text)]
    .map(norm)
    .filter((r) => r !== "");
  if (runs.some((r) => r.includes(v))) return true;
  // The whole text across runs (a name split by markup).
  if (runs.join(" ").includes(v)) return true;
  // Cut facts prove nothing about what is missing.
  const cut = f.truncatedFacts.includes("texts") || f.truncatedFacts.includes("headings");
  return cut ? null : false;
}

/** The ids (`<url>#person`) of the Persons the article names as author. */
function authorIds(article: Node): string[] {
  const a = article.author;
  const list = Array.isArray(a) ? a : a === undefined ? [] : [a];
  return list.flatMap((x) =>
    x !== null && typeof x === "object" && typeof (x as Node)["@id"] === "string"
      ? [(x as Node)["@id"] as string]
      : [],
  );
}

interface PageInfo {
  readonly pageType: string;
  readonly noindex: boolean;
  readonly path: string;
}

/** Page type and noindex of `pageIds` as the build renders them. */
async function infoOf(ctx: Ctx, pageIds: readonly string[]): Promise<Map<string, PageInfo>> {
  if (!ctx.cms)
    throw new Error("seo: the cms_admin grant is missing, so page types cannot be read");
  const out = new Map<string, PageInfo>();
  for (let at = 0; at < pageIds.length; at += IDS_PER_CALL) {
    const r = overviewAnswer.parse(
      await ctx.cms.call("pages_seo.overview", {
        pageIds: pageIds.slice(at, at + IDS_PER_CALL),
        withFindings: false,
      }),
    );
    for (const p of r.pages)
      out.set(p.pageId, { pageType: p.pageType, noindex: p.noindex, path: p.path });
  }
  return out;
}

/** The staged pages at `paths`, by path. */
async function pagesAt(
  ctx: Ctx,
  auditRunId: string | undefined,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0 || auditRunId === undefined || !ctx.cms) return out;
  for (let at = 0; at < paths.length; at += IDS_PER_CALL) {
    const r = stagedAnswer.parse(
      await ctx.cms.call("quality_audits.staged_pages", {
        auditRunId,
        paths: paths.slice(at, at + IDS_PER_CALL),
      }),
    );
    for (const p of r.pages) out.set(bare(p.path), p.pageId);
  }
  return out;
}

const MAPPING_FIX = {
  tool: "set_schema_mappings_many",
  hint: "Map the role that feeds it to a property the page shows (get_schema_mapping lists the roles), then fill the property on the page (update_pages_many).",
} as const;

/**
 * The findings of one page from its graph alone, for a page the family
 * judges ({@link notJudged} is null).
 */
export function pageDataFindings(
  f: PluginAuditPageFacts,
  mapping: SchemaMapping,
  spec: SchemaTypeSpec,
): PluginAuditFinding[] {
  const out: PluginAuditFinding[] = [];
  const nodes = graphNodes(f.jsonLd.flatMap((b) => (b.kind === "parsed" ? [b.data] : [])));
  const main = mainNode(nodes, spec.schemaType, f.path);
  if (spec.builder === "collection") {
    if (main === null || !present(main.itemListElement)) {
      out.push({
        rule: "overview-empty",
        severity: "error",
        pageId: f.pageId,
        message: `Empty overview: ${f.path} is an overview (${mapping.pageType}, CollectionPage) whose lists show no page, a page of nothing that search engines treat as missing.`,
        fix: {
          tool: "set_page_module_content_many",
          hint: "Point the page's list at the pages it should show (its page query), publish those pages, or keep the page out of search until it lists some (set_page_seo_many, noindex).",
        },
      });
    }
    return out;
  }
  if (main === null) {
    if (spec.required.length > 0) {
      out.push({
        rule: "structured-data-required",
        severity: "error",
        pageId: f.pageId,
        message: `Structured data missing: ${f.path} is mapped as ${mapping.schemaType} but its graph has no ${spec.schemaType}, so it lacks ${spec.required.join(", ")}.`,
        fix: MAPPING_FIX,
      });
    }
    return out;
  }
  const missing = spec.required.filter((p) => !hasRequired(main, p));
  if (missing.length > 0) {
    out.push({
      rule: "structured-data-required",
      severity: "error",
      pageId: f.pageId,
      message: `Structured data incomplete: the ${spec.schemaType} of ${f.path} lacks ${missing.map((p) => missingLabel(main, p)).join(", ")}, which its rich result requires.`,
      fix: MAPPING_FIX,
    });
  }
  const shown = spec.builder === "article" ? main.headline : main.name;
  if (typeof shown === "string" && visible(f, shown) === false) {
    out.push({
      rule: "structured-data-not-visible",
      severity: "error",
      pageId: f.pageId,
      message: `Structured data not on the page: the ${spec.schemaType} of ${f.path} says ${spec.builder === "article" ? "headline" : "name"} "${clip(shown, 80)}", which the page does not show. Search engines want markup that matches what visitors read.`,
      fix: {
        tool: spec.builder === "article" ? "update_pages_many" : "set_schema_mappings_many",
        hint:
          spec.builder === "article"
            ? "Show the page's title in its <h1> (the template's {{page.title}}), or change the title to the heading the page shows."
            : "Map the name to a property a module on the page shows, or show it.",
      },
    });
  }
  if (
    spec.builder === "article" &&
    sourcesOf(mapping.roles.authors).length > 0 &&
    authorIds(main).length === 0
  ) {
    out.push({
      rule: "article-author-missing",
      severity: "error",
      pageId: f.pageId,
      message: `Article without author: ${f.path} is a ${mapping.pageType} page, whose type names authors, and it names none (or only unpublished ones).`,
      fix: {
        tool: "update_pages_many",
        hint: "Set the page's author property to the author's published page.",
      },
    });
  }
  if (spec.builder === "profile") {
    const lacks = (
      [
        ["description", "biography"],
        ["image", "portrait"],
        ["sameAs", "profile link"],
      ] as const
    ).filter(([p]) => !present(main[p]));
    if (lacks.length > 0) {
      const words = lacks.map(([, w]) => w);
      const list =
        words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : words[0];
      out.push({
        rule: "author-page-incomplete",
        severity: "warning",
        pageId: f.pageId,
        message: `Person page incomplete: the Person of ${f.path} has no ${list}. On an author's page that says little about who writes the articles that name it; a team member's or speaker's page may stay as it is.`,
        fix: MAPPING_FIX,
      });
    }
  }
  return out;
}

/** The structured data rule family. */
export const STRUCTURED_DATA_AUDIT_RULE: SeoAuditRule = {
  name: "structured-data",
  facts: async (ctx, { facts, auditRunId }) => {
    // A site that maps no page type has no graph of the plugin to judge:
    // its batches read nothing more.
    const mappings = await readMappings(ctx);
    if (mappings.size === 0) return [];
    const info = await infoOf(
      ctx,
      facts.map((f) => f.pageId),
    );
    const out: PluginAuditFinding[] = [];
    const authorPaths = new Set<string>();
    for (const f of facts) {
      const page = info.get(f.pageId);
      const mapping = page === undefined ? undefined : mappings.get(page.pageType);
      const spec = mapping ? SCHEMA_TYPES[mapping.schemaType] : undefined;
      if (!mapping || !spec || notJudged(f, page) !== null) continue;
      out.push(...pageDataFindings(f, mapping, spec));
      if (spec.builder !== "article") continue;
      const nodes = graphNodes(f.jsonLd.flatMap((b) => (b.kind === "parsed" ? [b.data] : [])));
      const main = mainNode(nodes, spec.schemaType, f.path);
      for (const id of main === null ? [] : authorIds(main)) {
        if (id.startsWith("#")) continue;
        const path = pathOf(id.split("#")[0] ?? "");
        if (path === null) continue;
        authorPaths.add(path);
      }
    }
    // Authors' pages: noindex ones are named on the author page, once.
    const byPath = await pagesAt(ctx, auditRunId, [...authorPaths]);
    const authorInfo = await infoOf(ctx, [...byPath.values()]);
    for (const [path, pageId] of byPath) {
      if (!authorInfo.get(pageId)?.noindex) continue;
      // The same text from every batch, so the audit files it once.
      out.push({
        rule: "author-page-noindex",
        severity: "error",
        pageId,
        message: `Author page left out of search: ${path} is noindex, and articles name it as their author, so the author reference leads search engines to a page they may not show.`,
        fix: {
          tool: "set_page_seo_many",
          hint: "Let the author page be indexed (noindex off), or name another author.",
        },
      });
    }
    return out;
  },
};
