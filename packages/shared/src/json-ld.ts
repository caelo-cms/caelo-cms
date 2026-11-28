// SPDX-License-Identifier: MPL-2.0

/**
 * #1753 — a page's structured data as ONE JSON-LD `@graph` with fixed
 * `@id`s, the Yoast / Joomla 5 pattern (epic #1751): one owner per node,
 * nodes linked by `@id`, plugins contributing typed nodes that core checks
 * and serializes.
 *
 * Core's nodes and their ids:
 *
 * | Node | `@id` | When |
 * |---|---|---|
 * | Organization | `<site>/#organization` | the site has an Organization name |
 * | WebSite | `<site>/#website` | always |
 * | WebPage (or a plugin's subtype) | `<page URL>` | always |
 * | BreadcrumbList | `<page URL>#breadcrumb` | the page shows a trail |
 *
 * `<site>` is the site base URL, `<page URL>` the page's canonical, both
 * from the one public URL builder (#590). A node a plugin contributes is
 * `<page URL>#<fragment>` of the page itself or of another page (an
 * author's Person: `<author page URL>#person`).
 *
 * One builder for the static build and the editor preview
 * ({@link buildPageGraph}, {@link renderJsonLdScript}), so they write the
 * same bytes; one reader for the Stage's integrity check
 * ({@link jsonLdIntegrityProblems}).
 */

import type { BreadcrumbJsonLdItem, SiteSeoSettings } from "./seo.js";

/** The `@context` of every graph. */
export const JSON_LD_CONTEXT = "https://schema.org";

/** The point a refused structured-data part is named after (`plugin-value-refused:<plugin>.structured-data.<field>:<rule>`). */
export const PLUGIN_STRUCTURED_DATA_POINT = "structured-data";

/**
 * The rule a page is refused with at the structured-data and the
 * sitemap-entries points when its record alone (with the pages it names) is
 * larger than one plugin call may carry (plugin-host `composition-calls.ts`).
 */
export const RECORD_TOO_LARGE_RULE = "record-too-large";

/**
 * The placeholder of a `{media}` value until the caller publishes the
 * image: the build through its media pass, the preview through its media
 * URLs. JSON, so it crosses a build's process boundary.
 */
export const MEDIA_PLACEHOLDER_KEY = "$caeloMedia";

/** The placeholder of a `{live}` date until the caller knows the page's live dates. */
export const LIVE_PLACEHOLDER_KEY = "$caeloLive";

/** A JSON-LD node as core writes it. */
export type JsonLdNode = Readonly<Record<string, unknown>>;

/** What one page's `<script type="application/ld+json">` holds. */
export interface JsonLdGraph {
  readonly "@context": typeof JSON_LD_CONTEXT;
  readonly "@graph": readonly JsonLdNode[];
}

/** The site's root URL with one trailing slash (`https://example.com/`). */
function siteRoot(siteBaseUrl: string | null): string {
  if (siteBaseUrl === null || siteBaseUrl.length === 0) return "/";
  return siteBaseUrl.endsWith("/") ? siteBaseUrl : `${siteBaseUrl}/`;
}

/**
 * The `@id` of a site node: `<site>/#organization`, `<site>/#website`.
 * Without a base URL (an editor preview before one is set) it is relative
 * to the site's root.
 */
export function siteNodeId(siteBaseUrl: string | null, node: "organization" | "website"): string {
  return `${siteRoot(siteBaseUrl)}#${node}`;
}

/**
 * The `@id` of a page node: the page URL itself for its WebPage, the URL
 * and a fragment for every other node named after the page. Without a URL
 * (a preview before the base URL is set) it is a fragment of the document.
 */
export function pageNodeId(pageUrl: string | null, fragment?: string): string {
  if (pageUrl === null) return fragment ? `#${fragment}` : "#webpage";
  return fragment ? `${pageUrl}#${fragment}` : pageUrl;
}

/** Core's half of a page's graph: what the page head already knows. */
export interface CoreGraphInput {
  /** The site base URL, null only in a preview before it is set. */
  readonly siteBaseUrl: string | null;
  /** The page's canonical URL, null exactly when `siteBaseUrl` is. */
  readonly canonical: string | null;
  /** `site_defaults.site_name`, null = the site has no name yet. */
  readonly siteName: string | null;
  /** The site's language (WebSite `inLanguage`); null only in a preview before it is set. */
  readonly siteLanguage: string | null;
  /** The page's document language (WebPage `inLanguage`); null like `siteLanguage`. */
  readonly pageLanguage: string | null;
  /** The page's own title: the WebPage `name`. */
  readonly pageTitle: string;
  /** The meta description the page renders ("" = none). */
  readonly description: string;
  /** The page's share image URL, or null. */
  readonly imageUrl: string | null;
  readonly organization: SiteSeoSettings["organization"];
  /** The trail the page shows (#1142); empty = no BreadcrumbList. */
  readonly breadcrumbs: readonly BreadcrumbJsonLdItem[];
  /**
   * The page's dates from the live page record: when it went live first
   * and last changed live (what its sitemap `<lastmod>` says). Null for a
   * page outside the record (a preview of a draft, a noindex page): it
   * carries no dates, and a plugin value naming one is left out.
   */
  readonly liveDates: { readonly published: string; readonly modified: string } | null;
}

