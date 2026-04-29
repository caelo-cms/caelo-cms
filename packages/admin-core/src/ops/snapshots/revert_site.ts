// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { err, ok, revertSiteInput } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  emitSnapshot,
  loadModuleState,
  loadPageLayoutState,
  loadPageState,
  loadTemplateState,
  parseAndUpgradeModuleState,
  parseAndUpgradePageLayoutState,
  parseAndUpgradePageState,
  parseAndUpgradeTemplateState,
  parseSnapshotState,
  SnapshotSchemaError,
} from "../../snapshots/index.js";

/**
 * Restores every entity that has a row under the target snapshot. Atomic
 * (one tx); the new merged snapshot's revert_of points at the target.
 *
 * Per CMS_REQUIREMENTS §5: "no merge or branch support — single linear
 * history per site". The revert is appended to the timeline rather than
 * destructively rewinding it.
 */
export const revertSiteOp = defineOperation({
  name: "snapshots.revert_site",
  // Why human-only: Owner-only — atomic site-wide content rewind, large blast radius.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: revertSiteInput,
  output: z.object({ siteSnapshotId: z.string() }),
  handler: async (ctx, input, tx) => {
    const exists = (await tx.execute(sql`
      SELECT 1 FROM site_snapshots WHERE id = ${input.snapshotId}::uuid LIMIT 1
    `)) as unknown as { exists: number }[];
    if (exists.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.revert_site",
        message: "snapshot not found",
      });
    }

    type Row = { entity_id: string; state: unknown };
    const ms = (await tx.execute(sql`
      SELECT module_id::text AS entity_id, state FROM module_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];
    const ts = (await tx.execute(sql`
      SELECT template_id::text AS entity_id, state FROM template_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];
    const ps = (await tx.execute(sql`
      SELECT page_id::text AS entity_id, state FROM page_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];
    const pls = (await tx.execute(sql`
      SELECT page_id::text AS entity_id, state FROM page_layout_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];

    // Validate every state payload up-front so a schema-mismatch fails the
    // whole revert before we touch live tables — atomic semantics still hold
    // (handler is inside one tx) but failing early gives a cleaner error.
    let parsedModules: {
      entity_id: string;
      state: ReturnType<typeof parseAndUpgradeModuleState>;
    }[];
    let parsedTemplates: {
      entity_id: string;
      state: ReturnType<typeof parseAndUpgradeTemplateState>;
    }[];
    let parsedPages: { entity_id: string; state: ReturnType<typeof parseAndUpgradePageState> }[];
    let parsedLayouts: {
      entity_id: string;
      state: ReturnType<typeof parseAndUpgradePageLayoutState>;
    }[];
    try {
      parsedModules = ms.map((r) => ({
        entity_id: r.entity_id,
        state: parseAndUpgradeModuleState(parseSnapshotState(r.state)),
      }));
      parsedTemplates = ts.map((r) => ({
        entity_id: r.entity_id,
        state: parseAndUpgradeTemplateState(parseSnapshotState(r.state)),
      }));
      parsedPages = ps.map((r) => ({
        entity_id: r.entity_id,
        state: parseAndUpgradePageState(parseSnapshotState(r.state)),
      }));
      parsedLayouts = pls.map((r) => ({
        entity_id: r.entity_id,
        state: parseAndUpgradePageLayoutState(parseSnapshotState(r.state)),
      }));
    } catch (e) {
      if (e instanceof SnapshotSchemaError) {
        return err({
          kind: "HandlerError",
          operation: "snapshots.revert_site",
          message: e.message,
        });
      }
      throw e;
    }

    for (const r of parsedModules) {
      const t = r.state;
      await tx.execute(sql`
        UPDATE modules SET
          slug = ${t.slug}, display_name = ${t.displayName}, html = ${t.html},
          css = ${t.css}, js = ${t.js}, deleted_at = ${t.deletedAt}, updated_at = now()
        WHERE id = ${r.entity_id}::uuid
      `);
    }
    for (const r of parsedTemplates) {
      const t = r.state;
      await tx.execute(sql`
        UPDATE templates SET
          slug = ${t.slug}, display_name = ${t.displayName}, html = ${t.html},
          css = ${t.css}, deleted_at = ${t.deletedAt}, updated_at = now()
        WHERE id = ${r.entity_id}::uuid
      `);
      await tx.execute(sql`DELETE FROM template_blocks WHERE template_id = ${r.entity_id}::uuid`);
      for (const b of t.blocks) {
        await tx.execute(sql`
          INSERT INTO template_blocks (template_id, name, display_name, position)
          VALUES (${r.entity_id}::uuid, ${b.name}, ${b.displayName}, ${b.position})
        `);
      }
    }
    for (const r of parsedPages) {
      const t = r.state;
      await tx.execute(sql`
        UPDATE pages SET
          slug = ${t.slug}, locale = ${t.locale}, title = ${t.title},
          template_id = ${t.templateId}::uuid, status = ${t.status},
          deleted_at = ${t.deletedAt}, updated_at = now(), version = version + 1
        WHERE id = ${r.entity_id}::uuid
      `);
    }
    for (const r of parsedLayouts) {
      const t = r.state;
      await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${r.entity_id}::uuid`);
      for (const block of t.blocks) {
        let position = 0;
        for (const moduleId of block.moduleIds) {
          await tx.execute(sql`
            INSERT INTO page_modules (page_id, block_name, position, module_id)
            VALUES (${r.entity_id}::uuid, ${block.blockName}, ${position}, ${moduleId}::uuid)
          `);
          position += 1;
        }
      }
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "snapshots.revert_site",
      input,
      succeeded: true,
      entityId: input.snapshotId,
      resultSummary: `m=${ms.length},t=${ts.length},p=${ps.length},pl=${pls.length}`,
    });

    // Build fresh state for the audit snapshot. Falls back to the validated
    // target state if the live row isn't reachable (shouldn't happen — the
    // revert just wrote it — but defensive).
    const newModules = await Promise.all(
      parsedModules.map(async (r) => ({
        moduleId: r.entity_id,
        state: (await loadModuleState(tx, r.entity_id)) ?? r.state,
      })),
    );
    const newTemplates = await Promise.all(
      parsedTemplates.map(async (r) => ({
        templateId: r.entity_id,
        state: (await loadTemplateState(tx, r.entity_id)) ?? r.state,
      })),
    );
    const newPages = await Promise.all(
      parsedPages.map(async (r) => ({
        pageId: r.entity_id,
        state: (await loadPageState(tx, r.entity_id)) ?? r.state,
      })),
    );
    const newLayouts = await Promise.all(
      parsedLayouts.map(async (r) => ({
        pageId: r.entity_id,
        state: await loadPageLayoutState(tx, r.entity_id),
      })),
    );

    const entities: import("../../snapshots/index.js").SnapshotEntity[] = [
      ...newModules.map((m): import("../../snapshots/index.js").SnapshotEntity => ({
        kind: "module",
        entityId: m.moduleId,
        state: m.state,
      })),
      ...newTemplates.map((t): import("../../snapshots/index.js").SnapshotEntity => ({
        kind: "template",
        entityId: t.templateId,
        state: t.state,
      })),
      ...newPages.map((p): import("../../snapshots/index.js").SnapshotEntity => ({
        kind: "page",
        entityId: p.pageId,
        state: p.state,
      })),
      ...newLayouts.map((l): import("../../snapshots/index.js").SnapshotEntity => ({
        kind: "pageLayout",
        entityId: l.pageId,
        state: l.state,
      })),
    ];
    const result = await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "snapshots.revert_site",
      description: `revert site → snapshot ${input.snapshotId.slice(0, 8)}`,
      revertOf: input.snapshotId,
      entities,
    });
    return ok({ siteSnapshotId: result.siteSnapshotId });
  },
});
