// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — per-page edit LOG ops. Append-only WORK HISTORY (why a page
 * was edited, decisions taken, operator answers, open questions) so a later
 * chat or a fresh subagent reads the page's intent instead of the whole
 * originating transcript.
 *
 *  page_log.append — routine scope (human + ai + system). Ungated because
 *                    the log is FACT, not learned behaviour: nothing to
 *                    review, nothing to revert. Snapshot-free like the audit
 *                    log / import notes — the log is metadata about page work,
 *                    not page content, so it is not part of revert scope.
 *  page_log.list   — open read (human + ai + system); newest-first.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  err,
  ok,
  type PageLogEntry,
  pageLogAppendInputSchema,
  pageLogEntrySchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { toIsoRequired } from "./_helpers.js";
import { resolveChatSessionId } from "./_propose-helpers.js";

export const appendPageLogOp = defineOperation({
  name: "page_log.append",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: pageLogAppendInputSchema,
  output: z.object({ entryId: z.string() }),
  handler: async (ctx, input, tx) => {
    // Fail loud (CLAUDE.md §2 no-fallbacks): logging against a non-existent
    // page is a caller bug (stale/guessed id), not something to swallow.
    const pageRows = (await tx.execute(
      sql`SELECT 1 FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL LIMIT 1`,
    )) as unknown as unknown[];
    if (pageRows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "page_log.append",
        message: `no live page with id ${input.pageId} — pass a real page id (list_pages) before logging.`,
      });
    }

    // Chat origin is inferred from the branch the write runs on, not passed
    // by the caller, so the AI can't spoof a different session's log.
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);

    const rows = (await tx.execute(sql`
      INSERT INTO page_edit_log
        (page_id, chat_session_id, actor_id, actor_kind, entry_kind, summary, detail)
      VALUES (
        ${input.pageId}::uuid,
        ${chatSessionId}::uuid,
        ${ctx.actorId}::uuid,
        ${ctx.actorKind},
        ${input.entryKind},
        ${input.summary},
        ${jsonbParam(input.detail ?? null)}
      )
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "page_log.append",
      input: { pageId: input.pageId, entryKind: input.entryKind },
      succeeded: true,
      resultSummary: `page ${input.pageId}: ${input.entryKind}`,
    });

    return ok({ entryId: rows[0]?.id ?? "" });
  },
});

export const listPageLogOp = defineOperation({
  name: "page_log.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  output: z.object({ entries: z.array(pageLogEntrySchema) }),
  handler: async (_ctx, input, tx) => {
    const limit = input.limit ?? 20;
    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id,
        page_id::text AS page_id,
        chat_session_id::text AS chat_session_id,
        actor_kind,
        entry_kind,
        summary,
        detail,
        created_at
      FROM page_edit_log
      WHERE page_id = ${input.pageId}::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      page_id: string;
      chat_session_id: string | null;
      actor_kind: string;
      entry_kind: string;
      summary: string;
      detail: unknown;
      created_at: string | Date;
    }>;

    const entries: PageLogEntry[] = rows.map((r) => ({
      id: r.id,
      pageId: r.page_id,
      chatSessionId: r.chat_session_id,
      actorKind: r.actor_kind as PageLogEntry["actorKind"],
      entryKind: r.entry_kind as PageLogEntry["entryKind"],
      summary: r.summary,
      // jsonb columns read back parsed already under bun-postgres; a string
      // only appears on the (unused) double-encoded legacy path.
      detail:
        r.detail === null || r.detail === undefined
          ? null
          : ((typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail) as Record<
              string,
              unknown
            >),
      createdAt: toIsoRequired(r.created_at, "created_at"),
    }));

    return ok({ entries });
  },
});
