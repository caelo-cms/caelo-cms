// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/structured-data — the structured-data composition
 * point (#1753, epic #1751): the nodes plugins add to a page's JSON-LD
 * graph.
 *
 * A plugin declares `structuredDataOperation` (capability
 * `structured_data`; `$structuredData` for an installed plugin) and answers
 * per page with typed nodes from a closed vocabulary (plugin SDK
 * `structured-data.ts`). The host checks every part
 * (structured-data-vocabulary.ts), builds every URL and `@id` itself with
 * the builder that makes each page's canonical, and hands core the
 * resolved parts; core adds its own nodes, keeps one owner per `@id` and
 * serializes the graph (shared `json-ld.ts`). The static build and the
 * editor preview both ask through here, so they agree byte for byte.
 *
 * A part outside the vocabulary (an unknown type, markup in a text, an
 * address of this site written as text, a page the render cannot see, a
 * reference image, an answer over its cap) is refused and recorded as a
 * `plugin-value-refused` render failure (`refused`): the preview lists it,
 * a Stage records it, Publish live refuses the build (#1604). A failing
 * call is flagged in a preview and stops a build (#1087).
 *
 * One plugin model (#1729): a shipped plugin's answer is chunked, capped
 * and checked exactly like a sandboxed one's.
 */

import {
  STRUCTURED_DATA_ANSWER_MAX_BYTES,
  STRUCTURED_DATA_PAGES_PER_CALL,
  type StructuredDataArgs,
  type StructuredDataPage,
} from "@caelo-cms/plugin-sdk";
import {
  type GraphContribution,
  LIVE_PLACEHOLDER_KEY,
  MEDIA_PLACEHOLDER_KEY,
  PLUGIN_STRUCTURED_DATA_POINT,
  pageNodeId,
  pluginValueRefusedMarker,
  siteNodeId,
} from "@caelo-cms/shared";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { resolveTargetUrls } from "./head-composition.js";
import { checkPluginMedia, describePluginMedia } from "./plugin-values.js";
import type { PublicUrlContext } from "./public-urls.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import {
  type CheckedPageAnswer,
  type CheckedRef,
  type CheckedScalar,
  type CheckedValue,
  checkStructuredDataAnswer,
  mediaNamedBy,
  pagesNamedBy,
  type StructuredDataRefusal,
} from "./structured-data-vocabulary.js";

/** What every plugin added to the pages asked about. */
export interface CollectedStructuredData {
  /** pageId → each contributing plugin's part, in plugin slug order. */
  readonly parts: Map<string, GraphContribution[]>;
  /** pageId → the `plugin-value-refused` markers of what core refused. */
  readonly refused: Map<string, string[]>;
}

/** The pages a render asks about, and what they name. */
export type StructuredDataInput = StructuredDataArgs;

/** The plugins that contribute, in slug order (the graph's node order). */
function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.structuredDataOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Whether any running plugin contributes structured data (else core asks nobody). */
export function hasStructuredDataContributors(): boolean {
  return contributors().length > 0;
}

const PAGE_REF_RE = /^caelo:page\/([0-9a-f-]{36})$/i;

/** The pages one page names: its `page` properties' targets and its terms' overview pages. */
function namedPages(page: StructuredDataPage): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const m = PAGE_REF_RE.exec(v);
      if (m) out.add((m[1] as string).toLowerCase());
    } else if (Array.isArray(v)) for (const e of v) visit(e);
  };
  for (const value of Object.values(page.properties)) visit(value);
  for (const t of page.terms) if (t.overviewPageId) out.add(t.overviewPageId.toLowerCase());
  return [...out];
}

/**
 * The arguments of one call: its pages, the pages they name, their page
 * types (the sitemap-entries point asks with the same records).
 */
export function chunkArgs(
  input: StructuredDataInput,
  chunk: readonly StructuredDataPage[],
): StructuredDataArgs {
  const wanted = new Set(chunk.flatMap(namedPages));
  const related = input.related.filter((r) => wanted.has(r.pageId.toLowerCase()));
  const types = new Set([...chunk, ...related].map((p) => p.pageType));
  return {
    pages: chunk,
    related,
    pageTypes: Object.fromEntries(
      Object.entries(input.pageTypes).filter(([slug]) => types.has(slug)),
    ),
    site: input.site,
  };
}

