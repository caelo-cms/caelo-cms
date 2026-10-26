// SPDX-License-Identifier: MPL-2.0

/**
 * The two operator buttons on a site-import run (/settings/import/<runId>)
 * as AI tools:
 *
 *   - `accept_import_pages` → `imports.accept_pages`: promote crawled pages
 *     VERBATIM as draft pages (routine — branch-scoped + snapshotted via
 *     `pages.build_page`, undoable from chat).
 *   - `cleanup_import_run` → `imports.cleanup_run`: close a run and drop its
 *     un-accepted crawl rows + their screenshots. IRREVERSIBLE — the crawl
 *     is the ground truth every per-page import tool reads, and re-crawling
 *     costs time and money — so it is human-approval-gated (§11.A) through
 *     the generic `needsApproval` card: the AI's call only queues it; the
 *     handler runs when the Owner clicks Approve, with the Owner's context.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { getMediaStorage } from "../../media/storage.js";
import { UNRESOLVED_IMPORT_LINK_NEXT_STEP } from "../../ops/links-import.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const resolveImportLinksInput = z
  .object({
    runId: z.string().uuid().describe("The import run whose rebuild you are finishing."),
  })
  .strict();

/**
 * Epic #724 — `resolve_import_links` → `imports.resolve_links`: the end of
 * a rebuild. Routine (snapshotted on the chat's branch, undone with it).
 */
export const resolveImportLinksTool: ToolDefinitionWithHandler<
  z.infer<typeof resolveImportLinksInput>
