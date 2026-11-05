// SPDX-License-Identifier: MPL-2.0

/**
 * #1452 — the share-images composition point: which default social-share
 * image a page gets from a plugin (international-site: its language's).
 *
 * Core's rule is `pickShareImage` (`@caelo-cms/shared`): the page's own
 * image, then this answer, then the site default. Core keeps no locale
 * logic; a plugin answers per page with a media asset id, and core
 * publishes that asset like any other og:image.
 *
 * Without an active contributor nothing changes and no plugin is called.
 * The build, the editor preview and the SEO reads all ask through here, so
 * they cannot disagree on which image a page gets.
 *
 * Loud (CLAUDE.md §2): a failing plugin op, an ill-formed answer, an answer
 * for a page that was not asked about, and two plugins answering for one
 * page all throw; a preview reports the failure instead (#1087).
 */

import { z } from "zod";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { reportPluginRenderFailure } from "./render-failures.js";

/** pageId → the media asset a plugin names as its default share image. */
export type ResolvedShareImages = ReadonlyMap<string, string>;

const shareImagesAnswer = z.object({ images: z.record(z.string(), z.string().uuid()) }).strict();

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.shareImagesOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Ask every contributing plugin for the default share image of these pages.
 *
 * @param pageIds pages without an image of their own.
 */
export async function resolveShareImages(
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
): Promise<ResolvedShareImages> {
  const out = new Map<string, string>();
  if (pageIds.length === 0) return out;
  const plugins = contributors();
  if (plugins.length === 0) return out;
  const asked = new Set(pageIds);
  const answeredBy = new Map<string, string>();

  for (const lp of plugins) {
    const operationName = lp.definition.shareImagesOperation as string;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: lp.slug,
      operationName,
      args: { pageIds: [...pageIds] },
    });
    if (!r.ok) {
      const reason = `share-images: ${lp.slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`;
      // #1087 — a preview shows the page without this plugin's default and
      // flags it; a build throws.
      if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "share-images", reason })) {
        continue;
      }
      throw new Error(reason);
    }
    const parsed = shareImagesAnswer.safeParse(r.value);
    if (!parsed.success) {
      throw new Error(
        `share-images: plugin "${lp.slug}" returned an invalid answer: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    for (const [pageId, assetId] of Object.entries(parsed.data.images)) {
      if (!asked.has(pageId)) {
        throw new Error(
          `share-images: plugin "${lp.slug}" answered for page ${pageId}, which was not asked about`,
        );
      }
      const other = answeredBy.get(pageId);
      if (other !== undefined) {
        // Whichever won would silently override the other's image.
        throw new Error(
          `share-images: page ${pageId} gets a default image from both "${other}" and "${lp.slug}". A page can have at most one.`,
        );
      }
      answeredBy.set(pageId, lp.slug);
      out.set(pageId, assetId);
    }
  }
  return out;
}
