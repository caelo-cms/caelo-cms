// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — the wire format between the admin and the capture job, the
 * short-lived Cloud Run job that runs every server-side browser render of a
 * GCP install (screenshots, rendered HTML, selector queries) so no Chromium
 * runs in the admin container.
 *
 * The admin starts one job execution per capture with a `CaptureOrder` in
 * its environment. Anything bigger than an env var (a preview document, the
 * HTML a selector runs against) travels as an input object the admin wrote
 * into the capture bucket and the job reads through a V4 signed URL that
 * expires after a few minutes and is deleted when the capture ends. The job
 * writes one `CaptureResult` as JSON under `resultKey`; it may only create
 * objects, and only under `out/`. Both sides validate with these schemas:
 * the job renders untrusted pages, so the admin trusts its result no more
 * than any other untrusted data.
 */

import { SAMPLE_ROLES } from "@caelo-cms/site-importer";
import { z } from "zod";

/** The environment variable that carries the order. */
export const CAPTURE_ORDER_ENV_VAR = "CAELO_CAPTURE_ORDER";

/** The only host a signed input URL may point at (GCS V4 signed URLs). */
export const SIGNED_URL_HOST = "storage.googleapis.com";

/** The origin a served preview is addressed on inside the job's browser. */
export const PREVIEW_CAPTURE_ORIGIN = "https://preview.caelo.invalid";

const signedUrlSchema = z
  .string()
  .url()
  .refine((u) => {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === SIGNED_URL_HOST;
  }, `must be an https://${SIGNED_URL_HOST}/ signed URL`);

const allowedHostsSchema = z.array(z.string().min(1).max(253)).max(50);
const sizeSchema = z.number().int().min(100).max(8000);

const externalCaptureOptsSchema = z
  .object({
    width: sizeSchema.optional(),
    height: sizeSchema.optional(),
    fullPage: z.boolean().optional(),
    sampleStyles: z.boolean().optional(),
    captureHtml: z.boolean().optional(),
    stripHidden: z.boolean().optional(),
    selector: z.string().min(1).max(300).optional(),
  })
  .strict();

const externalRenderOptsSchema = z
  .object({
    width: sizeSchema.optional(),
    height: sizeSchema.optional(),
    sampleStyles: z.boolean().optional(),
    stripHidden: z.boolean().optional(),
  })
  .strict();

export const captureOpSchema = z.discriminatedUnion("kind", [
  /** Screenshot of a public URL, SSRF-guarded like every external render. */
  z
    .object({
      kind: z.literal("external-capture"),
      url: z.string().url(),
      allowedHosts: allowedHostsSchema,
      opts: externalCaptureOptsSchema,
    })
    .strict(),
  /** Rendered (JS-applied) HTML of a public URL, no pixels. */
  z
    .object({
      kind: z.literal("external-render"),
      url: z.string().url(),
      allowedHosts: allowedHostsSchema,
      opts: externalRenderOptsSchema,
    })
    .strict(),
  /** A css/xpath selector over an HTML string (input: {@link queryInputSchema}). */
  z
    .object({
      kind: z.literal("query"),
      inputUrl: signedUrlSchema,
      cssSelector: z.string().min(1).max(500).optional(),
      xpath: z.string().min(1).max(500).optional(),
      maxMatches: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  /** Screenshot of a branch preview the admin rendered (input: {@link previewInputSchema}). */
  z
    .object({
      kind: z.literal("preview-capture"),
      inputUrl: signedUrlSchema,
      pageId: z.string().uuid(),
      width: sizeSchema,
      height: sizeSchema,
      fullPage: z.boolean(),
      selector: z.string().min(1).max(300).optional(),
    })
    .strict(),
]);

export type CaptureOp = z.infer<typeof captureOpSchema>;

export const captureOrderSchema = z
  .object({
    /**
     * The admin's Caelo version. The job runs the admin's image (the
     * app-roll moves both); a job on another version refuses, so one that
     * lags an upgrade fails loudly instead of rendering with other code.
     */
    version: z.string().min(1),
    captureId: z.string().uuid(),
    /** Where the job writes its result: `out/<captureId>.json`. */
    resultKey: z.string().regex(/^out\/[0-9a-f-]{36}\.json$/),
    op: captureOpSchema,
  })
  .strict()
  .refine((o) => o.resultKey === `out/${o.captureId}.json`, "resultKey must name the capture");

export type CaptureOrder = z.infer<typeof captureOrderSchema>;

/** Input of a `query` op. */
export const queryInputSchema = z.object({ html: z.string().max(20_000_000) }).strict();

/** One media file of a served preview: where the job fetches it, and as what. */
const previewMediaSchema = z
  .object({ url: signedUrlSchema, contentType: z.string().min(1).max(100) })
  .strict();

/** The most media files one preview capture hands over. */
export const MAX_PREVIEW_MEDIA = 400;

/** Input of a `preview-capture` op: the rendered document and its media. */
export const previewInputSchema = z
  .object({
    /** The preview document, fonts inlined (`preview-document.ts`). */
    html: z.string().max(20_000_000),
    /** `/_caelo/media/...` path → its signed storage URL. */
    media: z.record(z.string().regex(/^\/_caelo\/media\/[^?#]+$/), previewMediaSchema),
  })
  .strict()
  .refine((i) => Object.keys(i.media).length <= MAX_PREVIEW_MEDIA, "too many media files");

export type PreviewInput = z.infer<typeof previewInputSchema>;

const styleSampleSchema = z
  .object({ role: z.enum(SAMPLE_ROLES), styles: z.record(z.string(), z.string()) })
  .strict();

const htmlSchema = z.string().max(20_000_000);

export const captureResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("capture"),
      captureId: z.string().uuid(),
      pngBase64: z.string().min(1).max(60_000_000),
      width: z.number().int(),
      height: z.number().int(),
      finalUrl: z.string().max(4000).optional(),
      finalStatus: z.number().int().optional(),
      contentType: z.string().max(300).optional(),
      styleSamples: z.array(styleSampleSchema).max(2000).optional(),
      renderedHtml: htmlSchema.optional(),
      visibleHtml: htmlSchema.optional(),
      hiddenRemoved: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("render"),
      captureId: z.string().uuid(),
      finalUrl: z.string().max(4000),
      html: htmlSchema,
      contentType: z.string().max(300).optional(),
      styleSamples: z.array(styleSampleSchema).max(2000).optional(),
      visibleHtml: htmlSchema.optional(),
      hiddenRemoved: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      captureId: z.string().uuid(),
      matches: z.array(z.string().max(2_000_000)).max(100),
    })
    .strict(),
  /** The render failed (unreachable page, selector without match, version mismatch, …). */
  z
    .object({
      kind: z.literal("error"),
      captureId: z.string().uuid(),
      code: z.string().min(1).max(100),
      message: z.string().max(4000),
    })
    .strict(),
]);

export type CaptureResult = z.infer<typeof captureResultSchema>;
