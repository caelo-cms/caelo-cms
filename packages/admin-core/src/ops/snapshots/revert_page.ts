// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, revertPageInput } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  emitSnapshot,
  loadPageLayoutState,
  loadPageState,
  parseAndUpgradePageLayoutState,
  parseAndUpgradePageState,
  parseSnapshotState,
  SnapshotSchemaError,
} from "../../snapshots/index.js";

/**
 * Restores both the page metadata (from page_snapshots) and the page layout
 * (from page_layout_snapshots) from a single site_snapshots id. Either side
 * may be absent in the snapshot — pages.update emits only page_snapshots,
 * pages.set_modules emits only page_layout_snapshots — so the revert tries
 * each independently.
 */
export const revertPageOp = defineOperation({
  name: "snapshots.revert_page",
  // Why human-only: Owner-only — page revert; AI proposes via chat-keyed Undo path.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: revertPageInput,
  output: z.object({ siteSnapshotId: z.string() }),
  handler: async (ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT state FROM page_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
        AND page_id = ${input.pageId}::uuid
      LIMIT 1
    `)) as unknown as { state: unknown }[];
    const layoutRows = (await tx.execute(sql`
      SELECT state FROM page_layout_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
        AND page_id = ${input.pageId}::uuid
      LIMIT 1
    `)) as unknown as { state: unknown }[];

    if (pageRows.length === 0 && layoutRows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.revert_page",
        message: "no page snapshot for that (snapshotId, pageId) pair",
      });
    }

    if (pageRows[0]) {
      let target: ReturnType<typeof parseAndUpgradePageState>;
      try {
        target = parseAndUpgradePageState(parseSnapshotState(pageRows[0].state));
      } catch (e) {
        if (e instanceof SnapshotSchemaError) {
          return err({
            kind: "HandlerError",
            operation: "snapshots.revert_page",
            message: e.message,
          });
        }
        throw e;
      }
      await tx.execute(sql`
        UPDATE pages SET
          slug = ${target.slug},
          locale = ${target.locale},
          title = ${target.title},
          template_id = ${target.templateId}::uuid,
          status = ${target.status},
          deleted_at = ${target.deletedAt},
          updated_at = now(),
          version = version + 1
        WHERE id = ${input.pageId}::uuid
      `);
    }

    if (layoutRows[0]) {
      let target: ReturnType<typeof parseAndUpgradePageLayoutState>;
      try {
        target = parseAndUpgradePageLayoutState(parseSnapshotState(layoutRows[0].state));
      } catch (e) {
        if (e instanceof SnapshotSchemaError) {
          return err({
            kind: "HandlerError",
            operation: "snapshots.revert_page",
            message: e.message,
          });
        }
        throw e;
      }
      // v0.12.0 — page_modules now carries content_instance_id NOT NULL.
      // Prefer the snapshot's `placements` array (v0.12+ writers); fall
      // back to minting fresh unsynced content_instances for pre-v0.12
      // snapshots whose state only carries `moduleIds`.
      await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${input.pageId}::uuid`);
      for (const block of target.blocks) {
        const placements = block.placements ?? [];
        if (placements.length > 0) {
          let position = 0;
          for (const p of placements) {
            await tx.execute(sql`
              INSERT INTO page_modules
                (page_id, block_name, position, module_id, content_instance_id, sync_mode)
              VALUES (
                ${input.pageId}::uuid,
                ${block.blockName},
                ${position},
                ${p.moduleId}::uuid,
                ${p.contentInstanceId}::uuid,
                ${p.syncMode}
              )
            `);
            position += 1;
          }
        } else {
          let position = 0;
          for (const moduleId of block.moduleIds) {
            const minted = (await tx.execute(sql`
              INSERT INTO content_instances (module_id, "values")
              VALUES (${moduleId}::uuid, '{}'::jsonb)
              RETURNING id::text AS id
            `)) as unknown as { id: string }[];
            const newCiId = minted[0]?.id;
            if (!newCiId) {
              throw new Error(
                `revert_page: failed to mint content_instance for legacy pageLayout snapshot (page=${input.pageId} block=${block.blockName} pos=${position})`,
              );
            }
            await tx.execute(sql`
              INSERT INTO page_modules
                (page_id, block_name, position, module_id, content_instance_id, sync_mode)
              VALUES (
                ${input.pageId}::uuid,
                ${block.blockName},
                ${position},
                ${moduleId}::uuid,
                ${newCiId}::uuid,
                'unsynced'
              )
            `);
            position += 1;
          }
        }
      }
      // Bump version when only the layout came back.
      if (!pageRows[0]) {
        await tx.execute(sql`
          UPDATE pages SET updated_at = now(), version = version + 1
          WHERE id = ${input.pageId}::uuid
        `);
      }
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "snapshots.revert_page",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `revert-of=${input.snapshotId.slice(0, 8)}`,
    });

    // Emit fresh snapshot capturing whichever side(s) were restored.
    const newPageState = await loadPageState(tx, input.pageId);
    const newLayoutState = layoutRows[0] ? await loadPageLayoutState(tx, input.pageId) : null;
    const entities: import("../../snapshots/index.js").SnapshotEntity[] = [];
    if (newPageState) entities.push({ kind: "page", entityId: input.pageId, state: newPageState });
    if (newLayoutState)
      entities.push({ kind: "pageLayout", entityId: input.pageId, state: newLayoutState });
    const result = await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "snapshots.revert_page",
      description: `revert page → snapshot ${input.snapshotId.slice(0, 8)}`,
      revertOf: input.snapshotId,
      entities,
    });
    return ok({ siteSnapshotId: result.siteSnapshotId });
  },
});
