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
        "image/x-icon",
        "application/pdf",
        "video/mp4",
      ])
      .optional(),
    /** #531 — `library` (default) hides reference images; `all` lists both. */
    visibility: z.enum(["library", "reference", "all"]).optional(),
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
  visibility: "library" | "reference";
  variants: { variant: string }[];
}

export const findMediaTool = makeListReadTool<z.infer<typeof findMediaInput>, MediaRow>({
  name: "find_media",
  description:
    "Search the EXISTING media library, most-used first, e.g. when the user describes an asset (TOON rows: id, name, mime, dims, alt, url).\n" +
    "DO NOT USE FOR: site migrations (library is empty) -> `import_media_from_urls`.\n" +
    "CORE RULES: `id` = media UUID for `set_theme_asset` / `set_media_alt_many` / `regenerate_media_variants`; take it from here, never invent one. `url` points at an EXISTING variant: use it verbatim in `<img src>` (via `update_modules_many`), never rewrite the variant segment. Reference images (generate/edit guides, not placeable) are hidden unless `visibility` is `reference` | `all`.",
  opName: "media.list",
  input: findMediaInput,
  listParamDescriptions: {
    filter: "Server-side search over alt text and filename.",
    limit: "Default 15, max 50.",
  },
  buildOpInput: (
    input: {
      mime?: string;
      visibility?: "library" | "reference" | "all";
      filter?: string;
      limit?: number;
      offset?: number;
      full?: boolean;
    },
    _ctx: ExecutionContext,
    _toolCtx: ToolContext,
  ) => ({
    ...(input.filter !== undefined ? { query: input.filter } : {}),
    ...(input.mime !== undefined ? { mime: input.mime } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    sort: "most_used",
    limit: input.full ? 50 : Math.min(input.limit ?? 15, 50),
    offset: input.offset ?? 0,
  }),
  label: "media",
  rows: (value) => (value as { assets: MediaRow[] }).assets,
  columns: [
    // The UUID other media tools (set_theme_asset, set_media_alt_many, …)
    // require — issue #411: without it the model had no way to bind
    // what it found.
    { key: "id", value: (a) => a.id },
    { key: "name", value: (a) => a.originalName },
    { key: "mime", value: (a) => a.mime },
    { key: "dims", value: (a) => (a.width && a.height ? `${a.width}x${a.height}` : "") },
    { key: "alt", value: (a) => a.alt },
    { key: "visibility", value: (a) => a.visibility },
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
