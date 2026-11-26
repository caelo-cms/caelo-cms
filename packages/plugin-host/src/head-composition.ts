// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/head-composition — the head + sitemap
 * contribution points (#391, epic #380 decision 1; #1729).
 *
 * Plugins DECLARE contribution kinds in their manifest (capability
 * `head_contributions`) and supply an operation that returns TYPED entries
 * per page from a closed vocabulary (plugin SDK `head-contributions.ts`):
 * hreflang alternates that name the other version by page id,
 * `og:locale` / `og:locale:alternate`, sitemap exclusions and alternates.
 * The host checks every entry against it (head-vocabulary.ts), builds every
 * URL itself with the builder that makes each target's canonical, merges
 * additively with stable-key dedup, and fails LOUDLY on contradictions —
 * two plugins (or one plugin twice) asserting different values under the
 * same key is a bug to surface, never a last-writer-wins coin flip.
 *
 * A part outside the vocabulary (a stylesheet `link`, a `robots` meta, an
 * `href` instead of a page id, a page id the render cannot see, an answer
 * over its cap) is refused and recorded as a `plugin-value-refused` render
 * failure (`refused`): the preview lists it, a Stage records it, Publish
 * live refuses the build (#1604). It is never silently dropped.
 *
 * One plugin model (#1729, decision Q2 A): a shipped plugin's answer is
 * chunked, capped and checked exactly like a sandboxed one's; an installed
 * plugin answers through the `$contributions` reserved entry.
 *
 * Serialization (`renderHeadEntries`, below) is consumed by the static
 * generator AND the admin preview through the same call — the
 * historical hreflang bug was exactly two hand-kept head assemblies
 * drifting apart.
 */

import {
  HEAD_ANSWER_MAX_BYTES,
  type HeadEntry,
  type HeadMetaProperty,
  type SitemapContribution,
} from "@caelo-cms/plugin-sdk";
import { execute, joinHeldTransaction } from "@caelo-cms/query-api";
import { PLUGIN_HEAD_POINT, pluginValueRefusedMarker } from "@caelo-cms/shared";
import {
  hostInfra,
  hostSystemActorId,
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { type CheckedHeadAnswer, checkHeadAnswer, type HeadRefusal } from "./head-vocabulary.js";
import { type PublicUrlContext, type PublicUrlPage, resolvePublicPageUrls } from "./public-urls.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import { chunkPageIds } from "./render-points.js";

/**
 * Pages one contribution call is asked about. An answer grows with its
 * pages: at the vocabulary's limits (20 head entries and 20 sitemap
 * alternates of 35-character tags) a page's answer is under 5 KB, so 200
 * pages stay under the 1 MB answer cap however full each page is.
 */
export const HEAD_CONTRIBUTION_PAGES_PER_CALL = 200;

/** Pages one target lookup reads (`pages.public_url_pages`'s input cap). */
const TARGET_LOOKUP_BATCH = 1000;

/** A head entry as core renders it: the alternate's URL is built. */
export type ResolvedHeadEntry =
  | {
      readonly kind: "link";
      readonly rel: "alternate";
      readonly hreflang: string;
      readonly href: string;
    }
  | { readonly kind: "meta"; readonly property: HeadMetaProperty; readonly content: string };

/** A page's sitemap adjustments as core writes them. */
export interface ResolvedSitemapContribution {
  readonly exclude?: true;
  readonly alternates?: ReadonlyArray<{ readonly hreflang: string; readonly href: string }>;
}

export interface CollectedContributions {
  readonly head: Map<string, ResolvedHeadEntry[]>;
  readonly sitemap: Map<string, ResolvedSitemapContribution>;
  /** Per-page document language (`<html lang>`), when a plugin knows it
   *  (e.g. the page's locale). Absent → the site's stored language. */
  readonly lang: Map<string, string>;
  /**
   * #1729 — per page, the `plugin-value-refused` markers of what core
   * refused from the plugins' answers. The page renders without those
   * parts; the preview lists the markers, a build records them as render
   * failures (Publish live refuses).
   */
  readonly refused: Map<string, string[]>;
}

interface ContributionSource {
  readonly pluginSlug: string;
  readonly operationName: string;
}

function contributingPlugins(): ContributionSource[] {
  const out: ContributionSource[] = [];
  for (const lp of loadedPlugins.all()) {
    if (isPluginDisabled(lp.slug)) continue;
    const kinds = lp.definition.contributes ?? [];
    if (kinds.length === 0) continue;
    const op = lp.definition.contributionsOperation;
    if (!op) {
      throw new Error(
        `head-composition: plugin "${lp.slug}" declares contributes=[${kinds.join(", ")}] but no contributionsOperation`,
      );
    }
    out.push({ pluginSlug: lp.slug, operationName: op });
  }
  return out;
}

/**
 * Stable identity key: same key must mean same value (else: loud). The
 * link form is the one entries were sorted by before #1729, so the
 * rendered order of a page's alternates did not change with it.
 * `og:locale:alternate` may appear once per other locale, so its value is
 * part of its identity.
 */
function headEntryKey(e: ResolvedHeadEntry | HeadEntry): string {
  if (e.kind === "link") return `link|${e.rel}|${e.hreflang}|`;
  return e.property === "og:locale:alternate"
    ? `meta||${e.property}|${e.content}`
    : `meta||${e.property}`;
}

/** What a key asserts: the page an alternate names, a meta's content. */
function headEntryValue(e: HeadEntry): string {
  return e.kind === "link" ? e.pageId : e.content;
}

/** One plugin's checked answer for one chunk. */
interface ChunkAnswer {
  readonly pluginSlug: string;
  readonly checked: CheckedHeadAnswer;
}

/**
 * Collect + check + merge all plugins' head/sitemap contributions for the
 * given pages. Loud (no-fallbacks): a failing contribution op throws in a
 * build (a preview reports it and renders without the plugin, #1087), and
 * contradictory entries under one key throw everywhere. What the
 * vocabulary refuses is recorded in `refused`.
 *
 * @param opts the render's branch and the URL context core builds every
 *   alternate's URL in (the serving target's origin and page URL style).
 */
export async function collectContributions(
  pageIds: ReadonlyArray<string>,
  opts: PublicUrlContext & RenderScope,
): Promise<CollectedContributions> {
  const out: CollectedContributions = {
    head: new Map(),
    sitemap: new Map(),
    lang: new Map(),
    refused: new Map(),
  };
  if (pageIds.length === 0) return out;

  const answers: ChunkAnswer[] = [];
  for (const source of contributingPlugins()) {
    // #1729 — one call per chunk of pages (render-points.ts): a preview
    // asks once, a 50 000-page build in calls whose answers stay under the
    // cap.
    for (const chunk of chunkPageIds(pageIds, { maxIds: HEAD_CONTRIBUTION_PAGES_PER_CALL })) {
      const checked = await askChunk(source, chunk, opts);
      if (checked === null) break;
      answers.push({ pluginSlug: source.pluginSlug, checked });
    }
  }

  const refuse = (pluginSlug: string, r: HeadRefusal) => {
    const marker = pluginValueRefusedMarker(pluginSlug, PLUGIN_HEAD_POINT, r.field, r.rule);
    const list = out.refused.get(r.pageId) ?? [];
    if (!list.includes(marker)) list.push(marker);
    out.refused.set(r.pageId, list);
  };
  for (const a of answers) for (const r of a.checked.refusals) refuse(a.pluginSlug, r);

  // Every page an alternate names, resolved once for the whole pass.
  const targets = new Set<string>();
  for (const { checked } of answers) {
    for (const entries of checked.head.values()) {
      for (const e of entries) if (e.kind === "link") targets.add(e.pageId);
    }
    for (const s of checked.sitemap.values()) {
      for (const alt of s.alternates ?? []) targets.add(alt.pageId);
    }
  }
  const urls = await resolveTargetUrls([...targets], opts);

  const headKeys = new Map<string, Map<string, { value: string; source: string }>>();
  const langSource = new Map<string, string>();
  for (const { pluginSlug, checked } of answers) {
    for (const [pageId, entries] of checked.head) {
      const perPage = out.head.get(pageId) ?? [];
      const perPageKeys =
        headKeys.get(pageId) ?? new Map<string, { value: string; source: string }>();
      for (const entry of entries) {
        const href = entry.kind === "link" ? urls.get(entry.pageId) : undefined;
        if (entry.kind === "link" && href === undefined) {
          refuse(pluginSlug, { pageId, field: "link", rule: "page-unknown" });
          continue;
        }
        const key = headEntryKey(entry);
        const valueSig = headEntryValue(entry);
        const existing = perPageKeys.get(key);
        if (existing) {
          if (existing.value === valueSig) continue; // exact duplicate — dedup
          throw new Error(
            `head-composition: contradictory head entries for page ${pageId} under key "${key}": "${existing.value}" (from ${existing.source}) vs "${valueSig}" (from ${pluginSlug}). Contributions must agree or stay disjoint.`,
          );
        }
        perPageKeys.set(key, { value: valueSig, source: pluginSlug });
        perPage.push(
          entry.kind === "link"
            ? { kind: "link", rel: "alternate", hreflang: entry.hreflang, href: href as string }
            : entry,
        );
      }
      if (perPage.length > 0) out.head.set(pageId, perPage);
      headKeys.set(pageId, perPageKeys);
    }

    for (const [pageId, contribution] of checked.sitemap) {
      mergeSitemap(out, pageId, contribution, urls, (rule) =>
        refuse(pluginSlug, { pageId, field: "sitemap", rule }),
      );
    }

    for (const [pageId, language] of checked.lang) {
      const existing = out.lang.get(pageId);
      if (existing !== undefined && existing !== language) {
        throw new Error(
          `head-composition: contradictory document languages for page ${pageId}: "${existing}" (from ${langSource.get(pageId)}) vs "${language}" (from ${pluginSlug}). Contributions must agree or stay disjoint.`,
        );
      }
      out.lang.set(pageId, language);
      langSource.set(pageId, pluginSlug);
    }
  }
  return out;
}

/**
 * Merge one plugin's sitemap adjustments for one page: exclusion is
 * sticky-true; alternates concatenate with hreflang-key dedup and a
 * contradiction check on the URL they name.
 */
function mergeSitemap(
  out: CollectedContributions,
  pageId: string,
  contribution: SitemapContribution,
  urls: ReadonlyMap<string, string>,
  refuse: (rule: string) => void,
): void {
  const existing = out.sitemap.get(pageId);
  const merged = [...(existing?.alternates ?? [])];
  for (const alt of contribution.alternates ?? []) {
    const href = urls.get(alt.pageId);
    if (href === undefined) {
      refuse("page-unknown");
      continue;
    }
    const clash = merged.find((a) => a.hreflang === alt.hreflang);
    if (clash) {
      if (clash.href === href) continue;
      throw new Error(
        `head-composition: contradictory sitemap alternates for page ${pageId} hreflang="${alt.hreflang}": "${clash.href}" vs "${href}"`,
      );
    }
    merged.push({ hreflang: alt.hreflang, href });
  }
  const exclude = existing?.exclude === true || contribution.exclude === true;
  out.sitemap.set(pageId, {
    ...(exclude ? { exclude: true as const } : {}),
    ...(merged.length > 0 ? { alternates: merged } : {}),
  });
}

/**
 * Ask one plugin about one chunk of pages and check its answer; null when
 * a preview skips the plugin because its call failed (#1087).
 */
async function askChunk(
  source: ContributionSource,
  chunk: string[],
  opts: PublicUrlContext & RenderScope,
): Promise<CheckedHeadAnswer | null> {
  const label = `head-composition: ${source.pluginSlug}.${source.operationName}`;
  const tooLarge = (): CheckedHeadAnswer => ({
    head: new Map(),
    sitemap: new Map(),
    lang: new Map(),
    refusals: chunk.map((pageId) => ({ pageId, field: "answer", rule: "answer-too-large" })),
  });
  const r = await runPluginOperation({
    invocation: renderInvocation(opts),
    pluginSlug: source.pluginSlug,
    operationName: source.operationName,
    args: { pageIds: chunk },
    maxAnswerBytes: HEAD_ANSWER_MAX_BYTES,
  });
  if (!r.ok) {
    // A sandboxed answer over the cap is refused while its parts arrive.
    if (r.error.message.includes("SandboxAnswerTooLarge")) return tooLarge();
    const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
    // #1087 — a preview renders the head without this plugin's entries
    // and flags it; a build throws.
    if (
      reportPluginRenderFailure(opts, {
        slug: source.pluginSlug,
        point: "head-composition",
        reason,
      })
    ) {
      return null;
    }
    throw new Error(reason);
  }
  // The same cap for an answer that never crossed the wire (a shipped plugin).
  if (Buffer.byteLength(JSON.stringify(r.value ?? null)) > HEAD_ANSWER_MAX_BYTES) {
    return tooLarge();
  }
  return checkHeadAnswer(r.value, new Set(chunk), label);
}

/**
 * The public URL of every page an alternate names, in the render's view
 * (the chat's branch in a preview, main in a build), through the builder
 * that makes each page's canonical: an alternate and its target's canonical
 * agree byte for byte (#590). A page the view does not hold is absent.
 * O(targets): `pages.public_url_pages` reads them by id.
 */
async function resolveTargetUrls(
  pageIds: readonly string[],
  opts: PublicUrlContext & RenderScope,
): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map();
  const infra = hostInfra();
  const pages: PublicUrlPage[] = [];
  for (let at = 0; at < pageIds.length; at += TARGET_LOOKUP_BATCH) {
    // #1254 — joins a transaction the caller holds instead of taking a
    // second connection (an in-process build holds one).
    const r = await joinHeldTransaction(() =>
      execute(
        infra.registry,
        infra.adapter,
        {
          actorId: hostSystemActorId(),
          actorKind: "system",
          requestId: "head-composition-targets",
          ...(opts.chatBranchId ? { chatBranchId: opts.chatBranchId } : {}),
        },
        "pages.public_url_pages",
        { pageIds: pageIds.slice(at, at + TARGET_LOOKUP_BATCH) },
      ),
    );
    if (!r.ok) {
      throw new Error(
        `head-composition: the page lookup for alternates failed: ${"message" in r.error ? (r.error as { message: string }).message : r.error.kind}`,
      );
    }
    pages.push(...(r.value as { pages: PublicUrlPage[] }).pages);
  }
  return resolvePublicPageUrls(
    pages,
    { siteBaseUrl: opts.siteBaseUrl, pageUrlStyle: opts.pageUrlStyle },
    opts,
  );
}

// ---------------------------------------------------------------------------
// Serialization — ONE renderer for generator + preview.
// ---------------------------------------------------------------------------

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Serialize resolved head entries to the HTML block appended after the
 * core SEO head. Deterministic order (stable sort by identity key) so
 * generator and preview emit byte-identical output for the same
 * entries regardless of plugin iteration order.
 */
export function renderHeadEntries(entries: ReadonlyArray<ResolvedHeadEntry>): string {
  const sorted = [...entries].sort((a, b) => headEntryKey(a).localeCompare(headEntryKey(b)));
  return sorted
    .map((e) =>
      e.kind === "link"
        ? `<link rel="${escapeAttr(e.rel)}" hreflang="${escapeAttr(e.hreflang)}" href="${escapeAttr(e.href)}" />`
        : `<meta property="${escapeAttr(e.property)}" content="${escapeAttr(e.content)}" />`,
    )
    .join("\n");
}

/**
 * The ONE head-assembly join for generator + preview: core SEO head
 * block + contributed entries. Byte parity between the two surfaces is
 * by construction — both call this with the same inputs.
 */
export function composeHeadBlock(
  seoHeadBlock: string,
  entries: ReadonlyArray<ResolvedHeadEntry> | undefined,
): string {
  if (!entries || entries.length === 0) return seoHeadBlock;
  return `${seoHeadBlock}\n${renderHeadEntries(entries)}`;
}
