// SPDX-License-Identifier: MPL-2.0

/**
 * Internal links as REFERENCES, not literal paths (epic #724).
 *
 * A link to one of the site's own pages or media assets is stored as a
 * plain-string reference and turned into a URL only when a page is
 * rendered — for the page being rendered, in the environment it is
 * rendered for. Renaming or moving a page then changes no stored link.
 *
 * Grammar (one form for every place a link can live — `link` / `url`
 * fields, `link-list` items, `*_href` values, module HTML attributes,
 * rich text, structured-set items, field defaults):
 *
 *   caelo:page/<pageId>[?query][#anchor]
 *   caelo:media/<mediaId>[/<variant>]
 *
 * `<pageId>` / `<mediaId>` are lowercase UUIDs. `query` and `anchor` are
 * carried verbatim (`?ref=nav`, `#pricing`). `variant` is a media
 * variant tag (`webp-800`, `square-400`); absent means the original.
 * Because a reference is a plain string, every surface carries it
 * without a schema change, and a reference inside HTML (`href="…"`,
 * `src="…"`, a `srcset` entry) is found by the same scanner as a whole
 * field value.
 *
 * Who sees the grammar: nobody who authors content. Humans and the AI
 * keep writing `/about`; the write path canonicalises to a reference
 * (admin-core `links/canonicalise.ts`), and every read that shows
 * content back (tool results, editor fields) turns references into
 * human paths again ({@link humaniseLinkRefs}). The grammar is a
 * storage form, not an authoring form (CLAUDE.md §1A).
 *
 * Resolution is ONE interface ({@link LinkResolver}) used by the
 * template engine, the composer, the editor preview, live-edit and the
 * static generator. A reference whose target does not exist is a loud
 * failure (`link-target-missing:<kind>/<id>` in `missingSlots`, the raw
 * reference left in the output — CLAUDE.md §2); one whose target exists
 * but is not published in the environment being rendered resolves to
 * its URL and is reported as `unpublished` so the caller can apply the
 * environment's policy (warn at Stage, block at Publish live — the
 * blocking check is rollout F).
 *
 * Seams for the later rollout steps:
 *   - D (locale composition point): {@link SiteLinkIndex.forPage} is the
 *     per-rendering-page hook. A `link-resolve` contribution maps the
 *     target to the rendering page's same-locale sibling there; nothing
 *     in the engine or composer changes.
 *   - E (data migration): {@link mapLinkRefsDeep} / the canonicaliser's
 *     pure core walk the same shapes the migration rewrites.
 *   - F (reference integrity): {@link RecordingLinkResolver.observed}
 *     lists every reference a render touched with its resolution, and
 *     {@link linkIssueSeverity} is the per-environment policy.
 */

import { buildMediaUrl } from "./media.js";
import type { PageUrlStyle } from "./seo.js";

/** The scheme every internal reference starts with. */
export const LINK_REF_SCHEME = "caelo:";

/** A reference to one of the site's pages. */
export interface PageLinkRef {
  readonly kind: "page";
  readonly pageId: string;
  /** Query string WITHOUT the leading `?`, or null. */
  readonly query: string | null;
  /** Fragment WITHOUT the leading `#`, or null. */
  readonly anchor: string | null;
}

/** A reference to one of the site's media assets. */
export interface MediaLinkRef {
  readonly kind: "media";
  readonly mediaId: string;
  /** Variant tag (`webp-800`), or null for the original. */
  readonly variant: string | null;
}

/** Any internal reference. */
export type LinkRef = PageLinkRef | MediaLinkRef;

// Pieces of the grammar. Every quantifier is bounded or runs over a
// character class that cannot overlap its neighbour, so scanning is
// linear (CodeQL js/polynomial-redos).
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Query: URL query characters, `&amp;`-escaped ampersands included; no
// quote, space, angle bracket, `#` or comma (a comma ends a srcset entry).
const QUERY_SRC = "[A-Za-z0-9_\\-.~%=&;+/:@!$()*]{1,512}";
// Fragment: what an HTML id / URL fragment realistically carries.
const ANCHOR_SRC = "[A-Za-z0-9_\\-.~%:]{1,256}";
const VARIANT_SRC = "[a-z][a-z0-9-]{0,63}";

const PAGE_REF_SRC = `caelo:page/(${UUID_SRC})(?:\\?(${QUERY_SRC}))?(?:#(${ANCHOR_SRC}))?`;
const MEDIA_REF_SRC = `caelo:media/(${UUID_SRC})(?:/(${VARIANT_SRC}))?`;