/**
 * Collect + check every plugin's structured data for the given pages.
 * Loud (no fallbacks): a failing call throws in a build and is flagged in a
 * preview (#1087); what the vocabulary refuses is recorded in `refused`.
 *
 * @param opts the render's branch and the URL context core builds every
 *   URL in (the serving target's origin and page URL style).
 */
export async function collectStructuredData(
  input: StructuredDataInput,
  opts: PublicUrlContext & RenderScope,
): Promise<CollectedStructuredData> {
  const out: CollectedStructuredData = { parts: new Map(), refused: new Map() };
  if (input.pages.length === 0) return out;
  const plugins = contributors();
  if (plugins.length === 0) return out;

  const refuse = (slug: string, r: StructuredDataRefusal) => {
    const marker = pluginValueRefusedMarker(slug, PLUGIN_STRUCTURED_DATA_POINT, r.field, r.rule);
    const list = out.refused.get(r.pageId) ?? [];
    if (!list.includes(marker)) list.push(marker);
    out.refused.set(r.pageId, list);
  };

  // Every plugin's checked answers first, so the pages and media they name
  // are resolved once for the whole pass.
  const answers: { slug: string; pages: ReadonlyMap<string, CheckedPageAnswer> }[] = [];
  for (const lp of plugins) {
    const operationName = lp.definition.structuredDataOperation as string;
    const label = `structured-data: ${lp.slug}.${operationName}`;
    for (let at = 0; at < input.pages.length; at += STRUCTURED_DATA_PAGES_PER_CALL) {
      const chunk = input.pages.slice(at, at + STRUCTURED_DATA_PAGES_PER_CALL);
      const asked = new Set(chunk.map((p) => p.pageId));
      const r = await runPluginOperation({
        invocation: renderInvocation(opts),
        pluginSlug: lp.slug,
        operationName,
        args: chunkArgs(input, chunk),
        maxAnswerBytes: STRUCTURED_DATA_ANSWER_MAX_BYTES,
      });
      const tooLarge = r.ok
        ? Buffer.byteLength(JSON.stringify(r.value ?? null)) > STRUCTURED_DATA_ANSWER_MAX_BYTES
        : r.error.message.includes("SandboxAnswerTooLarge");
      if (tooLarge) {
        for (const pageId of asked)
          refuse(lp.slug, { pageId, field: "answer", rule: "answer-too-large" });
        continue;
      }
      if (!r.ok) {
        const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
        if (
          reportPluginRenderFailure(opts, {
            slug: lp.slug,
            point: PLUGIN_STRUCTURED_DATA_POINT,
            reason,
          })
        ) {
          break;
        }
        throw new Error(reason);
      }
      const checked = checkStructuredDataAnswer(r.value, asked);
      for (const refusal of checked.refusals) refuse(lp.slug, refusal);
      answers.push({ slug: lp.slug, pages: checked.pages });
    }
  }

  // The pages every part names, the asked pages themselves included (a
  // node's `{fragment}` id is `<page URL>#<fragment>`), and the media.
  const pageIds = new Set(input.pages.map((p) => p.pageId.toLowerCase()));
  const mediaIds = new Set<string>();
  for (const a of answers) {
    for (const part of a.pages.values()) {
      for (const value of part.webPage.values()) {
        pagesNamedBy(value, pageIds);
        mediaNamedBy(value, mediaIds);
      }
      for (const node of part.nodes) {
        if (node.id.page !== null) pageIds.add(node.id.page);
        for (const value of node.props.values()) {
          pagesNamedBy(value, pageIds);
          mediaNamedBy(value, mediaIds);
        }
      }
    }
  }
  const resolved = await resolveTargetUrls([...pageIds], opts);
  const urls = new Map([...resolved].map(([id, url]) => [id.toLowerCase(), url]));
  // Media is not branched: a preview and a build see the same facts.
  const facts = await describePluginMedia([...mediaIds]);
  const mediaRules = new Map(
    [...mediaIds].map((id) => [id, checkPluginMedia(`caelo:media/${id}`, facts)]),
  );
  // The site's own hosts: an address on one of them is a page, never `{url}`.
  const ownHosts = new Set<string>([new URL(opts.siteBaseUrl).host]);
  for (const url of urls.values()) ownHosts.add(new URL(url).host);

  for (const a of answers) {
    for (const [pageId, part] of a.pages) {
      const pageUrl = urls.get(pageId.toLowerCase());
      if (pageUrl === undefined) {
        refuse(a.slug, { pageId, field: "page", rule: "page-unknown" });
        continue;
      }
      const resolver = new ValueResolver(opts.siteBaseUrl, pageUrl, urls, mediaRules, ownHosts);
      const webPage: Record<string, unknown> = {};
      for (const [name, value] of part.webPage) {
        const v = resolver.value(value);
        if ("rule" in v) refuse(a.slug, { pageId, field: name, rule: v.rule });
        else webPage[name] = v.json;
      }
      const nodes: Record<string, unknown>[] = [];
      for (const node of part.nodes) {
        const idUrl = node.id.page === null ? pageUrl : urls.get(node.id.page);
        if (idUrl === undefined) {
          refuse(a.slug, { pageId, field: "id", rule: "page-unknown" });
          continue;
        }
        const json: Record<string, unknown> = {
          "@type": node.types.length === 1 ? node.types[0] : [...node.types],
          "@id": pageNodeId(idUrl, node.id.fragment),
        };
        for (const [name, value] of node.props) {
          const v = resolver.value(value);
          if ("rule" in v) refuse(a.slug, { pageId, field: name, rule: v.rule });
          else json[name] = v.json;
        }
        nodes.push(json);
      }
      const list = out.parts.get(pageId) ?? [];
      list.push({
        plugin: a.slug,
        ...(part.webPageType ? { webPageType: part.webPageType } : {}),
        webPage,
        nodes,
      });
      out.parts.set(pageId, list);
    }
  }
  return out;
}

