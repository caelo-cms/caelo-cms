// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout D) — the link-resolve composition point: where an
 * internal page link goes on the page being rendered.
 *
 * Internal links are stored as page references (`caelo:page/<id>`) and
 * resolved per rendering page by the shared `SiteLinkIndex`. A plugin
 * that splits the site into page variants — international-site: one per
 * language — tells core which variant every page belongs to and which
 * pages are versions of each other. The index then maps a reference on
 * a German page to the German version of the target, in module HTML,
 * rich text, link fields, link lists, nav-menu sets and chrome alike,
 * without the plugin rewriting a single value.
 *
 * The answer is a page partition, not a per-link mapping, on purpose:
 * the template engine resolves synchronously while it renders, so the
 * whole relation has to be in hand before the first page renders, and
 * it is O(pages) where a (rendering page × target) matrix would be
 * O(pages²) for a build.
 *
 * Without an active contributor nothing changes and no plugin is called.
 * The editor preview (and live-edit, which renders through it) and the
 * static generator both resolve through here — one batched call per
 * contributing plugin — and feed the same `createSiteLinkIndex`, so the
 * surfaces cannot disagree.
 *
 * Loud (CLAUDE.md §2): a failing plugin op, an ill-formed answer, an
 * answer for a page that was not asked about, and two plugins answering
 * for the same page all throw.
 */

import { linkResolvePageVariant } from "@caelo-cms/plugin-sdk";
import type { LinkPageVariant } from "@caelo-cms/shared";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { reportPluginRenderFailure } from "./render-failures.js";

/** pageId → its variant and variant group. A missing page maps nothing. */
export type ResolvedLinkVariants = ReadonlyMap<string, LinkPageVariant>;

/** True when an active plugin answers the link-resolve point — callers
 *  skip the call entirely otherwise. */
export function hasLinkResolveContributors(): boolean {
  return contributors().length > 0;
}

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.linkResolveOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Ask every contributing plugin for the page-variant partition.
 *
 * @param pageIds every page the render can link to (the link index's
 *   pages: the whole site in the render's scope, drafts included).
 */
export async function resolveLinkVariants(
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
): Promise<ResolvedLinkVariants> {
  const out = new Map<string, LinkPageVariant>();
  if (pageIds.length === 0) return out;
  const plugins = contributors();
  if (plugins.length === 0) return out;
  const asked = new Set(pageIds);
  const answeredBy = new Map<string, string>();

  for (const lp of plugins) {
    const operationName = lp.definition.linkResolveOperation as string;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: lp.slug,
      operationName,
      args: { pageIds: [...pageIds] },
    });
    if (!r.ok) {
      const reason = `link-resolve: ${lp.slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`;
      // #1087 — a preview renders without this plugin's partition (links
      // then resolve as on a single-variant site) and flags it.
      if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "link-resolve", reason })) {
        continue;
      }
      throw new Error(reason);
    }
    const pages = (r.value as { pages?: Record<string, unknown> } | null)?.pages ?? {};
    for (const [pageId, raw] of Object.entries(pages)) {
      if (!asked.has(pageId)) {
        throw new Error(
          `link-resolve: plugin "${lp.slug}" answered for page ${pageId}, which is not part of this render`,
        );
      }
      const parsed = linkResolvePageVariant.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `link-resolve: plugin "${lp.slug}" returned an invalid answer for page ${pageId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      const other = answeredBy.get(pageId);
      if (other !== undefined) {
        // Two partitions of one page cannot both decide where its links
        // go; whichever won would silently override the other.
        throw new Error(
          `link-resolve: page ${pageId} is placed in a variant by both "${other}" and "${lp.slug}". A page can have at most one link resolver.`,
        );
      }
      answeredBy.set(pageId, lp.slug);
      out.set(pageId, { variant: parsed.data.variant, group: parsed.data.group });
    }
  }
  return out;
}
