// SPDX-License-Identifier: MPL-2.0

/**
 * `list_missing_media` — the library assets whose stored image files are
 * gone (wraps `media.list_missing_files`). The recovery entry point Stage's
 * "stored files … are missing" error names.
 */

import { z } from "zod";
import { makeReadTool } from "./_make-read-tool.js";

const input = z
  .object({
    limit: z.number().int().min(1).max(500).optional().describe("Most-used first; default 100."),
  })
  .strict();

interface MissingAsset {
  assetId: string;
  name: string;
  url: string;
  sourceKind: string | null;
  sourceDetail: string | null;
  usageCount: number;
  missingVariants: string[];
}

export const listMissingMediaTool = makeReadTool<z.infer<typeof input>>({
  name: "list_missing_media",
  description:
    "List media assets whose stored files are gone (row exists, bytes lost). Use when Stage/deploy fails with 'stored files of … media asset(s) are missing', or before publishing after such a failure. Missing derived variants of an existing file -> `regenerate_media_variants`.\n" +
    "Per asset: `source` is a URL -> `import_media_from_urls` on it (same bytes refill the same asset, fixing every page); else ask the operator to re-upload the same file at /content/media (identical files reuse the asset). Unrestorable -> take it off its pages (`list_media_usages`), then `delete_media_many`.",
  opName: "media.list_missing_files",
  input,
  format: (value) => {
    const v = value as { checkedAssets: number; missingCount: number; assets: MissingAsset[] };
    if (v.missingCount === 0) {
      return `All ${v.checkedAssets} media assets have their stored files.`;
    }
    const lines = v.assets.map((a) => {
      const source =
        a.sourceKind === "imported" && a.sourceDetail
          ? `imported from ${a.sourceDetail}`
          : (a.sourceKind ?? "unknown source");
      return `- ${a.assetId} "${a.name}" ${a.url} — used ${a.usageCount}x, ${source}; missing: ${a.missingVariants.join(", ")}`;
    });
    const shown =
      v.assets.length < v.missingCount ? ` (showing ${v.assets.length}; raise limit for more)` : "";
    return `${v.missingCount} of ${v.checkedAssets} media assets have missing files${shown}:\n${lines.join("\n")}`;
  },
});
