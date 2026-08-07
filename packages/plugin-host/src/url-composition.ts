// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/url-composition — the URL composition point
 * (#390, epic #380 decisions 1 + 4).
 *
 * Core owns a FIXED grammar:
 *
 *   scheme+host · path-prefix · slug (filtered by slug-format)
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
import type { PluginHostInfra } from "./dispatch.js";
import { isPluginDisabled, runPluginOperation } from "./dispatch.js";

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
    for (const c of contributions) {
      const existing = this.#bySlot.get(c.slot);
      if (existing && existing.pluginSlug !== pluginSlug) {
        throw new Error(
          `URL slot "${c.slot}" is already claimed by plugin "${existing.pluginSlug}" — conflicts with "${pluginSlug}". Slots are exclusive; deactivate one of the plugins.`,
        );
      }
      if (c.slot === "full-path" && this.activeSlots().some((s) => s !== "full-path")) {
        throw new Error(
          `URL slot "full-path" is exclusive with every other slot, but ${this.activeSlots().join(", ")} are claimed.`,
        );
      }
      if (c.slot !== "full-path" && this.#bySlot.has("full-path")) {
        const holder = this.#bySlot.get("full-path");
        throw new Error(
          `URL slot "${c.slot}" cannot be claimed while "${holder?.pluginSlug}" holds "full-path" (exclusive).`,
        );
      }
      this.#bySlot.set(c.slot, { pluginSlug, contribution: c });
    }
    if (annotationsOperation) {
      this.#annotationOps.set(pluginSlug, annotationsOperation);
    }
  }

  unregisterPlugin(pluginSlug: string): void {
    for (const [slot, entry] of this.#bySlot) {
      if (entry.pluginSlug === pluginSlug) this.#bySlot.delete(slot);
    }
    this.#annotationOps.delete(pluginSlug);
  }

  /** Active (non-disabled) contribution for a slot. */
  bySlot(slot: UrlSlot): RegisteredUrlContribution | null {
    const entry = this.#bySlot.get(slot);
    if (!entry) return null;
    if (isPluginDisabled(entry.pluginSlug)) return null;
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

function assertSegment(seg: string, source: string): void {
  if (!PATH_SEGMENT_RE.test(seg) || seg.includes("/")) {
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
 * Compose a page's public URL from the active contributions. Pure —
 * annotations must already be attached to `page`.
 */
export function resolvePageUrl(page: UrlComposePage): ResolvedPageUrl {
  const full = urlContributionsRegistry.bySlot("full-path");
  const host = urlContributionsRegistry.bySlot("host");
  let hostValue: string | null = null;
  if (host && host.contribution.slot === "host") {
    hostValue = host.contribution.encode(page);
  }

  if (full && full.contribution.slot === "full-path") {
    const path = full.contribution.encode(page);
    if (!path.startsWith("/")) {
      throw new Error(
        `url-composition: full-path contribution "${full.pluginSlug}" must return a leading-slash path (got "${path}")`,
      );
    }
    return { path, host: hostValue };
  }

  const prefixEntry = urlContributionsRegistry.bySlot("path-prefix");
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

  let slugPart = page.slug;
  const slugFmt = urlContributionsRegistry.bySlot("slug-format");
  if (slugFmt && slugFmt.contribution.slot === "slug-format") {
    slugPart = slugFmt.contribution.encode(page);
  }
  // Slugs may contain "/" (nested paths) — validate each segment.
  const slugSegments = slugPart.split("/").filter((s) => s.length > 0);
  if (slugSegments.length === 0) {
    throw new Error(
      `url-composition: page ${page.pageId} composed an empty slug part from slug "${page.slug}"`,
    );
  }
  for (const seg of slugSegments) {
    assertSegment(seg, slugFmt ? `${slugFmt.pluginSlug}/slug-format` : "core/slug");
  }

  return { path: `/${[...prefixSegments, ...slugSegments].join("/")}`, host: hostValue };
}

export interface DecodedPagePath {
  /** The stored slug the path maps to, or null when the path is the
   *  (possibly prefixed) site root. */
  readonly slug: string | null;
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
    return { slug: r.slug, annotations: r.annotations };
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
    return { slug: null, annotations };
  }

  let slugPart = segments.join("/");
  const slugFmt = urlContributionsRegistry.bySlot("slug-format");
  if (slugFmt && slugFmt.contribution.slot === "slug-format") {
    slugPart = slugFmt.contribution.decode(slugPart);
  }
  return { slug: slugPart, annotations };
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
  _infra?: PluginHostInfra,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (pageIds.length === 0) return out;
  for (const [pluginSlug, operationName] of urlContributionsRegistry.annotationOps()) {
    if (isPluginDisabled(pluginSlug)) continue;
    const r = await runPluginOperation({
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