/** Global scanner for references embedded anywhere in a string. */
function linkRefScanner(): RegExp {
  // A fresh RegExp per call: global regexes carry `lastIndex` state.
  // Neither alternative accepts a quote, so scanning an HTML attribute
  // value stops at its boundary.
  return new RegExp(`${PAGE_REF_SRC}|${MEDIA_REF_SRC}`, "g");
}

const PAGE_REF_EXACT = new RegExp(`^${PAGE_REF_SRC}$`);
const MEDIA_REF_EXACT = new RegExp(`^${MEDIA_REF_SRC}$`);

function refFromMatch(m: RegExpExecArray | RegExpMatchArray): LinkRef {
  if (m[1] !== undefined) {
    return { kind: "page", pageId: m[1], query: m[2] ?? null, anchor: m[3] ?? null };
  }
  return { kind: "media", mediaId: m[4] as string, variant: m[5] ?? null };
}

/**
 * Parse a string that IS exactly one reference (a whole field value).
 * Returns null for anything else — a path, an external URL, or a string
 * that merely contains a reference.
 */
export function parseLinkRef(value: string): LinkRef | null {
  if (!value.startsWith(LINK_REF_SCHEME)) return null;
  const page = PAGE_REF_EXACT.exec(value);
  if (page) {
    return {
      kind: "page",
      pageId: page[1] as string,
      query: page[2] ?? null,
      anchor: page[3] ?? null,
    };
  }
  const media = MEDIA_REF_EXACT.exec(value);
  if (media) return { kind: "media", mediaId: media[1] as string, variant: media[2] ?? null };
  return null;
}

/** Serialise a reference to its stored string form. */
export function formatLinkRef(ref: LinkRef): string {
  if (ref.kind === "media") {
    return `${LINK_REF_SCHEME}media/${ref.mediaId}${ref.variant ? `/${ref.variant}` : ""}`;
  }
  return (
    `${LINK_REF_SCHEME}page/${ref.pageId}` +
    (ref.query ? `?${ref.query}` : "") +
    (ref.anchor ? `#${ref.anchor}` : "")
  );
}

/**
 * The target-identity half of a reference, `page/<id>` / `media/<id>` —
 * what failure markers and integrity reports name (query, anchor and
 * variant do not change whether the target exists).
 */
export function linkRefTargetKey(ref: LinkRef): string {
  return ref.kind === "page" ? `page/${ref.pageId}` : `media/${ref.mediaId}`;
}

/** Cheap pre-check: can `text` contain a reference at all? */
export function mayContainLinkRef(text: string): boolean {
  return text.includes(LINK_REF_SCHEME);
}

/** Every reference embedded in `text`, in order (duplicates kept). */
export function findLinkRefs(text: string): LinkRef[] {
  if (!mayContainLinkRef(text)) return [];
  const out: LinkRef[] = [];
  for (const m of text.matchAll(linkRefScanner())) out.push(refFromMatch(m));
  return out;
}

/**
 * Replace every reference embedded in `text` with `replacer`'s answer.
 * `raw` is the reference exactly as it appeared, so a replacer can leave
 * it in place (return `raw`) — the loud-raw convention for a target that
 * cannot be resolved.
 */
export function replaceLinkRefs(
  text: string,
  replacer: (ref: LinkRef, raw: string) => string,
): string {
  if (!mayContainLinkRef(text)) return text;
  return text.replace(linkRefScanner(), (...args: unknown[]) => {
    const raw = args[0] as string;
    const groups = args.slice(0, 6) as unknown as RegExpMatchArray;
    return replacer(refFromMatch(groups), raw);
  });
}

/**
 * Walk a JSON value (content values, field defaults, set items) and map
 * every string through {@link replaceLinkRefs}. Returns the SAME
 * reference when nothing changed, so callers can cheaply detect no-ops.
 */
