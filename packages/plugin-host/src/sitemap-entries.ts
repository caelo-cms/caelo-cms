// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/sitemap-entries — the sitemap-entries composition
 * point (#1761, epic #1751): which pages are news articles and which show
 * videos, for the news and video sitemaps core writes next to
 * `sitemap.xml`.
 *
 * A plugin declares `sitemapEntriesOperation` (capability
 * `sitemap_entries`; `$sitemapEntries` for an installed plugin) and answers
 * per page with typed entries (plugin SDK `sitemap-entries.ts`). The host
 * checks every entry, refuses what is outside the vocabulary as a
 * `plugin-value-refused` render failure, and hands core the entries; core
 * writes the files from the entries of the pages it lists in `sitemap.xml`.
 * The point is asked with the same page records as the structured-data
 * point, in the same page batches of a build.
 *
 * One plugin model (#1729): a shipped plugin's answer is chunked, capped and
 * checked like a sandboxed one's.
 */

import {
  SITEMAP_ANSWER_MAX_BYTES,
  SITEMAP_DESCRIPTION_MAX,
  SITEMAP_TITLE_MAX,
  SITEMAP_VIDEOS_PER_PAGE,
} from "@caelo-cms/plugin-sdk";
import {
  PLUGIN_SITEMAP_ENTRIES_POINT,
  pluginValueRefusedMarker,
  RECORD_TOO_LARGE_RULE,
} from "@caelo-cms/shared";
import { compositionCalls } from "./composition-calls.js";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { checkPluginMedia, describePluginMedia } from "./plugin-values.js";
import type { PublicUrlContext } from "./public-urls.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import type { StructuredDataInput } from "./structured-data.js";

/** One video entry core writes; `thumbnail` is the library image's id. */
export interface ResolvedVideoEntry {
  readonly title: string;
  readonly description: string;
  readonly thumbnail: string;
  readonly contentUrl?: string;
  readonly playerUrl?: string;
  readonly durationSeconds?: number;
}

/** Every plugin's sitemap entries for the pages asked about. */
export interface CollectedSitemapEntries {
  readonly news: Map<string, { readonly title: string }>;
  readonly videos: Map<string, ResolvedVideoEntry[]>;
  /** pageId → the `plugin-value-refused` markers of what core refused. */
  readonly refused: Map<string, string[]>;
}

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.sitemapEntriesOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Whether any running plugin adds sitemap entries. */
export function hasSitemapEntriesContributors(): boolean {
  return contributors().length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKUP_RE = /<[A-Za-z/!?]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rule a title or description breaks, or null. */
function textRule(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return "text-missing";
  if (value.length > max) return "text-too-long";
  return MARKUP_RE.test(value) ? "text-markup" : null;
}

/** An address on another site: `{url}` with http(s), no credentials, not one of `ownHosts`. */
function urlOf(raw: unknown, ownHosts: ReadonlySet<string>): { url: string } | { rule: string } {
  if (!isRecord(raw) || Object.keys(raw).length !== 1 || typeof raw.url !== "string") {
    return { rule: "url-shape" };
  }
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return { rule: "url-invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { rule: "url-scheme" };
  if (url.username !== "" || url.password !== "") return { rule: "url-credentials" };
  if (ownHosts.has(url.host)) return { rule: "url-own-site" };
  return { url: url.href };
}

/** A video entry checked, its thumbnail still a media id to check against the library. */
function checkVideo(
  raw: unknown,
  ownHosts: ReadonlySet<string>,
): ResolvedVideoEntry | { rule: string; field: string } {
  if (!isRecord(raw)) return { rule: "video-shape", field: "video" };
  const allowed = [
    "title",
    "description",
    "thumbnail",
    "contentUrl",
    "playerUrl",
    "durationSeconds",
  ];
  if (Object.keys(raw).some((k) => !allowed.includes(k)))
    return { rule: "video-shape", field: "video" };
  const title = textRule(raw.title, SITEMAP_TITLE_MAX);
  if (title) return { rule: title, field: "title" };
  const description = textRule(raw.description, SITEMAP_DESCRIPTION_MAX);
  if (description) return { rule: description, field: "description" };
  const thumbnail = raw.thumbnail;
  if (
    !isRecord(thumbnail) ||
    typeof thumbnail.media !== "string" ||
    !UUID_RE.test(thumbnail.media)
  ) {
    return { rule: "media-id-invalid", field: "thumbnail" };
  }
  const out: { -readonly [K in keyof ResolvedVideoEntry]: ResolvedVideoEntry[K] } = {
    title: raw.title as string,
    description: raw.description as string,
    thumbnail: thumbnail.media.toLowerCase(),
  };
  for (const key of ["contentUrl", "playerUrl"] as const) {
    if (raw[key] === undefined) continue;
    const u = urlOf(raw[key], ownHosts);
    if ("rule" in u) return { rule: u.rule, field: key };
    out[key] = u.url;
  }
  if (out.contentUrl === undefined && out.playerUrl === undefined) {
    return { rule: "video-location-missing", field: "video" };
  }
  if (raw.durationSeconds !== undefined) {
    const d = raw.durationSeconds;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 28_800) {
      return { rule: "duration-range", field: "durationSeconds" };
    }
    out.durationSeconds = d;
  }
  return out;
}

/**
 * Collect + check every plugin's sitemap entries for the given pages (the
 * structured-data point's records). Loud: a failing call throws in a build
 * and is flagged in a preview (#1087).
 */
export async function collectSitemapEntries(
  input: StructuredDataInput,
  opts: PublicUrlContext & RenderScope,
): Promise<CollectedSitemapEntries> {
  const out: CollectedSitemapEntries = { news: new Map(), videos: new Map(), refused: new Map() };
  if (input.pages.length === 0) return out;
  const plugins = contributors();
  if (plugins.length === 0) return out;
  const ownHosts = new Set([new URL(opts.siteBaseUrl).host]);
  const refuse = (slug: string, pageId: string, field: string, rule: string) => {
    const marker = pluginValueRefusedMarker(slug, PLUGIN_SITEMAP_ENTRIES_POINT, field, rule);
    const list = out.refused.get(pageId) ?? [];
    if (!list.includes(marker)) list.push(marker);
    out.refused.set(pageId, list);
  };
  const thumbnails: { slug: string; pageId: string; video: ResolvedVideoEntry }[] = [];

  // The structured-data point's calls: the same records, the same budget.
  const { calls, oversized } = compositionCalls(input);
  for (const lp of plugins) {
    const operationName = lp.definition.sitemapEntriesOperation as string;
    const label = `sitemap-entries: ${lp.slug}.${operationName}`;
    for (const page of oversized) refuse(lp.slug, page.pageId, "page", RECORD_TOO_LARGE_RULE);
    for (const call of calls) {
      const asked = new Set(call.pages.map((p) => p.pageId));
      const r = await runPluginOperation({
        invocation: renderInvocation(opts),
        pluginSlug: lp.slug,
        operationName,
        args: call.args,
        maxAnswerBytes: SITEMAP_ANSWER_MAX_BYTES,
      });
      const tooLarge = r.ok
        ? Buffer.byteLength(JSON.stringify(r.value ?? null)) > SITEMAP_ANSWER_MAX_BYTES
        : r.error.message.includes("SandboxAnswerTooLarge");
      if (tooLarge) {
        for (const pageId of asked) refuse(lp.slug, pageId, "answer", "answer-too-large");
        continue;
      }
      if (!r.ok) {
        const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
        if (
          reportPluginRenderFailure(opts, {
            slug: lp.slug,
            point: PLUGIN_SITEMAP_ENTRIES_POINT,
            reason,
          })
        ) {
          break;
        }
        throw new Error(reason);
      }
      const answer = r.value;
      if (
        !isRecord(answer) ||
        Object.keys(answer).some((k) => k !== "pages") ||
        !isRecord(answer.pages)
      ) {
        for (const pageId of asked) refuse(lp.slug, pageId, "answer", "answer-shape");
        continue;
      }
      const pages = Object.entries(answer.pages);
      if (pages.some(([pageId]) => !asked.has(pageId))) {
        for (const pageId of asked) refuse(lp.slug, pageId, "answer", "page-not-asked");
        continue;
      }
      for (const [pageId, entry] of pages) {
        if (!isRecord(entry) || Object.keys(entry).some((k) => k !== "news" && k !== "videos")) {
          refuse(lp.slug, pageId, "page", "page-shape");
          continue;
        }
        if (entry.news !== undefined) {
          const news = entry.news;
          const rule =
            !isRecord(news) || Object.keys(news).some((k) => k !== "title")
              ? "news-shape"
              : textRule(news.title, SITEMAP_TITLE_MAX);
          const existing = out.news.get(pageId);
          if (rule) refuse(lp.slug, pageId, "news", rule);
          // A news sitemap names the publication: the site's name.
          else if (input.site.name === null) refuse(lp.slug, pageId, "news", "site-name-unset");
          else if (existing && existing.title !== (news as { title: string }).title) {
            refuse(lp.slug, pageId, "news", "news-conflict");
          } else out.news.set(pageId, { title: (news as { title: string }).title });
        }
        if (entry.videos !== undefined) {
          if (!Array.isArray(entry.videos) || entry.videos.length > SITEMAP_VIDEOS_PER_PAGE) {
            refuse(
              lp.slug,
              pageId,
              "videos",
              Array.isArray(entry.videos) ? "videos-over-limit" : "videos-shape",
            );
            continue;
          }
          for (const raw of entry.videos) {
            const v = checkVideo(raw, ownHosts);
            if ("rule" in v) refuse(lp.slug, pageId, v.field, v.rule);
            else thumbnails.push({ slug: lp.slug, pageId, video: v });
          }
        }
      }
    }
  }

  // Media is not branched: a preview and a build see the same facts.
  const facts = await describePluginMedia([...new Set(thumbnails.map((t) => t.video.thumbnail))]);
  for (const { slug, pageId, video } of thumbnails) {
    const rule = checkPluginMedia(`caelo:media/${video.thumbnail}`, facts);
    if (rule) {
      refuse(slug, pageId, "thumbnail", rule);
      continue;
    }
    const list = out.videos.get(pageId) ?? [];
    if (list.length >= SITEMAP_VIDEOS_PER_PAGE) {
      refuse(slug, pageId, "videos", "videos-over-limit");
      continue;
    }
    list.push(video);
    out.videos.set(pageId, list);
  }
  return out;
}
