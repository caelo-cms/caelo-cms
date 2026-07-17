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
  mime: string;
  alt: string;
  width: number | null;
  height: number | null;
  originalName: string;
  variants: { variant: string }[];
}

export const findMediaTool = makeListReadTool<z.infer<typeof findMediaInput>, MediaRow>({
  name: "find_media",
  description:
    "Search the media library (TOON rows: name, mime, dims, alt, url). `filter` matches alt/filename server-side; optional `mime`; `limit`/`offset`/`full` as usual. " +
    "The `url` column always points at a variant that EXISTS on the asset — use it verbatim in <img src> via edit_module; do NOT rewrite the variant segment. " +
    "Use when the user references an asset by description and it isn't in the ## Media block. If nothing matches, ask the user to upload via /content/media.",
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
      value: (a) => buildMediaUrl(a.id, pickAiImageVariant(a.variants.map((v) => v.variant))),
    },
  ],
  emptyMessage: "No media matched. Ask the user to upload the asset via /content/media.",
});
