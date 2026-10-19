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
 * keep writing `/about`; the write path canonicalises it to a reference
 * (rollout C — until then nothing writes references), and every read
 * that shows content back (tool results, editor fields) turns references
 * into human paths again ({@link humaniseLinkRefs}). The grammar is a
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
import { trimSlashes } from "./url.js";

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

/**
 * `missingSlots` marker for a link value that starts like a reference
 * (`caelo:page/`, `caelo:media/`) but does not match the grammar — a
 * truncated or uppercased id, an id followed by stray characters
 * (`caelo:page/<id>/team`), an unknown media variant form. Reported as
 * `link-ref-malformed:<the text as written>` and left raw: a guessed
 * target would be a silent fallback (CLAUDE.md §2), and ignoring it
 * would ship a dead `caelo:` href. Only link positions count (a whole
 * value, an attribute value, a srcset entry); prose that mentions the
 * grammar is left alone.
 */
export const LINK_REF_MALFORMED = "link-ref-malformed";

// Pieces of the grammar. Every quantifier is bounded or runs over a
// character class that cannot overlap its neighbour, and every
// alternative starts with a literal, so scanning is linear (CodeQL
// js/polynomial-redos; the budget tests in link-refs.test.ts pin it).
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Query: URL query characters, `&amp;`-escaped ampersands included; no
// quote, space, angle bracket, `#` or comma (a comma ends a srcset entry).
const QUERY_SRC = "[A-Za-z0-9_\\-.~%=&;+/:@!$()*]{1,512}";
// Fragment: what an HTML id / URL fragment realistically carries.
const ANCHOR_SRC = "[A-Za-z0-9_\\-.~%:]{1,256}";
const VARIANT_SRC = "[a-z][a-z0-9-]{0,63}";
// `caelo:` is a scheme only where a scheme can start: `xcaelo:page/…`
// is some other scheme's text, not a reference.
const REF_START_SRC = "(?<![A-Za-z0-9+.\\-])caelo:";
// An id (or media variant) must END where the grammar says: a following
// id or path character (`<id>abc`, `<id>/team`, `/webp-800/x`) makes the
// whole thing malformed instead of resolving the prefix and gluing the
// rest onto the URL.
const ID_END_SRC = "(?![A-Za-z0-9_/\\-])";
// Fallback alternative: tried only where both grammar alternatives fail
// at the same position, and only in LINK positions — the start of the
// string (a whole field value), of an attribute value (after a quote or
// `=`) or of a srcset entry (after a comma). Prose that talks about the
// grammar (`<code>caelo:page/&lt;id&gt;</code>` in a docs page) is text,
// not a broken link. Captures a bounded snippet for the marker.
const MALFORMED_SRC = "(?<=^|[\"'=,]|, )caelo:(?:page|media)/[^\\s\"'<>,]{0,96}";

const PAGE_BODY_SRC = `page/(${UUID_SRC})${ID_END_SRC}(?:\\?(${QUERY_SRC}))?(?:#(${ANCHOR_SRC}))?`;
const MEDIA_BODY_SRC = `media/(${UUID_SRC})(?:/(${VARIANT_SRC}))?${ID_END_SRC}`;

/**
 * Global scanner for references embedded anywhere in a string. Groups:
 * 1-3 page (id, query, anchor), 4-5 media (id, variant); a match with
 * neither is malformed.
 */
function linkRefScanner(): RegExp {
  // A fresh RegExp per call: global regexes carry `lastIndex` state.
  // No alternative accepts a quote, so scanning an HTML attribute value
  // stops at its boundary.
  return new RegExp(`${REF_START_SRC}(?:${PAGE_BODY_SRC}|${MEDIA_BODY_SRC})|${MALFORMED_SRC}`, "g");
}

const PAGE_REF_EXACT = new RegExp(`^caelo:${PAGE_BODY_SRC}$`);
const MEDIA_REF_EXACT = new RegExp(`^caelo:${MEDIA_BODY_SRC}$`);

