// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — `rebuild_media_digests`. A build names and uploads media by the
 * digests stored with each file (`media_variants.content_sha256` …), never
 * by reading it; this tool is the repair its errors point at. Wraps
 * `media.rebuild_digests`.
 */

import { execute } from "@caelo-cms/query-api";
import { type RebuildMediaDigestsToolInput, rebuildMediaDigestsToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const rebuildMediaDigestsTool: ToolDefinitionWithHandler<RebuildMediaDigestsToolInput> = {
  name: "rebuild_media_digests",
  description:
    "Recompute the stored digests of media files (what a build names and uploads them by).\n" +
    "USE FOR: Stage fails with 'have no stored digests' (scope 'missing') or 'no longer matches its stored digest' (a file changed outside Caelo: scope 'all', optionally `assetIds`). Every Stage already digests missing rows itself; then Stage again.\n" +
    "Result: `updated` rows, `corrected` (wrong digests fixed), `missingFiles` (no file in storage -> `list_missing_media`).",
  schema: rebuildMediaDigestsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["missing", "all"],
        default: "missing",
        description: "'missing' = rows without digests; 'all' = recompute and compare every row.",
      },
      assetIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: 1,
        maxItems: 500,
        description: "Only these assets.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "media.rebuild_digests",
      input,
    );
    if (!res.ok) {
      return { ok: false, content: `media.rebuild_digests failed: ${describeError(res.error)}` };
    }
    const out = res.value as {
      checked: number;
      updated: number;
      corrected: { assetId: string; slug: string; variant: string }[];
      missingFiles: { assetId: string; slug: string; variant: string }[];
    };
    const lines = [`Checked ${out.checked} media file(s); updated ${out.updated}.`];
    if (out.corrected.length > 0) {
      lines.push(`Corrected: ${out.corrected.map((c) => `${c.slug}/${c.variant}`).join(", ")}.`);
    }
    if (out.missingFiles.length > 0) {
      lines.push(
        `No stored file: ${out.missingFiles.map((m) => `${m.slug}/${m.variant}`).join(", ")} -> list_missing_media.`,
      );
    }
    return { ok: true, content: lines.join("\n"), value: out };
  },
};