/** One plugin's checked part of one page's graph (plugin-host `structured-data.ts`). */
export interface GraphContribution {
  readonly plugin: string;
  /** A WebPage subtype for core's WebPage node. */
  readonly webPageType?: string;
  /** Allowlisted WebPage properties, values resolved. */
  readonly webPage: Readonly<Record<string, unknown>>;
  /** Nodes, each with `@type` and `@id`, values resolved. */
  readonly nodes: readonly JsonLdNode[];
}

/** A refused part: which plugin, which property, which rule. */
export interface GraphRefusal {
  readonly plugin: string;
  readonly field: string;
  readonly rule: string;
}

/** What {@link buildPageGraph} returns. */
export interface BuiltPageGraph {
  readonly graph: JsonLdGraph;
  /** What core left out of the plugins' parts, and why (a render failure). */
  readonly refusals: readonly GraphRefusal[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An `{"@id": …}` reference: an object holding nothing but its `@id`. */
function referencedId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "@id" && typeof value["@id"] === "string"
    ? value["@id"]
    : null;
}

/** Every `@id` a value references, at any depth. */
function referencesIn(value: unknown, out: string[] = []): string[] {
  const id = referencedId(value);
  if (id !== null) {
    out.push(id);
    return out;
  }
  if (Array.isArray(value)) for (const v of value) referencesIn(v, out);
  else if (isRecord(value)) for (const v of Object.values(value)) referencesIn(v, out);
  return out;
}

/**
 * A page URL as the graph names it: absolute, resolved against the site
 * base URL. A page's canonical may be an override relative to the site
 * (`/canonical-article`, `pages_seo.set` accepts it); search engines read a
 * JSON-LD `@id` and `url` as written, so the graph never keeps it relative.
 * The plugin host resolves the URLs it builds nodes from the same way
 * (`structured-data.ts`), so both name a page alike.
 */
export function absolutePageUrl(url: string, siteBaseUrl: string | null): string {
  return siteBaseUrl ? new URL(url, siteRoot(siteBaseUrl)).href : url;
}

/** The core nodes of a page's graph, in their fixed order. */
function coreNodes(input: CoreGraphInput): { nodes: Record<string, unknown>[]; webPage: number } {
  const core: CoreGraphInput = {
    ...input,
    canonical:
      input.canonical === null ? null : absolutePageUrl(input.canonical, input.siteBaseUrl),
  };
  const org = core.organization;
  const orgId = siteNodeId(core.siteBaseUrl, "organization");
  const websiteId = siteNodeId(core.siteBaseUrl, "website");
  const webPageId = pageNodeId(core.canonical);
  const nodes: Record<string, unknown>[] = [];
  if (org.name) {
    nodes.push({
      "@type": "Organization",
      "@id": orgId,
      name: org.name,
      ...(org.url ? { url: org.url } : {}),
      ...(org.logo ? { logo: { "@type": "ImageObject", url: org.logo } } : {}),
      ...(org.sameAs?.length ? { sameAs: [...org.sameAs] } : {}),
    });
  }
  nodes.push({
    "@type": "WebSite",
    "@id": websiteId,
    ...(core.siteBaseUrl ? { url: siteRoot(core.siteBaseUrl) } : {}),
    ...(core.siteName ? { name: core.siteName } : {}),
    ...(core.siteLanguage ? { inLanguage: core.siteLanguage } : {}),
    ...(org.name ? { publisher: { "@id": orgId } } : {}),
  });
  const webPage = nodes.length;
  nodes.push({
    "@type": "WebPage",
    "@id": webPageId,
    ...(core.canonical ? { url: core.canonical } : {}),
    name: core.pageTitle,
    ...(core.description ? { description: core.description } : {}),
    ...(core.imageUrl ? { image: core.imageUrl } : {}),
    ...(core.pageLanguage ? { inLanguage: core.pageLanguage } : {}),
    isPartOf: { "@id": websiteId },
    ...(core.breadcrumbs.length > 0
      ? { breadcrumb: { "@id": pageNodeId(core.canonical, "breadcrumb") } }
      : {}),
    ...(org.name ? { publisher: { "@id": orgId } } : {}),
    ...(core.liveDates
      ? { datePublished: core.liveDates.published, dateModified: core.liveDates.modified }
      : {}),
  });
  if (core.breadcrumbs.length > 0) {
    nodes.push({
      "@type": "BreadcrumbList",
      "@id": pageNodeId(core.canonical, "breadcrumb"),
      itemListElement: core.breadcrumbs.map((b, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: b.name,
        item: b.url,
      })),
    });
  }
  return { nodes, webPage };
}