/** The reference a scanner match denotes, or null for a malformed one. */
function refFromMatch(m: ArrayLike<string | undefined>): LinkRef | null {
  if (m[1] !== undefined) {
    return { kind: "page", pageId: m[1], query: m[2] ?? null, anchor: m[3] ?? null };
  }
  if (m[4] !== undefined) return { kind: "media", mediaId: m[4], variant: m[5] ?? null };
  return null;
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

/**
 * Serialise a reference to its stored string form.
 *
 * @throws when the result would not parse back (an id that is not a
 *   lowercase UUID, a query / anchor / variant outside the grammar's
 *   character classes): storing it would write a link no render can
 *   resolve. Callers validate author input before building a ref.
 */
export function formatLinkRef(ref: LinkRef): string {
  const out =
    ref.kind === "media"
      ? `${LINK_REF_SCHEME}media/${ref.mediaId}${ref.variant ? `/${ref.variant}` : ""}`
      : `${LINK_REF_SCHEME}page/${ref.pageId}` +
        (ref.query ? `?${ref.query}` : "") +
        (ref.anchor ? `#${ref.anchor}` : "");
  if (parseLinkRef(out) === null) {
    throw new Error(
      `formatLinkRef: ${JSON.stringify(out)} is not a valid internal reference ` +
        "(ids are lowercase UUIDs; query, anchor and variant must use the grammar's characters, see link-refs.ts)",
    );
  }
  return out;
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

/**
 * Every well-formed reference embedded in `text`, in order (duplicates
 * kept). Malformed ones are not references; see
 * {@link findMalformedLinkRefs}.
 */
export function findLinkRefs(text: string): LinkRef[] {
  if (!mayContainLinkRef(text)) return [];
  const out: LinkRef[] = [];
  for (const m of text.matchAll(linkRefScanner())) {
    const ref = refFromMatch(m);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Every piece of `text` that starts like a reference (`caelo:page/`,
 * `caelo:media/`) but breaks the grammar, exactly as written (bounded
 * snippet), in order.
 */
export function findMalformedLinkRefs(text: string): string[] {
  if (!mayContainLinkRef(text)) return [];
  const out: string[] = [];
  for (const m of text.matchAll(linkRefScanner())) {
    if (refFromMatch(m) === null) out.push(m[0]);
  }
  return out;
}

/**
 * Replace every well-formed reference embedded in `text` with
 * `replacer`'s answer. `raw` is the reference exactly as it appeared, so
 * a replacer can leave it in place (return `raw`) — the loud-raw
 * convention for a target that cannot be resolved. Malformed references
 * are left untouched.
 */
export function replaceLinkRefs(
  text: string,
  replacer: (ref: LinkRef, raw: string) => string,
): string {
  if (!mayContainLinkRef(text)) return text;
  return text.replace(linkRefScanner(), (...args: unknown[]) => {
    const raw = args[0] as string;
    const ref = refFromMatch(args.slice(0, 6) as (string | undefined)[]);
    return ref ? replacer(ref, raw) : raw;
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

/**
 * True for every link failure marker: a missing target, a malformed
 * reference and a render without a resolver. The static generator's
 * render gate and the nested-module echo filter both key on this, so a
 * new marker added here blocks a deploy everywhere at once.
 */
export function isLinkFailureMarker(marker: string): boolean {
  return (
    marker.startsWith(`${LINK_TARGET_MISSING}:`) ||
    marker.startsWith(`${LINK_REF_MALFORMED}:`) ||
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
 * Text that starts like a reference but breaks the grammar stays raw
 * and pushes {@link LINK_REF_MALFORMED}, with or without a resolver.
 *
 * @param resolver undefined = the caller has no resolver; every
 *   reference then fails with {@link LINK_RESOLVER_UNAVAILABLE}.
 */
export function resolveLinkRefsInHtml(
  html: string,
  resolver: LinkResolver | undefined,
  missing: string[],
): string {
  for (const raw of findMalformedLinkRefs(html)) missing.push(`${LINK_REF_MALFORMED}:${raw}`);
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
  const trimmed = trimSlashes(path);
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
