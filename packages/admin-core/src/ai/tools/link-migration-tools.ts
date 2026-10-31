// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the AI's view of the link migration.
 *
 *   get_link_migration_report  which internal links the upgrade could
 *                              not turn into page references, and where
 *                              they are — so the AI can fix them in a
 *                              chat (edit the link to an existing page's
 *                              path) without asking the operator.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const reportInput = z
  .object({
    runId: z.string().uuid().optional(),
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
type ReportInput = z.infer<typeof reportInput>;

interface Unresolved {
  surface: string;
  entityKind: string;
  entityId: string;
  branchId: string | null;
  label: string;
  where: string;
  value: string;
  kind: string;
}

interface Summary {
  runId: string;
  mode: string;
  trigger: string;
  createdAt: string;
  counts: Record<string, number>;
  entitiesChanged: number;
  unresolvedCount: number;
  revertedAt: string | null;
}

const KIND_TEXT: Record<string, string> = {
  "unknown-page-path": "no page has this path",
  "unknown-media": "no media asset has this URL",
  "dangling-page-ref": "the linked page was deleted",
  "dangling-media-ref": "the linked asset was deleted",
  "unsupported-link-form": "its ?query or #anchor cannot be stored in a reference",
  "unknown-file": "a file path nothing on the site serves",
  "malformed-link-ref": "a broken internal reference (truncated id or extra characters)",
};

const SURFACE_TEXT: Record<string, string> = {
  module_html: "module HTML",
  module_field_defaults: "module field defaults (layout chrome)",
  content_values: "page / shared content",
  layout_html: "a layout's own HTML (the page frame; the Owner edits it under Settings → Layouts)",
};

export const getLinkMigrationReportTool: ToolDefinitionWithHandler<ReportInput> = {
  name: "get_link_migration_report",
  description:
    "Read-only report of the one-time link migration (old plain-path links converted to page references): links converted per place + every link it could NOT convert (matched no page/media; never guessed) with its module/content.\n" +
    "USE FOR: operator asks about broken/old links after an update; before fixing links site-wide. Current link problems -> `check_links`.\n" +
    "Fix each with `update_modules_many` / `set_content_instance_values_many`: point it at an existing page path (`list_pages`) or remove it. A link in a layout's own HTML is the Owner's (Settings -> Layouts): name the layout + path. Running/reverting the migration is the Owner's (Settings -> Internal links).",
  schema: reportInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: { type: "string", format: "uuid", description: "Omit for the latest run." },
      search: {
        type: "string",
        maxLength: 200,
        description: "Matches the link, its label and field.",
      },
      limit: { type: "integer", minimum: 1, maximum: 500 },
      offset: { type: "integer", minimum: 0 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "links.get_migration_report",
      input,
    );
    if (!r.ok)
      return toolError(r.error, `get_link_migration_report failed: ${describeError(r.error)}`);
    const v = r.value as { run: Summary | null; unresolved: Unresolved[]; unresolvedTotal: number };
    if (!v.run) {
      return {
        ok: true,
        content:
          "No link migration has run on this install yet. It runs once automatically when the admin starts after the update.",
      };
    }
    const counts = Object.entries(v.run.counts)
      .map(([s, n]) => `${SURFACE_TEXT[s] ?? s.replace(/^plugin:/, "plugin ")}: ${n}`)
      .join(", ");
    const lines = [
      `Link migration ${v.run.runId} (${v.run.mode === "dry_run" ? "dry run — nothing was changed" : v.run.mode}, ${v.run.createdAt})${v.run.revertedAt ? ` — REVERTED ${v.run.revertedAt}` : ""}.`,
      `Converted to references: ${counts || "none"}.`,
      v.unresolvedTotal === 0
        ? "Unconverted links: none."
        : `Unconverted links (${v.unresolvedTotal}${input.search ? ` matching "${input.search}"` : ""}):`,
      ...v.unresolved.map(
        (u) =>
          `- "${u.value}" in ${u.label}, ${u.where}${u.branchId ? " (in a chat's unstaged changes)" : ""} — ${KIND_TEXT[u.kind] ?? u.kind}`,
      ),
      v.unresolved.length < v.unresolvedTotal
        ? `…${v.unresolvedTotal - v.unresolved.length} more (page with offset).`
        : "",
    ].filter((l) => l !== "");
    return { ok: true, content: lines.join("\n") };
  },
};
