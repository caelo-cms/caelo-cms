// SPDX-License-Identifier: MPL-2.0

/**
 * Publish step: take every snapshot tagged with the chat's
 * chat_branch_id and re-emit them as main snapshots (no branch). The
 * live tables are already updated (each AI tool call wrote them inside
 * the chat's branch); publish is the audit-trail boundary that says
 * "these changes are now in the linear main history".
 *
 * P5 implementation is straightforward: copy the latest branch snapshot
 * per entity into a fresh main snapshot via `emitSnapshot`, then mark
 * the chat session `published_at = now()`. Since reverts go through the
 * same `emitSnapshot` path the snapshot history continues to be linear.
 */

import { defineOperation } from "@caelo/query-api";
import { chatPublishInput, err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  emitSnapshot,
  parseAndUpgradeModuleState,
  parseAndUpgradePageLayoutState,
  parseAndUpgradePageState,
  parseAndUpgradeTemplateState,
  parseSnapshotState,
  type SnapshotEntity,
  SnapshotSchemaError,
} from "../../snapshots/index.js";

export const publishChatSessionOp = defineOperation({
  name: "chat.publish",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: chatPublishInput,
  output: z.object({
    siteSnapshotId: z.string().nullable(),
    entityCount: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const sessionRows = (await tx.execute(sql`
      SELECT chat_branch_id::text AS chat_branch_id, published_at, title
      FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
      LIMIT 1
    `)) as unknown as {
      chat_branch_id: string;
      published_at: string | Date | null;
      title: string;
    }[];
    const session = sessionRows[0];
    if (!session) {
      return err({
        kind: "HandlerError",
        operation: "chat.publish",
        message: "session not found",
      });
    }
    if (session.published_at !== null) {
      return err({
        kind: "HandlerError",
        operation: "chat.publish",
        message: "chat already published",
      });
    }

    // Pull the latest entity-state snapshot per (kind, entity_id) inside
    // this branch. DISTINCT ON returns the most recent for each entity
    // because we order by created_at DESC.
    type Row = { entity_id: string; state: unknown };
    const moduleRows = (await tx.execute(sql`
      SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS entity_id, ms.state
      FROM module_snapshots ms
      JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY ms.module_id, ss.created_at DESC
    `)) as unknown as Row[];
    const templateRows = (await tx.execute(sql`
      SELECT DISTINCT ON (ts.template_id) ts.template_id::text AS entity_id, ts.state
      FROM template_snapshots ts
      JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY ts.template_id, ss.created_at DESC
    `)) as unknown as Row[];
    const pageRows = (await tx.execute(sql`
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS entity_id, ps.state
      FROM page_snapshots ps
      JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY ps.page_id, ss.created_at DESC
    `)) as unknown as Row[];
    const layoutRows = (await tx.execute(sql`
      SELECT DISTINCT ON (pls.page_id) pls.page_id::text AS entity_id, pls.state
      FROM page_layout_snapshots pls
      JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY pls.page_id, ss.created_at DESC
    `)) as unknown as Row[];

    const total = moduleRows.length + templateRows.length + pageRows.length + layoutRows.length;
    if (total === 0) {
      // Nothing happened in the branch — mark published anyway so the
      // session is closed; no merged snapshot.
      await tx.execute(sql`
        UPDATE chat_sessions SET published_at = now()
        WHERE id = ${input.chatSessionId}::uuid
      `);
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "chat.publish",
        input,
        succeeded: true,
        entityId: input.chatSessionId,
        resultSummary: "no-op (empty branch)",
      });
      return ok({ siteSnapshotId: null, entityCount: 0 });
    }

    let entities: SnapshotEntity[];
    try {
      entities = [
        ...moduleRows.map(
          (r): SnapshotEntity => ({
            kind: "module",
            entityId: r.entity_id,
            state: parseAndUpgradeModuleState(parseSnapshotState(r.state)),
          }),
        ),
        ...templateRows.map(
          (r): SnapshotEntity => ({
            kind: "template",
            entityId: r.entity_id,
            state: parseAndUpgradeTemplateState(parseSnapshotState(r.state)),
          }),
        ),
        ...pageRows.map(
          (r): SnapshotEntity => ({
            kind: "page",
            entityId: r.entity_id,
            state: parseAndUpgradePageState(parseSnapshotState(r.state)),
          }),
        ),
        ...layoutRows.map(
          (r): SnapshotEntity => ({
            kind: "pageLayout",
            entityId: r.entity_id,
            state: parseAndUpgradePageLayoutState(parseSnapshotState(r.state)),
          }),
        ),
      ];
    } catch (e) {
      if (e instanceof SnapshotSchemaError) {
        return err({
          kind: "HandlerError",
          operation: "chat.publish",
          message: e.message,
        });
      }
      throw e;
    }

    const result = await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "chat.publish",
      description: `chat.publish title=${session.title}`,
      entities,
    });

    await tx.execute(sql`
      UPDATE chat_sessions SET published_at = now()
      WHERE id = ${input.chatSessionId}::uuid
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "chat.publish",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `entities=${total}`,
    });

    return ok({ siteSnapshotId: result.siteSnapshotId, entityCount: total });
  },
});