/** Turns checked values into the JSON core writes, for one page. */
class ValueResolver {
  constructor(
    private readonly siteBaseUrl: string,
    private readonly pageUrl: string,
    private readonly urls: ReadonlyMap<string, string>,
    private readonly mediaRules: ReadonlyMap<string, string | null>,
    private readonly ownHosts: ReadonlySet<string>,
  ) {}

  value(value: CheckedValue): { json: unknown } | { rule: string } {
    if (value.k !== "list") return this.scalar(value);
    const json: unknown[] = [];
    for (const item of value.items) {
      const r = this.scalar(item);
      if ("rule" in r) return r;
      json.push(r.json);
    }
    return { json };
  }

  private ref(ref: CheckedRef): { json: unknown } | { rule: string } {
    if ("core" in ref) {
      switch (ref.core) {
        case "organization":
        case "website":
          return { json: { "@id": siteNodeId(this.siteBaseUrl, ref.core) } };
        case "webpage":
          return { json: { "@id": pageNodeId(this.pageUrl) } };
        case "breadcrumb":
          return { json: { "@id": pageNodeId(this.pageUrl, "breadcrumb") } };
      }
    }
    const url = ref.page === null ? this.pageUrl : this.urls.get(ref.page);
    return url === undefined
      ? { rule: "page-unknown" }
      : { json: { "@id": pageNodeId(url, ref.fragment) } };
  }

  private scalar(value: CheckedScalar): { json: unknown } | { rule: string } {
    switch (value.k) {
      case "text":
      case "number":
      case "bool":
      case "date":
      case "duration":
        return { json: value.v };
      case "live":
        return { json: { [LIVE_PLACEHOLDER_KEY]: value.v } };
      case "page": {
        const url = this.urls.get(value.id);
        return url === undefined ? { rule: "page-unknown" } : { json: url };
      }
      case "media": {
        const rule = this.mediaRules.get(value.id);
        return rule ? { rule } : { json: { [MEDIA_PLACEHOLDER_KEY]: value.id } };
      }
      case "url":
        return this.ownHosts.has(new URL(value.v).host)
          ? { rule: "url-own-site" }
          : { json: value.v };
      case "schema":
        return { json: `https://schema.org/${value.v}` };
      case "ref":
        return this.ref(value.ref);
      case "node": {
        const json: Record<string, unknown> = {
          "@type": value.types.length === 1 ? value.types[0] : [...value.types],
        };
        for (const [name, v] of value.props) {
          const r = this.value(v);
          if ("rule" in r) return r;
          json[name] = r.json;
        }
        return { json };
      }
    }
  }
}