/** A value with its placeholders filled, left out (`omit`), or refused (`rule`). */
type Filled = { readonly value: unknown } | { readonly omit: true } | { readonly rule: string };

/**
 * Fill a value's media and live-date placeholders. A live date the page
 * does not have leaves the property out (not a refusal: the page is not in
 * the live record); a media file the render cannot publish refuses it.
 */
function fill(
  value: unknown,
  core: CoreGraphInput,
  mediaUrl: (assetId: string) => string | null,
): Filled {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) {
      const f = fill(v, core, mediaUrl);
      if ("rule" in f) return f;
      if ("value" in f) out.push(f.value);
    }
    return out.length === 0 ? { omit: true } : { value: out };
  }
  if (!isRecord(value)) return { value };
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === MEDIA_PLACEHOLDER_KEY) {
    const url = mediaUrl(String(value[MEDIA_PLACEHOLDER_KEY]));
    return url === null ? { rule: "media-unpublishable" } : { value: url };
  }
  if (keys.length === 1 && keys[0] === LIVE_PLACEHOLDER_KEY) {
    const which = value[LIVE_PLACEHOLDER_KEY];
    if (core.liveDates === null) return { omit: true };
    return { value: which === "published" ? core.liveDates.published : core.liveDates.modified };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const f = fill(v, core, mediaUrl);
    if ("rule" in f) return f;
    if ("value" in f) out[k] = f.value;
  }
  return { value: out };
}

/** The keys of a node core never lets a property name: they make it a node. */
const NODE_KEYWORDS = new Set(["@type", "@id"]);

/**
 * Build one page's graph: core's nodes with their fixed ids, then each
 * plugin's WebPage type and properties on core's WebPage node and its
 * nodes, in the order given (plugin slug order).
 *
 * One owner per `@id` and per WebPage property: the first part to claim
 * one keeps it, and a later one that says something else is refused
 * (`id-taken`, `webpage-type-conflict`, `webpage-property-conflict`); a core
 * node's id cannot be claimed (`id-reserved`). Every `@id` a plugin's value
 * references must name a node of the graph (`ref-dangling`): the property
 * is left out. Each refusal is returned for the caller to report as a
 * render failure.
 *
 * @param mediaUrl the published URL of a library image, or null when this
 *   render cannot publish it.
 */
export function buildPageGraph(
  core: CoreGraphInput,
  contributions: readonly GraphContribution[],
  mediaUrl: (assetId: string) => string | null,
): BuiltPageGraph {
  const refusals: GraphRefusal[] = [];
  const { nodes, webPage: webPageAt } = coreNodes(core);
  const webPage = nodes[webPageAt] as Record<string, unknown>;
  const coreIds = new Set(nodes.map((n) => String(n["@id"])));
  const owner = new Map<string, string>();
  const webPageOwners = new Map<string, string>();
  const contributed: { plugin: string; node: Record<string, unknown> }[] = [];
  const webPageProps: { plugin: string; key: string; value: unknown }[] = [];

  for (const c of contributions) {
    const refuse = (field: string, rule: string) =>
      refusals.push({ plugin: c.plugin, field, rule });
    if (c.webPageType !== undefined) {
      const current = webPageOwners.get("@type");
      if (current === undefined) {
        webPageOwners.set("@type", c.plugin);
        webPage["@type"] = c.webPageType;
      } else if (webPage["@type"] !== c.webPageType) refuse("webpage", "webpage-type-conflict");
    }
    for (const [key, raw] of Object.entries(c.webPage)) {
      const f = fill(raw, core, mediaUrl);
      if ("rule" in f) {
        refuse(key, f.rule);
        continue;
      }
      if ("omit" in f) continue;
      const taken = webPageProps.find((p) => p.key === key);
      if (taken) {
        if (JSON.stringify(taken.value) !== JSON.stringify(f.value)) {
          refuse(key, "webpage-property-conflict");
        }
        continue;
      }
      webPageProps.push({ plugin: c.plugin, key, value: f.value });
    }
    for (const n of c.nodes) {
      const id = String(n["@id"]);
      if (coreIds.has(id)) {
        refuse("id", "id-reserved");
        continue;
      }
      const holder = owner.get(id);
      if (holder !== undefined) {
        refuse("id", "id-taken");
        continue;
      }
      const node: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(n)) {
        if (NODE_KEYWORDS.has(key)) {
          node[key] = raw;
          continue;
        }
        const f = fill(raw, core, mediaUrl);
        if ("rule" in f) {
          refuse(key, f.rule);
          continue;
        }
        if ("value" in f) node[key] = f.value;
      }
      owner.set(id, c.plugin);
      contributed.push({ plugin: c.plugin, node });
    }
  }

  // Every id the graph holds: references must name one of them.
  const ids = new Set([...coreIds, ...owner.keys()]);
  for (const p of webPageProps) {
    const dangling = referencesIn(p.value).some((id) => !ids.has(id));
    if (dangling) refusals.push({ plugin: p.plugin, field: p.key, rule: "ref-dangling" });
    else webPage[p.key] = p.value;
  }
  for (const { plugin, node } of contributed) {
    for (const [key, value] of Object.entries(node)) {
      if (NODE_KEYWORDS.has(key)) continue;
      if (referencesIn(value).some((id) => !ids.has(id))) {
        delete node[key];
        refusals.push({ plugin, field: key, rule: "ref-dangling" });
      }
    }
  }
  return {
    graph: {
      "@context": JSON_LD_CONTEXT,
      "@graph": [...nodes, ...contributed.map((c) => c.node)],
    },
    refusals,
  };
}

