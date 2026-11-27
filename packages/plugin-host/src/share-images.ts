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
 * #1729 (docs/dev/external-plugin-brokers.md §6.2, for every plugin): each
 * image must exist and be a library image (`checkPluginMedia`: not a
 * reference image, not a file of another kind). One that is not, and an
 * answer outside the contract or over its cap, is refused per page
 * (`refused`): the page then shows no plugin image and NOT the site
 * default, which would be a silent fallback (CLAUDE.md §2), and the
 * refusal is a render failure Publish live refuses. An installed plugin
 * answers through the `$shareImages` reserved entry.
 *
 * Loud (CLAUDE.md §2): a failing plugin op, an answer for a page that was
 * not asked about, and two plugins answering for one page all throw; a
 * preview reports a failing op instead (#1087).
 */

import { PLUGIN_SHARE_IMAGES_POINT, pluginValueRefusedMarker } from "@caelo-cms/shared";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { checkPluginMedia, describePluginMedia } from "./plugin-values.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import { chunkPageIds } from "./render-points.js";

/** A default share image core refused for a page. */
export interface RefusedShareImage {
  /** The asset the plugin named, or null when its answer named none it could parse. */
  readonly assetId: string | null;
  /** `plugin-value-refused:<plugin>.share-images.image:<rule>`. */
  readonly marker: string;
}

/** The plugins' default share images of the pages asked about. */
export interface ResolvedShareImages {
  /** pageId → the library image a plugin names as its default share image. */
  readonly images: ReadonlyMap<string, string>;
  /** pageId → the image a plugin named that core refused. */
  readonly refused: ReadonlyMap<string, RefusedShareImage>;
}

/** The largest share-images answer one call may return, serialized. */
export const SHARE_IMAGES_ANSWER_MAX_BYTES = 1024 * 1024;

/**
 * Pages one share-images call is asked about: an answer is under 80 bytes
 * a page, so 10 000 pages stay under the answer cap.
 */
export const SHARE_IMAGES_PAGES_PER_CALL = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.shareImagesOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const images = new Map<string, string>();
  const refused = new Map<string, RefusedShareImage>();
  if (pageIds.length === 0) return { images, refused };
  const plugins = contributors();
  if (plugins.length === 0) return { images, refused };
  const answeredBy = new Map<string, string>();
  const named = new Map<string, { slug: string; assetId: string }>();
  const refuse = (slug: string, pageId: string, assetId: string | null, rule: string) =>
    refused.set(pageId, {
      assetId,
      marker: pluginValueRefusedMarker(slug, PLUGIN_SHARE_IMAGES_POINT, "image", rule),
    });

  for (const lp of plugins) {
    const operationName = lp.definition.shareImagesOperation as string;
    const label = `share-images: ${lp.slug}.${operationName}`;
    for (const chunk of chunkPageIds(pageIds, { maxIds: SHARE_IMAGES_PAGES_PER_CALL })) {
      const r = await runPluginOperation({
        invocation: renderInvocation(scope),
        pluginSlug: lp.slug,
        operationName,
        args: { pageIds: chunk },
        maxAnswerBytes: SHARE_IMAGES_ANSWER_MAX_BYTES,
      });
      const tooLarge = r.ok
        ? Buffer.byteLength(JSON.stringify(r.value ?? null)) > SHARE_IMAGES_ANSWER_MAX_BYTES
        : r.error.message.includes("SandboxAnswerTooLarge");
      if (!r.ok && !tooLarge) {
        const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
        // #1087 — a preview shows the page without this plugin's default and
        // flags it; a build throws.
        if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "share-images", reason })) {
          break;
        }
        throw new Error(reason);
      }
      const value = r.ok ? r.value : undefined;
      const answer =
        isRecord(value) && Object.keys(value).every((k) => k === "images") ? value.images : null;
      if (tooLarge || !isRecord(answer)) {
        const rule = tooLarge ? "answer-too-large" : "answer-shape";
        for (const pageId of chunk) {
          if (!answeredBy.has(pageId)) refuse(lp.slug, pageId, null, rule);
        }
        continue;
      }
      const asked = new Set(chunk);
      for (const [pageId, assetId] of Object.entries(answer)) {
        if (!asked.has(pageId)) {
          throw new Error(`${label}: answered for page ${pageId}, which was not asked about`);
        }
        const other = answeredBy.get(pageId);
        if (other !== undefined) {
          // Whichever won would silently override the other's image.
          throw new Error(
            `share-images: page ${pageId} gets a default image from both "${other}" and "${lp.slug}". A page can have at most one.`,
          );
        }
        answeredBy.set(pageId, lp.slug);
        if (typeof assetId !== "string" || !UUID_RE.test(assetId)) {
          refuse(lp.slug, pageId, null, "image-id-invalid");
          continue;
        }
        // Ids are compared as the media table spells them.
        named.set(pageId, { slug: lp.slug, assetId: assetId.toLowerCase() });
      }
    }
  }

  // Media is not branched: a preview and a build see the same facts.
  const facts = await describePluginMedia([...named.values()].map((n) => n.assetId));
  for (const [pageId, { slug, assetId }] of named) {
    const rule = checkPluginMedia(`caelo:media/${assetId}`, facts);
    if (rule === null) images.set(pageId, assetId);
    else refuse(slug, pageId, assetId, rule);
  }
  return { images, refused };
}
