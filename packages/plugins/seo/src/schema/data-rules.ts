// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — the structured data rules of the Stage audit: what the staged
 * page's JSON-LD graph says, read from the build (`facts.jsonLd`), against
 * the page type's schema mapping (#1756) and the page itself. Objective
 * only (maintainer decision 2026-11-26): what is missing or contradicts
 * the page; recommended properties stay write hints.
 *
 * - `structured-data-invalid`: a JSON-LD block that is no JSON (core
 *   writes valid JSON-LD, so a module's own block).
 * - `structured-data-required`: the page's main node lacks a property its
 *   rich result requires (the type table's `required`).
 * - `overview-empty`: an overview (CollectionPage) whose lists show no
 *   page: a page of nothing, which search engines treat as a soft 404.
 * - `structured-data-not-visible`: the main node's headline or name is not
 *   on the page (Google: markup must match the visible content).
 * - `article-author-missing`: the page type maps authors and this article
 *   names none.
 * - `author-page-incomplete`: a person's page without name, biography,
 *   portrait or a profile link, so its Person says little about who wrote
 *   the articles that name it.
 * - `author-page-noindex`: an article names an author whose page is
 *   noindex, so the author reference leads search engines to a page they
 *   may not show.
 *
 * Main node: the graph node of the type's main schema type whose `@id`
 * is the page's own URL with a fragment (an article's author Persons have
 * their own pages' URLs). A page with a JSON-LD block cut by the facts
 * budget (`omitted`) is not judged: its graph is not all there.
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

/** A path without its trailing slash (the root stays `/`). */
function bare(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The path of an absolute or root-relative URL, or null. */
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

/** Text as compared with the page: lower case, one space, no punctuation at the ends. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether `value` is on the page: in a heading or a visible text run. */
function visible(f: PluginAuditPageFacts, value: string): boolean | null {
  const v = norm(value);
  if (v === "") return true;
  const runs = [...f.headings.map((h) => h.text), ...f.texts.map((t) => t.text)].map(norm);
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

/** The findings of one page from its graph alone. */
export function pageDataFindings(
  f: PluginAuditPageFacts,
  mapping: SchemaMapping,
  spec: SchemaTypeSpec,
): PluginAuditFinding[] {
  const out: PluginAuditFinding[] = [];
  for (const b of f.jsonLd) {
    if (b.kind !== "invalid") continue;
    out.push({
      rule: "structured-data-invalid",
      severity: "error",
      pageId: f.pageId,
      message: `Invalid JSON-LD: ${f.path} carries a JSON-LD block that is no JSON (${b.error.slice(0, 120)}), so search engines read none of it.`,
      fix: {
        tool: "update_modules_many",
        hint: "Remove the module's own <script type=\"application/ld+json\">: core writes the page's structured data from the schema mapping.",
      },
    });
  }
  if (f.jsonLd.some((b) => b.kind === "omitted")) return out;
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
  const missing = spec.required.filter((p) => !present(main[p]));
  if (missing.length > 0) {
    out.push({
      rule: "structured-data-required",
      severity: "error",
      pageId: f.pageId,
      message: `Structured data incomplete: the ${spec.schemaType} of ${f.path} lacks ${missing.join(", ")}, which its rich result requires.`,
      fix: MAPPING_FIX,
    });
  }
  const shown = spec.builder === "article" ? main.headline : main.name;
  if (typeof shown === "string" && visible(f, shown) === false) {
    out.push({
      rule: "structured-data-not-visible",
      severity: "error",
      pageId: f.pageId,
      message: `Structured data not on the page: the ${spec.schemaType} of ${f.path} says ${spec.builder === "article" ? "headline" : "name"} "${shown.slice(0, 80)}", which the page does not show. Search engines want markup that matches what visitors read.`,
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
        severity: "error",
        pageId: f.pageId,
        message: `Person page incomplete: the Person of ${f.path} has no ${list}, so it says little about who writes the articles that name it. Accept it for a page that is no author's.`,
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
      const pageType = info.get(f.pageId)?.pageType;
      const mapping = pageType === undefined ? undefined : mappings.get(pageType);
      const spec = mapping ? SCHEMA_TYPES[mapping.schemaType] : undefined;
      if (!mapping || !spec) continue;
      out.push(...pageDataFindings(f, mapping, spec));
      if (spec.builder !== "article" || f.jsonLd.some((b) => b.kind === "omitted")) continue;
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