/**
 * The page's one `<script type="application/ld+json">`. Every `<` is
 * written `\u003c`, so no value can close the script (`</script>`) or open
 * a comment, whatever a check upstream let through.
 */
export function renderJsonLdScript(graph: JsonLdGraph): string {
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}

// ---------------------------------------------------------------------------
// Integrity of a rendered page's JSON-LD (the Stage's `structured-data` check)
// ---------------------------------------------------------------------------

/** One JSON-LD block of a page as the audit's page facts read it. */
export type JsonLdBlock =
  | { readonly kind: "parsed"; readonly data: unknown }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "omitted"; readonly chars: number };

/** What is wrong with a page's JSON-LD. */
export type JsonLdProblem =
  | { readonly rule: "invalid-json"; readonly detail: string }
  | { readonly rule: "graph-missing" }
  | { readonly rule: "extra-block"; readonly count: number }
  | { readonly rule: "dangling-id"; readonly ids: readonly string[] }
  | { readonly rule: "duplicate-id"; readonly ids: readonly string[] }
  | { readonly rule: "not-checked"; readonly chars: number };

/** The node definitions and references of one block, at any depth. */
function collectIds(
  value: unknown,
  definitions: Map<string, number>,
  references: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, definitions, references);
    return;
  }
  if (!isRecord(value)) return;
  const id = value["@id"];
  if (typeof id === "string") {
    const keys = Object.keys(value).filter((k) => k !== "@context");
    if (keys.length === 1) references.add(id);
    else definitions.set(id, (definitions.get(id) ?? 0) + 1);
  }
  for (const [k, v] of Object.entries(value)) {
    if (k !== "@context") collectIds(v, definitions, references);
  }
}

/** Whether a block is one graph (`{"@graph": [...]}`). */
function isGraph(data: unknown): boolean {
  return isRecord(data) && Array.isArray(data["@graph"]);
}

/**
 * What is wrong with one rendered page's JSON-LD, read together as one
 * graph (a search engine resolves `@id`s across the blocks of a page):
 *
 * - `invalid-json`: a block a JSON parser refuses;
 * - `graph-missing`: no block holds a `@graph` (core writes one on every page);
 * - `extra-block`: more blocks than core's one (structured data in a
 *   module's markup, which no check of core's own output covers);
 * - `dangling-id`: an `{"@id": …}` reference that names no node of the page;
 * - `duplicate-id`: two node definitions with one `@id`;
 * - `not-checked`: blocks the facts left out for their size.
 */
export function jsonLdIntegrityProblems(blocks: readonly JsonLdBlock[]): JsonLdProblem[] {
  const problems: JsonLdProblem[] = [];
  const definitions = new Map<string, number>();
  const references = new Set<string>();
  let graphs = 0;
  let omitted = 0;
  for (const b of blocks) {
    if (b.kind === "invalid") {
      problems.push({ rule: "invalid-json", detail: b.error });
      continue;
    }
    if (b.kind === "omitted") {
      omitted += b.chars;
      continue;
    }
    if (isGraph(b.data)) graphs += 1;
    collectIds(b.data, definitions, references);
  }
  if (graphs === 0 && omitted === 0) problems.push({ rule: "graph-missing" });
  if (blocks.length > 1) problems.push({ rule: "extra-block", count: blocks.length - 1 });
  const dangling = [...references].filter((id) => !definitions.has(id)).sort();
  if (dangling.length > 0 && omitted === 0) problems.push({ rule: "dangling-id", ids: dangling });
  const duplicate = [...definitions]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();
  if (duplicate.length > 0) problems.push({ rule: "duplicate-id", ids: duplicate });
  if (omitted > 0) problems.push({ rule: "not-checked", chars: omitted });
  return problems;
}