> = {
  name: "resolve_import_links",
  description:
    "Finish an import-run rebuild's links. During the rebuild, links to the run's pages (crawled, in the run's URL list, or linked from crawled pages) are kept as written and recorded instead of refused; other unknown paths are still refused. " +
    "Call ONCE when every run page is built (before `get_import_run_report`): rewrites recorded links to now-existing pages and lists still-unmatched links with locations -> fix each (build the page or point at an existing path), call again. Safe to repeat; run cleanup does it too. Not for links outside an import (checked on write).",
  schema: resolveImportLinksInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: { runId: { type: "string", format: "uuid" } },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.resolve_links", input);
    if (!r.ok) {
      return { ok: false, content: `resolve_import_links failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      resolved: number;
      unresolved: { value: string; entityKind: string; entityId: string; location: string }[];
    };
    if (v.resolved === 0 && v.unresolved.length === 0) {
      return { ok: true, content: "No links were waiting for a page of this run." };
    }
    const lines = [
      `${v.resolved} link(s) written before their page existed now point at their page.`,
    ];
    if (v.unresolved.length > 0) {
      lines.push(
        `${v.unresolved.length} still match no page: ${v.unresolved
          .map((u) => `"${u.value}" in ${u.entityKind} ${u.entityId} (${u.location})`)
          .join("; ")}. ${UNRESOLVED_IMPORT_LINK_NEXT_STEP}`,
      );
    }
    return { ok: true, content: lines.join(" ") };
  },
};

const acceptImportPagesInput = z
  .object({
    importPageIds: z.array(z.string().uuid()).min(1).max(50).describe("From `list_import_pages`."),
    templateId: z
      .string()
      .uuid()
      .optional()
      .describe("From `list_templates`; omit for the site default."),
  })
  .strict();

type AcceptImportPagesInput = z.infer<typeof acceptImportPagesInput>;

export const acceptImportPagesTool: ToolDefinitionWithHandler<AcceptImportPagesInput> = {
  name: "accept_import_pages",
  description:
    "Take crawled pages over AS-IS: each becomes a DRAFT page (chat preview, nothing published) from the crawl's content blocks (header/footer excluded — layout owns chrome), linked to its import row. All-or-nothing.\n" +
    "USE FOR: verbatim import ('bring the blog posts over as they are').\n" +
    "DO NOT USE FOR: a faithful rebuild in the site's design -> `build_page` with `page.importPageId` (the normal migration path).\n" +
    "Already accepted/built pages are refused (edit that page). Template block names must match the crawl's, else the call fails naming the block -> pick another template.",
  schema: acceptImportPagesInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.accept_pages", {
      importPageIds: input.importPageIds,
      ...(input.templateId ? { templateId: input.templateId } : {}),
    });
    if (!r.ok) {
      return { ok: false, content: `imports.accept_pages failed: ${describeError(r.error)}` };
    }
    const v = r.value as { accepted: { importPageId: string; pageId: string; slug: string }[] };
    return {
      ok: true,
      content:
        `Accepted ${v.accepted.length} page(s) as drafts:\n` +
        v.accepted.map((a) => `  ${a.slug} → page ${a.pageId}`).join("\n"),
      value: v,
    };
  },
};

const cleanupImportRunInput = z
  .object({
    runId: z.string().uuid().describe("From `list_import_runs`/`list_import_pages`."),
  })
  .strict();

type CleanupImportRunInput = z.infer<typeof cleanupImportRunInput>;

export const cleanupImportRunTool: ToolDefinitionWithHandler<CleanupImportRunInput> = {
  name: "cleanup_import_run",
  description:
    "Close a finished site-import run and permanently delete crawl data (staging rows + screenshots) of pages never accepted or built; built pages stay.\n" +
    "USE only when the operator says the migration is done and the leftover crawl can go. Irreversible: `get_import_page`/`list_import_pages` lose the dropped pages and a re-crawl costs time + money -> build still-needed pages first.\n" +
    "APPROVAL-GATED: your call queues it; data is deleted only after the operator clicks Approve on the in-chat card. Do not claim cleanup before that.",
  needsApproval: () => true,
  // #589 — the same permission the /settings/import panels require.
  approverPermissions: ["settings.write"],
  buildApprovalPreview: (input) => ({
    op: "cleanup_import_run",
    runId: input.runId,
    effect:
      "Marks the run completed and deletes every crawled page that was not accepted/built, plus its screenshot. Built pages are kept.",
  }),
  schema: cleanupImportRunInput,
  // Runs only after the Owner approved — with the Owner's context, which is
  // what `imports.cleanup_run` (human + system) requires.
  handler: async (ctx, input, toolCtx) => {
    const before = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.get", {
      runId: input.runId,
    });
    if (!before.ok) {
      return { ok: false, content: `imports.get failed: ${describeError(before.error)}` };
    }
    const snapshot = before.value as { run: { id: string } | null };
    if (!snapshot.run) {
      return { ok: false, content: `Import run ${input.runId} not found.` };
    }
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.cleanup_run", {
      runId: input.runId,
    });
    if (!r.ok) {
      return { ok: false, content: `imports.cleanup_run failed: ${describeError(r.error)}` };
    }
    // The op returns the screenshot keys of exactly the rows it deleted, so
    // a page accepted between the approval and this call keeps its
    // screenshot. Object deletes run after the DB commit and best effort:
    // a failed one leaves a harmless orphan, never a broken run (same
    // contract as the Owner panel's cleanup action).
    const { droppedPages, droppedScreenshotKeys: keys } = r.value as {
      droppedPages: number;
      droppedScreenshotKeys: string[];
    };
    let orphaned = 0;
    if (keys.length > 0) {
      const storage = getMediaStorage();
      const results = await Promise.allSettled(keys.map((k) => storage.delete(k)));
      orphaned = results.filter((x) => x.status === "rejected").length;
    }
    return {
      ok: true,
      content:
        `Import run ${input.runId} closed: ${droppedPages} un-built crawled page(s) and ${keys.length - orphaned} screenshot(s) deleted; built pages kept.` +
        (orphaned > 0
          ? ` ${orphaned} screenshot object(s) could not be deleted (harmless orphans).`
          : ""),
    };
  },
};
