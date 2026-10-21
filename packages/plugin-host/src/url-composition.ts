// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/url-composition — the URL composition point
 * (#390, epic #380 decisions 1 + 4).
 *
 * Core owns a FIXED grammar:
 *
 *   scheme+host · path-prefix · ancestor slugs · slug (filtered by slug-format)
 *
 * The ancestor slugs are the page's parent chain (nested page URLs,
 * migration 0263) — core data, never a plugin's; the slug-format
 * contribution shapes only the page's own segment.
 *
 * plus `full-path`, an escape slot exclusive with all others. Plugins
 * claim slots with pure encode/decode contributions; composition order
 * comes from the grammar, never from registration order. Slots are
 * exclusive — the second claimant fails AT ACTIVATION with an error
 * naming the holder, never silently at runtime.
 *
 * Purity boundary: encode/decode never perform I/O. The per-page data
 * they need (a page's locale, its variant group, …) is collected
 * beforehand through the contributing plugin's `urlAnnotationsOperation`
 * (`collectUrlAnnotations`) and handed in as `page.annotations`.
 *
 * The composed result is MATERIALIZED into `pages.current_path` by the
 * write ops — render-time consumers (generator, canonical, sitemap,
 * staging preview) read the column; request-time inversion
 * (preview-by-path) is an index lookup on it. That materialization is
 * what makes URL-shape changes diffable after the causing plugin is
 * gone (decision 4): the diff engine compares stored paths against a
 * fresh resolution and routes the change through a §11.A proposal.
 */

import type { UrlComposePage, UrlContributionDef, UrlSlot } from "@caelo-cms/plugin-sdk";
import { trimSlashes } from "@caelo-cms/shared";
import {
  isPluginDisabled,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";

/**
 * Which plugins' URL contributions take part in a composition. `without`
 * composes as if that plugin were already gone: the gated uninstall
 * (#393) diffs the post-uninstall URLs inside its transaction, while the
 * plugin leaves the running host only after that transaction commits
 * (#585). Omitted = every active contribution, the normal case.
 */
export interface UrlCompositionView {
  readonly without?: string;
}

export interface RegisteredUrlContribution {
  readonly pluginSlug: string;
  readonly contribution: UrlContributionDef;
}

class UrlContributionsRegistry {
  readonly #bySlot = new Map<UrlSlot, RegisteredUrlContribution>();
  readonly #annotationOps = new Map<string, string>();

  /**
   * Claim slots for a plugin. Throws on conflict (exclusive slots; the
   * `full-path` slot additionally excludes every other slot) — the
   * loader turns the throw into a failed activation.
   */
  register(
    pluginSlug: string,
    contributions: ReadonlyArray<UrlContributionDef>,
    annotationsOperation?: string,
  ): void {
    this.assertClaimable(pluginSlug, contributions);
    for (const c of contributions) this.#bySlot.set(c.slot, { pluginSlug, contribution: c });
    if (annotationsOperation) {
      this.#annotationOps.set(pluginSlug, annotationsOperation);
    }
  }

  /**
   * Throw when `register` would conflict, without claiming anything. The
   * loader checks this BEFORE provisioning a plugin and registers only once
   * the plugin is loaded: a claim made earlier would let a concurrent
   * render call the plugin's annotation op before the plugin can run it
   * (PluginNotFound mid-activation).
   */
  assertClaimable(pluginSlug: string, contributions: ReadonlyArray<UrlContributionDef>): void {
    const claimed = new Map(this.#bySlot);
    for (const c of contributions) {
      const existing = claimed.get(c.slot);
      if (existing && existing.pluginSlug !== pluginSlug) {
        throw new Error(
          `URL slot "${c.slot}" is already claimed by plugin "${existing.pluginSlug}" — conflicts with "${pluginSlug}". Slots are exclusive; deactivate one of the plugins.`,
        );
      }
      const active = [...claimed.entries()]
        .filter(([, e]) => !isPluginDisabled(e.pluginSlug))
        .map(([slot]) => slot);
      if (c.slot === "full-path" && active.some((s) => s !== "full-path")) {
        throw new Error(
          `URL slot "full-path" is exclusive with every other slot, but ${active.join(", ")} are claimed.`,
        );
      }
      if (c.slot !== "full-path" && claimed.has("full-path")) {
        const holder = claimed.get("full-path");
        throw new Error(
          `URL slot "${c.slot}" cannot be claimed while "${holder?.pluginSlug}" holds "full-path" (exclusive).`,
        );
      }
      claimed.set(c.slot, { pluginSlug, contribution: c });
    }
  }

  unregisterPlugin(pluginSlug: string): void {
    for (const [slot, entry] of this.#bySlot) {
      if (entry.pluginSlug === pluginSlug) this.#bySlot.delete(slot);
    }
    this.#annotationOps.delete(pluginSlug);
  }

  /** Active (non-disabled) contribution for a slot, within `view`. */
  bySlot(slot: UrlSlot, view?: UrlCompositionView): RegisteredUrlContribution | null {
    const entry = this.#bySlot.get(slot);
    if (!entry) return null;
    if (isPluginDisabled(entry.pluginSlug)) return null;
    if (view?.without === entry.pluginSlug) return null;
    return entry;
  }

  activeSlots(): UrlSlot[] {
    return [...this.#bySlot.keys()].filter((s) => this.bySlot(s) !== null);
  }

  annotationOps(): ReadonlyMap<string, string> {
    return this.#annotationOps;
  }

  reset(): void {
    this.#bySlot.clear();
    this.#annotationOps.clear();
  }
}

export const urlContributionsRegistry = new UrlContributionsRegistry();

// ---------------------------------------------------------------------------
// Pure composition.
// ---------------------------------------------------------------------------

const PATH_SEGMENT_RE = /^[a-z0-9][a-z0-9._~-]*$/i;
const HOST_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

function assertSegment(seg: string, source: string): void {
  if (!PATH_SEGMENT_RE.test(seg) || seg.includes("/") || seg === "." || seg === "..") {
    throw new Error(
      `url-composition: contribution "${source}" produced an invalid path segment "${seg}"`,
    );
  }
}

export interface ResolvedPageUrl {
  /** Leading-slash path, no trailing slash except the bare root "/". */
  readonly path: string;
  /** Host override from the `host` slot, or null for the site default. */
  readonly host: string | null;
}

/**
 * The `host` slot alone: the page's host override, or null for the site
 * default. Pure — annotations must already be attached to `page`. The
 * path is materialized in `pages.current_path`; the host is not, so the
 * public URL builder asks for it at render time ({@link resolvePageUrl}
 * uses the same function, so both always agree).
 */
export function resolvePageHost(page: UrlComposePage, view?: UrlCompositionView): string | null {
  const host = urlContributionsRegistry.bySlot("host", view);
  if (host && host.contribution.slot === "host") {
    const encoded = host.contribution.encode(page);
    if (encoded !== null && !HOST_RE.test(encoded)) {
      throw new Error(
        `url-composition: host contribution "${host.pluginSlug}" produced an invalid host "${encoded}"`,
      );
    }
    return encoded;
  }
  return null;
}

/** True when an active plugin claims the `host` slot — callers skip the
 *  annotation round-trip entirely on the common single-host site. */
export function hasHostContribution(): boolean {
  return urlContributionsRegistry.bySlot("host") !== null;
}

/**
 * Compose a page's public URL from the active contributions. Pure —
 * annotations must already be attached to `page`.
 */
export function resolvePageUrl(page: UrlComposePage, view?: UrlCompositionView): ResolvedPageUrl {
  const full = urlContributionsRegistry.bySlot("full-path", view);
  // The host slot never sees the tree (SDK contract): render-time host
  // resolution only has the materialized path, so both must agree.
  const hostValue = resolvePageHost({ ...page, ancestorSlugs: [] }, view);

  if (full && full.contribution.slot === "full-path") {
    const path = full.contribution.encode(page);
    if (!path.startsWith("/")) {
      throw new Error(
        `url-composition: full-path contribution "${full.pluginSlug}" must return a leading-slash path (got "${path}")`,
      );
    }
    if (path !== "/") {
      if (path.endsWith("/")) {
        throw new Error(
          `url-composition: full-path contribution "${full.pluginSlug}" must not end with a trailing slash (got "${path}")`,
        );
      }
      for (const seg of path.slice(1).split("/")) {
        assertSegment(seg, `${full.pluginSlug}/full-path`);
      }
    }
    return { path, host: hostValue };
  }

  const prefixEntry = urlContributionsRegistry.bySlot("path-prefix", view);
  const prefixSegments: string[] = [];
  if (prefixEntry && prefixEntry.contribution.slot === "path-prefix") {
    for (const seg of prefixEntry.contribution.encode(page)) {
      assertSegment(seg, `${prefixEntry.pluginSlug}/path-prefix`);
      prefixSegments.push(seg);
    }
  }

  if (page.isHomePage) {
    // The designated root serves at the prefix root ("/" bare, "/de/"→"/de").
    return {
      path: prefixSegments.length === 0 ? "/" : `/${prefixSegments.join("/")}`,
      host: hostValue,
    };
  }

  for (const seg of page.ancestorSlugs) assertSegment(seg, "core/parent-page");

  let slugPart = page.slug;
  const slugFmt = urlContributionsRegistry.bySlot("slug-format", view);
  if (slugFmt && slugFmt.contribution.slot === "slug-format") {
    slugPart = slugFmt.contribution.encode(page);
  }
  // The own slug is exactly ONE segment: nesting belongs to the parent
  // chain, so decode can split "ancestors / leaf" unambiguously. A
  // slug-format contribution that expands it into several segments is
  // refused rather than silently re-read as ancestors.
  if (slugPart.length === 0) {
    throw new Error(
      `url-composition: page ${page.pageId} composed an empty slug part from slug "${page.slug}"`,
    );
  }
  assertSegment(slugPart, slugFmt ? `${slugFmt.pluginSlug}/slug-format` : "core/slug");

  return {
    path: `/${[...prefixSegments, ...page.ancestorSlugs, slugPart].join("/")}`,
    host: hostValue,
  };
}

export interface DecodedPagePath {
  /** The page's own stored slug (the last path segment, slug-format
   *  decoded), or null when the path is the (possibly prefixed) site root. */
  readonly slug: string | null;
  /** The parent chain's slugs the path implies, root first ([] for a
   *  top-level page or the root). */
  readonly ancestorSlugs: ReadonlyArray<string>;
  /** Everything the path's shape implies (e.g. `{ locale: "de" }`). */
  readonly annotations: Readonly<Record<string, unknown>>;
}

/**
 * Pure inversion of `resolvePageUrl` for an inbound path. Used by the
 * diff engine and path-entry surfaces to understand a path's shape;
 * authoritative page lookup goes through the `pages.current_path`
 * index. Loud (no-fallbacks): a path no active contribution can invert
 * throws instead of guessing.
 */
export function decodePagePath(path: string): DecodedPagePath {
  const trimmed = trimSlashes(path);

  const full = urlContributionsRegistry.bySlot("full-path");
  if (full && full.contribution.slot === "full-path") {
    const r = full.contribution.decode(`/${trimmed}`);
    if (r === null) {
      throw new Error(
        `url-composition: full-path contribution "${full.pluginSlug}" cannot decode "/${trimmed}"`,
      );
    }
    return { slug: r.slug, ancestorSlugs: r.ancestorSlugs ?? [], annotations: r.annotations };
  }

  let segments = trimmed.length === 0 ? [] : trimmed.split("/");
  let annotations: Record<string, unknown> = {};

  const prefixEntry = urlContributionsRegistry.bySlot("path-prefix");
  if (prefixEntry && prefixEntry.contribution.slot === "path-prefix") {
    const r = prefixEntry.contribution.decode(segments);
    if (r !== null) {
      if (r.consumed < 0 || r.consumed > segments.length) {
        throw new Error(
          `url-composition: path-prefix contribution "${prefixEntry.pluginSlug}" consumed ${r.consumed} of ${segments.length} segments`,
        );
      }
      segments = segments.slice(r.consumed);
      annotations = { ...annotations, ...r.annotations };
    }
  }

  if (segments.length === 0) {
    return { slug: null, ancestorSlugs: [], annotations };
  }

  // Leaf = the page's own (slug-formatted) segment; everything between
  // the prefix and the leaf is the parent chain.
  const ancestorSlugs = segments.slice(0, -1);
  let slugPart = segments[segments.length - 1] as string;
  const slugFmt = urlContributionsRegistry.bySlot("slug-format");
  if (slugFmt && slugFmt.contribution.slot === "slug-format") {
    slugPart = slugFmt.contribution.decode(slugPart);
  }
  return { slug: slugPart, ancestorSlugs, annotations };
}

// ---------------------------------------------------------------------------
// Annotation collection — the I/O phase before pure composition.
// ---------------------------------------------------------------------------

/**
 * Ask every contributing plugin for its URL annotations on the given
 * pages. Loud (no-fallbacks): a registered annotation op that fails
 * throws — composing URLs with silently-missing annotations would
 * materialize wrong paths.
 */
export async function collectUrlAnnotations(
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
  view?: UrlCompositionView,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (pageIds.length === 0) return out;
  for (const [pluginSlug, operationName] of urlContributionsRegistry.annotationOps()) {
    if (isPluginDisabled(pluginSlug)) continue;
    if (view?.without === pluginSlug) continue;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug,
      operationName,
      args: { pageIds: [...pageIds] },
    });
    if (!r.ok) {
      throw new Error(
        `url-composition: annotation op ${pluginSlug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const annotations = (r.value as { annotations?: Record<string, Record<string, unknown>> })
      .annotations;
    if (!annotations || typeof annotations !== "object") {
      throw new Error(
        `url-composition: annotation op ${pluginSlug}.${operationName} returned no \`annotations\` record`,
      );
    }
    for (const [pageId, ann] of Object.entries(annotations)) {
      out.set(pageId, { ...(out.get(pageId) ?? {}), ...ann });
    }
  }
  return out;
}
