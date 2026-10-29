// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — a branch-preview screenshot through the capture job.
 *
 * The job cannot reach the admin: the admin sits behind Google IAP, and the
 * job renders untrusted pages (third-party sites for the external tools,
 * module scripts for previews), so its identity must not be one that passes
 * IAP. Instead the admin hands the job everything the render needs:
 *
 *   1. it renders the preview document itself (`pages.render_preview`, fonts
 *      inlined — the same document `/_caelo/preview-screenshot/<id>` serves);
 *   2. for every `/_caelo/media/...` URL in it, it signs a 5-minute read URL
 *      of that variant's object in the media bucket;
 *   3. it writes `{ html, media }` into the capture bucket and starts the job
 *      with a signed URL of that object (deleted when the capture ends).
 *
 * The job serves the document and the media to its browser under a made-up
 * origin and aborts every other request (site-importer `handleServedRoute`),
 * exactly the fail-closed policy the in-process capture applies to its own
 * loopback origin. No admin credential, session or token ever leaves the
 * admin.
 */

import { extractMediaUrlPaths, FAVICON_VARIANT, MEDIA_VARIANT_TAGS } from "@caelo-cms/shared";
import type { Screenshot } from "@caelo-cms/site-importer";
import type { CaptureClient } from "./capture-client.js";
import { MAX_PREVIEW_MEDIA, type PreviewInput } from "./capture-protocol.js";
import { screenshotOf } from "./job-screenshotter.js";

/** One media variant's object in the media bucket. */
export interface ResolvedMedia {
  readonly storageKey: string;
  readonly contentType: string;
}

/**
 * Resolves an editor media reference (slug or legacy id) + variant to its
 * stored object, or null when the asset or variant does not exist (the
 * admin's media route answers 404 for it, and so does the job).
 */
export type MediaResolver = (ref: string, variant: string) => Promise<ResolvedMedia | null>;

/**
 * Where the capture job gets a preview from: the admin's own render of the
 * document and its media lookups (preview-source.ts builds it from the
 * Query API).
 */
export interface ServedPreviewSource {
  /** The composed preview document of the page on the branch, or why not. */
  renderDocument(): Promise<
    { readonly ok: true; readonly html: string } | { readonly ok: false; readonly message: string }
  >;
  readonly resolveMedia: MediaResolver;
}

const SERVED_VARIANTS = new Set<string>([...MEDIA_VARIANT_TAGS, FAVICON_VARIANT]);

/** How many media URLs are signed at once (each is one IAM signBlob call). */
const SIGN_CONCURRENCY = 16;

/**
 * The hand-over for one preview capture: the document and a signed URL for
 * each media file it references. Exported for tests.
 *
 * @throws when the page references more media files than one capture hands
 *   over — a loud refusal, never a capture with holes in it.
 */
export async function buildPreviewInput(
  html: string,
  deps: {
    readonly resolveMedia: MediaResolver;
    readonly sign: (storageKey: string) => Promise<string>;
  },
): Promise<PreviewInput> {
  const refs = extractMediaUrlPaths(html).filter((r) => SERVED_VARIANTS.has(r.variant));
  if (refs.length > MAX_PREVIEW_MEDIA) {
    throw new Error(
      `the page references ${refs.length} media files; a server-side screenshot hands over at most ${MAX_PREVIEW_MEDIA} — capture one module with \`selector\` instead`,
    );
  }
  const media: Record<string, { url: string; contentType: string }> = {};
  for (let i = 0; i < refs.length; i += SIGN_CONCURRENCY) {
    await Promise.all(
      refs.slice(i, i + SIGN_CONCURRENCY).map(async (r) => {
        const resolved = await deps.resolveMedia(r.ref, r.variant);
        if (!resolved) return;
        media[r.path] = {
          url: await deps.sign(resolved.storageKey),
          contentType: resolved.contentType,
        };
      }),
    );
  }
  return { html, media };
}

/** Run a preview capture through the job. */
export async function captureServedPreview(
  client: CaptureClient,
  args: {
    readonly pageId: string;
    /** The preview document, fonts inlined. */
    readonly html: string;
    readonly resolveMedia: MediaResolver;
    readonly width: number;
    readonly height: number;
    readonly fullPage: boolean;
    readonly selector?: string;
  },
): Promise<Screenshot> {
  const input = await buildPreviewInput(args.html, {
    resolveMedia: args.resolveMedia,
    sign: (key) => client.store.signMedia(key),
  });
  const r = await client.run(
    (inputUrl) => {
      if (!inputUrl) throw new Error("a preview capture needs its input");
      return {
        kind: "preview-capture",
        inputUrl,
        pageId: args.pageId,
        width: args.width,
        height: args.height,
        fullPage: args.fullPage,
        ...(args.selector ? { selector: args.selector } : {}),
      };
    },
    { text: JSON.stringify(input) },
  );
  if (r.kind === "error") throw new Error(r.message);
  if (r.kind !== "capture")
    throw new Error(`the capture job answered a preview capture with a ${r.kind}`);
  return screenshotOf(r);
}
