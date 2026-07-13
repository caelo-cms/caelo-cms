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
      logoWarning: string | null;
    };
    const mb = (v.migratedBytes / (1024 * 1024)).toFixed(2);
    const lines = [
      `media migration: ${v.migrated} asset(s) downloaded (${mb} MB), ${v.dedupedExisting} reused existing library asset(s) (same content hash), ${v.alreadyLocal} reference(s) already pointed at Caelo media. Rewrote ${v.modulesRewritten} module(s) and ${v.templatesRewritten} template(s).`,
    ];
    if (v.skipped.length > 0) {
      // issue #28 — record every skipped asset in the run's error/warning
      // LEDGER so the closing report surfaces them even if this turn's text
      // scrolls away. Best-effort + non-fatal: a ledger-write failure must
      // never sink a media migration that actually moved assets — log loud,
      // don't throw. One bulk call (CLAUDE.md §11), not one per asset.
      const ledgerRes = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "imports.log_events",
        {
          events: v.skipped.map((s) => ({
            runId: input.runId,
            severity: "warning" as const,
            phase: "media" as const,
            message: `media asset not migrated: ${s.url} (${s.reason})`,
            detail: { url: s.url, reason: s.reason },
          })),
        },
      );
      if (!ledgerRes.ok) {
        console.error(
          `migrate_media: failed to append ${v.skipped.length} skipped-asset event(s) to the run ledger: ${describeError(ledgerRes.error)}`,
        );
      }
      lines.push(
        `${v.skipped.length} asset(s) could NOT be migrated — surface this list to the operator (these URLs still point at the source site and will break when it goes away):`,
        ...v.skipped.map((s) => `- ${s.url} — ${s.reason}`),
      );
    } else {
      lines.push(
        "Every discovered asset reference now points at Caelo media — no remaining source-host dependencies.",
      );
    }
    // Logo-preservation guardrail (op already recorded this in the run
    // ledger). Surface it LOUDLY here too so the model fixes the redraw
    // in THIS turn instead of only hearing about it at the closing
    // report: the source header had a real logo image, the rebuild does
    // not reference it — the operator's brand logo must be imported, not
    // hand-authored as a text/CSS wordmark.
    if (v.logoWarning) {
      lines.push(`LOGO NOT PRESERVED — ${v.logoWarning}`);
    }
    return { ok: true, content: lines.join("\n") };
  },
};
