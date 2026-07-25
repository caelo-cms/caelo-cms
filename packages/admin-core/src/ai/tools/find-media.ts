// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — `find_media` (2026-07: makeListReadTool — TOON output). The
 * `url` column is pre-resolved via pickAiImageVariant against the
 * variants that ACTUALLY exist (run #10 D4) — drop it straight into an
 * <img src>; never rewrite the variant segment.
 */

import type { ExecutionContext } from "@caelo-cms/shared";
import { buildMediaUrl, pickAiImageVariant } from "@caelo-cms/shared";
import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";
import type { ToolContext } from "./dispatch.js";

const findMediaInput = z
  .object({
    mime: z
      .enum([
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/avif",
        "image/gif",
        "image/svg+xml",
        "application/pdf",
        "video/mp4",
      ])
      .optional(),
  })
  .strict();

interface MediaRow {
  id: string;
  slug: string;
  mime: string;
  alt: string;
  width: number | null;
  height: number | null;
  originalName: string;
  sourceKind: string | null;
  sourceDetail: string | null;
  license: string | null;
  variants: { variant: string }[];
}

export const findMediaTool = makeListReadTool<z.infer<typeof findMediaInput>, MediaRow>({
  name: "find_media",
  description:
    "Search the media library (TOON rows: name, mime, dims, alt, url). `filter` matches alt/filename server-side; optional `mime`; `limit`/`offset`/`full` as usual. " +
    "The `url` column always points at a variant that EXISTS on the asset — use it verbatim in <img src> via edit_module; do NOT rewrite the variant segment. " +
    "Use when the user references an asset by description and it isn't in the ## Media block. This searches the EXISTING Caelo library only — during a site migration it is empty, so import source-site images with import_media_from_urls instead of this tool.",
  opName: "media.list",
  input: findMediaInput,
  buildOpInput: (
    input: { mime?: string; filter?: string; limit?: number; offset?: number; full?: boolean },
    _ctx: ExecutionContext,
    _toolCtx: ToolContext,
  ) => ({
    ...(input.filter !== undefined ? { query: input.filter } : {}),
    ...(input.mime !== undefined ? { mime: input.mime } : {}),
    sort: "most_used",
    limit: input.full ? 50 : Math.min(input.limit ?? 15, 50),
    offset: input.offset ?? 0,
  }),
  label: "media",
  rows: (value) => (value as { assets: MediaRow[] }).assets,
  columns: [
    { key: "name", value: (a) => a.originalName },
    { key: "mime", value: (a) => a.mime },
    { key: "dims", value: (a) => (a.width && a.height ? `${a.width}x${a.height}` : "") },
    { key: "alt", value: (a) => a.alt },
    {
      key: "url",
      value: (a) => buildMediaUrl(a.slug, pickAiImageVariant(a.variants.map((v) => v.variant))),
    },
    // Media provenance (0181) — where it came from + licence, when known.
    {
      key: "source",
      value: (a) =>
        a.sourceKind ? `${a.sourceKind}${a.sourceDetail ? `:${a.sourceDetail}` : ""}` : "",
    },
    { key: "license", value: (a) => a.license ?? "" },
  ],
  emptyMessage:
    "No media matched — this searches the EXISTING Caelo library. During a site migration the library is empty: import source-site images with import_media_from_urls (name the exact URLs from inspect_external_page's image inventory), not this tool. For a genuinely new asset the operator can upload via /content/media.",
});
