// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: migrate_media. issue #249 (WS3) — after compose, the
 * imported pages still hotlink images/fonts/files from the source
 * site; the migration isn't survivable until those assets live in
 * Caelo's media library. This tool wraps `imports.migrate_media`:
 * download every external asset the composed modules reference,
 * dedupe by content hash, rewrite the module HTML/CSS + template CSS
 * to Caelo media URLs, and report everything that could NOT be
 * migrated.
 */

import { execute } from "@caelo-cms/query-api";
import { migrateImportMediaToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const migrateMediaTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").MigrateImportMediaToolInput
> = {
  name: "migrate_media",
  description:
    "Download every external asset (images, fonts, PDFs, SVGs) that a composed import run still hotlinks from the source site into Caelo's media library, and rewrite the module HTML/CSS to the new Caelo media URLs. " +
    "Call this IMMEDIATELY AFTER `compose_from_import` succeeds — a migration is not done while the old host still serves the assets. " +
    "Idempotent: re-running skips references that already point at Caelo media. " +
    "The result lists every asset that could NOT be migrated (too large, fetch failed, blocked content type, budget exhausted) — report that list to the operator verbatim; never claim a clean migration while it is non-empty. " +
    "Do NOT use for ad-hoc image needs — `generate_image` (new visuals) or the media library (existing assets) win there.",
  schema: migrateImportMediaToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: {
      runId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.migrate_media", input);
    if (!r.ok) {
      return { ok: false, content: `imports.migrate_media failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      migrated: number;
      migratedBytes: number;
      dedupedExisting: number;
      alreadyLocal: number;
      modulesRewritten: number;
      templatesRewritten: number;
      skipped: Array<{ url: string; reason: string }>;
    };
    const mb = (v.migratedBytes / (1024 * 1024)).toFixed(2);
    const lines = [
      `media migration: ${v.migrated} asset(s) downloaded (${mb} MB), ${v.dedupedExisting} reused existing library asset(s) (same content hash), ${v.alreadyLocal} reference(s) already pointed at Caelo media. Rewrote ${v.modulesRewritten} module(s) and ${v.templatesRewritten} template(s).`,
    ];
    if (v.skipped.length > 0) {
      lines.push(
        `${v.skipped.length} asset(s) could NOT be migrated — surface this list to the operator (these URLs still point at the source site and will break when it goes away):`,
        ...v.skipped.map((s) => `- ${s.url} — ${s.reason}`),
      );
    } else {
      lines.push(
        "Every discovered asset reference now points at Caelo media — no remaining source-host dependencies.",
      );
    }
    return { ok: true, content: lines.join("\n") };
  },
};