export function mapLinkRefsDeep(
  value: unknown,
  replacer: (ref: LinkRef, raw: string) => string,
): unknown {
  if (typeof value === "string") return replaceLinkRefs(value, replacer);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = mapLinkRefsDeep(v, replacer);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = mapLinkRefsDeep(v, replacer);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

/** Every reference anywhere inside a JSON value. */
export function collectLinkRefsDeep(value: unknown): LinkRef[] {
  const out: LinkRef[] = [];
  mapLinkRefsDeep(value, (ref, raw) => {
    out.push(ref);
    return raw;
  });
  return out;
}

// ─── Resolution ──────────────────────────────────────────────────────

/**
 * Where a render goes. `preview` is the editor (draft state: every live
 * page counts as available); `staging` / `production` are deploy builds,
 * which ship published pages only.
 */
export type LinkRenderEnv = "preview" | "staging" | "production";

/** The outcome of resolving one reference. */
export type LinkResolution =
  /** The target exists and is served in this environment. */
  | { readonly status: "resolved"; readonly url: string }
  /**
   * The target exists but is not published, so a deploy build will not
   * contain it. Rendered with its URL; the caller applies the
   * environment's policy ({@link linkIssueSeverity}).
   */
  | { readonly status: "unpublished"; readonly url: string }
  /** No live target (never existed, deleted, another chat's branch). */
  | { readonly status: "missing" };

/**
 * Turns references into URLs for ONE rendering page. Synchronous: the
 * template engine is a pure, sync function, so callers batch-load what
 * the resolver needs ({@link createSiteLinkIndex}) before rendering.
 */
export interface LinkResolver {
  resolve(ref: LinkRef): LinkResolution;
}

/** One reference a render touched and what it resolved to. */
export interface ObservedLinkResolution {
  readonly ref: LinkRef;
  readonly resolution: LinkResolution;
}

/** A resolver that remembers every resolution it handed out. */
export interface RecordingLinkResolver extends LinkResolver {
  /** Every resolution so far, in call order (duplicates kept). */
  readonly observed: readonly ObservedLinkResolution[];
}

/**
 * `missingSlots` marker for a reference whose target does not exist:
 * `link-target-missing:page/<id>` / `link-target-missing:media/<id>`.
 * The editor's missing-content surface and the static generator's
 * render gate read these literal strings.
 */
export const LINK_TARGET_MISSING = "link-target-missing";

/**
 * `missingSlots` marker for a reference rendered by a caller that gave
 * the engine no resolver — never legitimate output; a deploy refuses it.
 */
export const LINK_RESOLVER_UNAVAILABLE = "link-resolver-unavailable";

/** True for the two link failure markers above. */
export function isLinkFailureMarker(marker: string): boolean {
  return (
    marker.startsWith(`${LINK_TARGET_MISSING}:`) ||
    marker.startsWith(`${LINK_RESOLVER_UNAVAILABLE}:`)
  );
}

/** The link failure markers among `markers`, in order. */
export function linkMarkersOf(markers: readonly string[]): string[] {
  return markers.filter(isLinkFailureMarker);
}

/**
 * Resolve every reference embedded in rendered HTML. Unresolvable
 * references stay in the output verbatim (loud-raw, CLAUDE.md §2) and
 * push a marker onto `missing`; `unpublished` ones render their URL and
 * push nothing — that is a per-environment policy, not a render failure.
 *
 * @param resolver undefined = the caller has no resolver; every
 *   reference then fails with {@link LINK_RESOLVER_UNAVAILABLE}.
 */
export function resolveLinkRefsInHtml(
  html: string,
  resolver: LinkResolver | undefined,
  missing: string[],
): string {
  return replaceLinkRefs(html, (ref, raw) => {
    if (!resolver) {
      missing.push(`${LINK_RESOLVER_UNAVAILABLE}:${linkRefTargetKey(ref)}`);
      return raw;
    }
    const r = resolver.resolve(ref);
    if (r.status === "missing") {
      missing.push(`${LINK_TARGET_MISSING}:${linkRefTargetKey(ref)}`);
      return raw;
    }
    return r.url;
  });
}

/**
 * The per-environment policy for a reference that did not resolve
 * cleanly (maintainer decision on #724): a missing target blocks
 * everywhere; an unpublished one is a warning at Stage and blocks
 * Publish live / promote. The editor preview shows drafts, so nothing
 * there is an issue beyond a missing target.
 */
export function linkIssueSeverity(
  env: LinkRenderEnv,
  status: LinkResolution["status"],
): "block" | "warning" | null {
  if (status === "missing") return "block";
  if (status === "unpublished") {
    if (env === "production") return "block";
    if (env === "staging") return "warning";
  }
  return null;
}

/** A page as the link index needs it. */
export interface LinkIndexPage {
  readonly id: string;
  /**
   * The page's composed public path (`pages.current_path`, or the
   * branch view's dry-run path in a chat preview): leading slash, "/"
   * for the root.
   */
  readonly path: string;
  readonly status: "draft" | "published";
}

/** A media asset as the link index needs it. */
export interface LinkIndexMedia {
  readonly id: string;
  /** `media_assets.slug` — the URL the editor serves and the build rewrites. */
  readonly slug: string;
}

/** What a render-wide link index is built from. */
export interface SiteLinkIndexInput {
  /** Every live (non-deleted) page visible to the render's scope, drafts included. */
  readonly pages: ReadonlyArray<LinkIndexPage>;
  /** Every live (non-deleted) media asset. */
  readonly media: ReadonlyArray<LinkIndexMedia>;
  readonly env: LinkRenderEnv;
  /**
   * The serving target's page emission style, so a link carries exactly
   * the URL the target serves (`/about/` vs `/about`) — no 301 hop per
   * internal link, and byte-identical with the canonical (#590).
   */
  readonly pageUrlStyle: PageUrlStyle;
}

/**
 * The render-wide lookup tables, from which a per-page resolver is cut.
 * Built once per preview / per build.
 */
export interface SiteLinkIndex {
  readonly env: LinkRenderEnv;
  /**
   * The resolver for rendering page `renderingPageId`. Today every page
   * gets the same answers; rollout D's `link-resolve` composition point
   * hooks in here to map a target onto the rendering page's locale.
   * Each call returns a fresh {@link RecordingLinkResolver}.
   */
  forPage(renderingPageId: string | null): RecordingLinkResolver;
  /** The page's public path (no style applied), or null when unknown. */
  pathOf(pageId: string): string | null;
}

/**
 * The URL path a page is served at under `style`: `/` for the root,
 * `/a/b/` (directory) or `/a/b` (no-extension) otherwise. Same shape as
 * the path half of `resolveCanonicalUrl`.
 */
export function pageHrefForStyle(path: string, style: PageUrlStyle): string {
  let start = 0;
  let end = path.length;
  while (start < end && path.charCodeAt(start) === 47) start += 1;
  while (end > start && path.charCodeAt(end - 1) === 47) end -= 1;
  const trimmed = path.slice(start, end);
  if (trimmed.length === 0) return "/";
  return style === "no-extension" ? `/${trimmed}` : `/${trimmed}/`;
}

/** Build the URL a resolved page reference renders as. */
function pageRefUrl(ref: PageLinkRef, path: string, style: PageUrlStyle): string {
  return (
    pageHrefForStyle(path, style) +
    (ref.query ? `?${ref.query}` : "") +
    (ref.anchor ? `#${ref.anchor}` : "")
  );
}

/**
 * Build the render-wide link index. Media references resolve to the
 * editor-served media URL (`/_caelo/media/<slug>[/<variant>]`) — the
 * same URL a literal embed carries — so the preview's responsive-image
 * enrichment and the static generator's media pass (content-hashed
 * `/_assets/…`, srcset ladders) apply to them unchanged (#162 parity).
 */
export function createSiteLinkIndex(input: SiteLinkIndexInput): SiteLinkIndex {
  const pages = new Map(input.pages.map((p) => [p.id, p]));
  const media = new Map(input.media.map((m) => [m.id, m]));
  const resolve = (ref: LinkRef): LinkResolution => {
    if (ref.kind === "media") {
      const asset = media.get(ref.mediaId);
      if (!asset) return { status: "missing" };
      return { status: "resolved", url: buildMediaUrl(asset.slug, ref.variant ?? "orig") };
    }
    const page = pages.get(ref.pageId);
    if (!page) return { status: "missing" };
    const url = pageRefUrl(ref, page.path, input.pageUrlStyle);
    if (input.env !== "preview" && page.status !== "published") {
      return { status: "unpublished", url };
    }
    return { status: "resolved", url };
  };
  return {
    env: input.env,
    pathOf: (pageId) => pages.get(pageId)?.path ?? null,
    forPage: () => {
      const observed: ObservedLinkResolution[] = [];
      return {
        observed,
        resolve(ref) {
          const resolution = resolve(ref);
          observed.push({ ref, resolution });
          return resolution;
        },
      };
    },
  };
}

// ─── Humanising (reads) ──────────────────────────────────────────────

/** What a read surface knows about reference targets. */
export interface LinkHumaniseLookup {
  /** The page's public path (`/about`), or null when it does not exist. */
  pagePath(pageId: string): string | null;
  /** The media asset's slug, or null when it does not exist. */
  mediaSlug(mediaId: string): string | null;
}

/**
 * Turn stored references back into what an author writes: `/about`,
 * `/about#team`, `/_caelo/media/hero`. Applied to every read that shows
 * content to the AI or the operator, so neither ever has to learn the
 * grammar (CLAUDE.md §1A); writing the humanised form back
 * canonicalises to the same reference.
 *
 * A reference whose target is gone stays raw — it is broken, and a
 * plausible-looking path would hide that.
 */
export function humaniseLinkRefs<T>(value: T, lookup: LinkHumaniseLookup): T {
  return mapLinkRefsDeep(value, (ref, raw) => {
    if (ref.kind === "media") {
      const slug = lookup.mediaSlug(ref.mediaId);
      if (slug === null) return raw;
      return buildMediaUrl(slug, ref.variant ?? "orig");
    }
    const path = lookup.pagePath(ref.pageId);
    if (path === null) return raw;
    return `${path}${ref.query ? `?${ref.query}` : ""}${ref.anchor ? `#${ref.anchor}` : ""}`;
  }) as T;
}
