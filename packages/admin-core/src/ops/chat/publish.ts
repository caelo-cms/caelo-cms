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
 *
 * v0.7.0 — the entity-promotion loop is shared with chat.merge_to_main
 * via `mergeBranchSnapshotsToMain`. chat.publish layers the
 * already-published guard + published_at stamp + lock release on top of
 * the shared merge. chat.merge_to_main does just the merge so the
 * /edit Stage button can re-promote a still-open chat as many times as
 * the operator wants without locking the session.
 */

import { defineOperation } from "@caelo-cms/query-api";
import type { ChatPublishInput, ExecutionContext } from "@caelo-cms/shared";
import { chatPublishInput, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { releaseChatLocks } from "../../locks.js";
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

interface SessionRow {
  chat_branch_id: string;
  published_at: string | Date | null;
  title: string;
}

interface MergeOptions {
  /**
   * Audit op name + snapshot opKind. Both chat.publish and
   * chat.merge_to_main flow through the helper; the audit + snapshot
   * description carry their respective op names.
   */
  readonly opKind: "chat.publish" | "chat.merge_to_main";
  /**
   * chat.publish: skip entities the operator already published from the
   * same branch (partial-publish history). chat.merge_to_main: do NOT
   * skip — re-merge whatever is currently latest in the branch, since
   * the operator may have edited the same entity again after the prior
   * stage and we want the freshest state to ship.
   */
  readonly skipAlreadyPublished: boolean;
  /**
   * chat.publish: honour the 'staged' picker (only entities the
   * operator marked ready). chat.merge_to_main: ignore — Stage in /edit
   * promotes everything in the branch (the dropdown's per-kind filter
   * runs at production-deploy time, not at merge time).
   */
  readonly honourStageFilter: boolean;
  /**
   * chat.publish: record one mark per merged entity so subsequent
   * full-publish calls skip already-shipped entities. chat.merge_to_main:
   * skip the marks insert — the merge is part of an iterative Stage
   * loop, and recording a 'published' mark here would block the next
   * Stage from re-promoting follow-up edits to the same entity.
   */
  readonly recordPublishMarks: boolean;
}

interface MergeResult {
  readonly siteSnapshotId: string | null;
  readonly entityCount: number;
  readonly session: SessionRow;
  readonly includeAll: boolean;
}

/**
 * Shared merge step used by both chat.publish (the publish-boundary
 * op) and chat.merge_to_main (the re-stageable promote op). Pulls the
 * latest entity-state snapshot per kind from the branch, emits them as
 * main snapshots, and replays the writes that the chat-branched
 * handlers deliberately skipped (page_module_content updates,
 * page_modules rewrites, structured_set blob promotion, page upserts,
 * module updates).
 *
 * Callers layer their op-specific behavior on top: chat.publish stamps
 * published_at + releases locks + writes the 'published' mark;
 * chat.merge_to_main does none of that and is safe to call again.
 */
export async function mergeBranchSnapshotsToMain(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: ExecutionContext,
  input: ChatPublishInput,
  options: MergeOptions,
): Promise<
  | { ok: true; value: MergeResult }
  | {
      ok: false;
      error: { kind: "HandlerError"; operation: string; message: string };
    }
> {
  const sessionRows = (await tx.execute(sql`
    SELECT chat_branch_id::text AS chat_branch_id, published_at, title
    FROM chat_sessions
    WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
    LIMIT 1
  `)) as unknown as SessionRow[];
  const session = sessionRows[0];
  if (!session) {
    return {
      ok: false,
      error: { kind: "HandlerError", operation: options.opKind, message: "session not found" },
    };
  }

  type Row = { entity_id: string; state: unknown };
  const filterByKind = (
    kind:
      | "module"
      | "template"
      | "page"
      | "pageLayout"
      | "pageModuleContent"
      | "structuredSet"
      | "contentInstance",
  ) => input.entities?.filter((e) => e.kind === kind).map((e) => e.entityId) ?? null;
  const wantModules = filterByKind("module");
  const wantTemplates = filterByKind("template");
  const wantPages = filterByKind("page");
  const wantLayouts = filterByKind("pageLayout");
  const wantContent = filterByKind("pageModuleContent");
  const wantStructuredSets = filterByKind("structuredSet");
  const wantContentInstances = filterByKind("contentInstance");
  const includeAll = input.entities === undefined;

  const inFilter = (ids: readonly string[] | null) =>
    ids === null
      ? sql``
      : sql`AND entity_id_text IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const notYetPublished = (
    kind:
      | "module"
      | "template"
      | "page"
      | "pageLayout"
      | "pageModuleContent"
      | "structuredSet"
      | "contentInstance",
  ) =>
    options.skipAlreadyPublished
      ? sql`
          AND entity_id_text NOT IN (
            SELECT entity_id::text FROM chat_branch_publish_marks
            WHERE chat_branch_id = ${session.chat_branch_id}::uuid
              AND entity_kind = ${kind}
              AND stage_state = 'published'
          )
        `
      : sql``;
  const stagedCountRows = (await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM chat_branch_publish_marks
    WHERE chat_branch_id = ${session.chat_branch_id}::uuid
      AND stage_state = 'staged'
  `)) as unknown as { n: number }[];
  const hasStagedMarks = (stagedCountRows[0]?.n ?? 0) > 0;
  const stageFilter = (
    kind:
      | "module"
      | "template"
      | "page"
      | "pageLayout"
      | "pageModuleContent"
      | "structuredSet"
      | "contentInstance",
  ) =>
    options.honourStageFilter && includeAll && hasStagedMarks
      ? sql`
          AND entity_id_text IN (
            SELECT entity_id::text FROM chat_branch_publish_marks
            WHERE chat_branch_id = ${session.chat_branch_id}::uuid
              AND entity_kind = ${kind}
              AND stage_state = 'staged'
          )
        `
      : sql``;

  const moduleRows =
    !includeAll && (wantModules?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS entity_id, ms.state, ms.module_id::text AS entity_id_text
      FROM module_snapshots ms
      JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY ms.module_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("module")} ${stageFilter("module")} ${inFilter(includeAll ? null : (wantModules ?? []))}
  `)) as unknown as Row[]);
  const templateRows =
    !includeAll && (wantTemplates?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (ts.template_id) ts.template_id::text AS entity_id, ts.state, ts.template_id::text AS entity_id_text
      FROM template_snapshots ts
      JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY ts.template_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("template")} ${stageFilter("template")} ${inFilter(includeAll ? null : (wantTemplates ?? []))}
  `)) as unknown as Row[]);
  const pageRows =
    !includeAll && (wantPages?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS entity_id, ps.state, ps.page_id::text AS entity_id_text
      FROM page_snapshots ps
      JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY ps.page_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("page")} ${stageFilter("page")} ${inFilter(includeAll ? null : (wantPages ?? []))}
  `)) as unknown as Row[]);
  const layoutRows =
    !includeAll && (wantLayouts?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (pls.page_id) pls.page_id::text AS entity_id, pls.state, pls.page_id::text AS entity_id_text
      FROM page_layout_snapshots pls
      JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY pls.page_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("pageLayout")} ${stageFilter("pageLayout")} ${inFilter(includeAll ? null : (wantLayouts ?? []))}
  `)) as unknown as Row[]);

  const contentRows =
    !includeAll && (wantContent?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (pmcs.page_module_content_id)
             pmcs.page_module_content_id::text AS entity_id,
             pmcs.state,
             pmcs.page_module_content_id::text AS entity_id_text
      FROM page_module_content_snapshots pmcs
      JOIN site_snapshots ss ON ss.id = pmcs.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY pmcs.page_module_content_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("pageModuleContent")} ${stageFilter("pageModuleContent")} ${inFilter(includeAll ? null : (wantContent ?? []))}
  `)) as unknown as Row[]);

  const structuredSetRows =
    !includeAll && (wantStructuredSets?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (sss.structured_set_id)
             sss.structured_set_id::text AS entity_id,
             sss.state,
             sss.structured_set_id::text AS entity_id_text
      FROM structured_set_snapshots sss
      JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY sss.structured_set_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("structuredSet")} ${stageFilter("structuredSet")} ${inFilter(includeAll ? null : (wantStructuredSets ?? []))}
  `)) as unknown as Row[]);

  // v0.12.0 — content_instances merge.
  const contentInstanceRows =
    !includeAll && (wantContentInstances?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (cis.content_instance_id)
             cis.content_instance_id::text AS entity_id,
             cis.state,
             cis.content_instance_id::text AS entity_id_text
      FROM content_instance_snapshots cis
      JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
      WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid
      ORDER BY cis.content_instance_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("contentInstance")} ${stageFilter("contentInstance")} ${inFilter(includeAll ? null : (wantContentInstances ?? []))}
  `)) as unknown as Row[]);

  const total =
    moduleRows.length +
    templateRows.length +
    pageRows.length +
    layoutRows.length +
    contentRows.length +
    structuredSetRows.length +
    contentInstanceRows.length;
  if (total === 0) {
    return { ok: true, value: { siteSnapshotId: null, entityCount: 0, session, includeAll } };
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
      ...contentRows.map((r): SnapshotEntity => {
        const raw = parseSnapshotState(r.state) as {
          schemaVersion: 1;
          pageId: string;
          blockName: string;
          position: number;
          contentValues: Record<string, unknown>;
          version: number;
        };
        return { kind: "pageModuleContent", entityId: r.entity_id, state: raw };
      }),
      ...structuredSetRows.map((r): SnapshotEntity => {
        const raw = parseSnapshotState(r.state) as {
          schemaVersion: 1;
          kind: string;
          slug: string;
          displayName: string;
          items: readonly unknown[];
          deletedAt: string | null;
        };
        return { kind: "structuredSet", entityId: r.entity_id, state: raw };
      }),
      ...contentInstanceRows.map((r): SnapshotEntity => {
        const raw = parseSnapshotState(r.state) as {
          schemaVersion: 1;
          moduleId: string;
          slug: string | null;
          displayName: string | null;
          values: Record<string, unknown>;
          version: number;
          deletedAt: string | null;
        };
        return { kind: "contentInstance", entityId: r.entity_id, state: raw };
      }),
    ];
  } catch (e) {
    if (e instanceof SnapshotSchemaError) {
      return {
        ok: false,
        error: { kind: "HandlerError", operation: options.opKind, message: e.message },
      };
    }
    throw e;
  }

  const result = await emitSnapshot(tx, {
    actorId: ctx.actorId,
    opKind: options.opKind,
    description: includeAll
      ? `${options.opKind} title=${session.title}`
      : `${options.opKind} (partial) title=${session.title} entities=${total}`,
    entities,
  });

  // Replay the live-table writes that chat-branched handlers deliberately
  // skip (per kind, the reason is documented at the call site of the
  // skip in the originating op).
  for (const e of entities) {
    if (e.kind === "pageModuleContent") {
      const valuesJson = JSON.stringify(e.state.contentValues);
      await tx.execute(sql`
        UPDATE page_module_content
        SET content_values = ${valuesJson}::jsonb,
            version = version + 1,
            updated_at = now()
        WHERE id = ${e.entityId}::uuid
      `);
    } else if (e.kind === "structuredSet") {
      const itemsJson = JSON.stringify(e.state.items);
      await tx.execute(sql`
        UPDATE structured_sets
        SET items = ${itemsJson}::text::jsonb,
            display_name = ${e.state.displayName},
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${e.entityId}::uuid
      `);
    } else if (e.kind === "page") {
      // v0.9.0 — pages.create now branches; merge UPSERTs the live row
      // AND clears chat_branch_id to graduate to main.
      await tx.execute(sql`
        INSERT INTO pages (id, slug, locale, name, title, template_id, status, deleted_at, version, chat_branch_id)
        VALUES (
          ${e.entityId}::uuid,
          ${e.state.slug},
          ${e.state.locale},
          ${e.state.title},
          ${e.state.title},
          ${e.state.templateId}::uuid,
          ${e.state.status},
          ${e.state.deletedAt ? sql`now()` : sql`NULL`},
          ${e.state.version},
          NULL
        )
        ON CONFLICT (id) DO UPDATE SET
          slug           = EXCLUDED.slug,
          title          = EXCLUDED.title,
          template_id    = EXCLUDED.template_id,
          status         = EXCLUDED.status,
          deleted_at     = EXCLUDED.deleted_at,
          chat_branch_id = NULL,
          version        = pages.version + 1,
          updated_at     = now()
      `);
    } else if (e.kind === "pageLayout") {
      // v0.12.0 — page_modules now carries content_instance_id (NOT NULL)
      // and sync_mode. Producers (pages.set_modules) write the placement
      // metadata into state.blocks[i].placements. Older snapshots
      // (pre-v0.12, replay only) carry only moduleIds — for those, mint
      // fresh unsynced content_instances per placement so the FK is
      // satisfied; the content stays at module field defaults.
      await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${e.entityId}::uuid`);
      for (const b of e.state.blocks) {
        if (b.placements && b.placements.length > 0) {
          let pos = 0;
          for (const p of b.placements) {
            await tx.execute(sql`
              INSERT INTO page_modules
                (page_id, block_name, position, module_id, content_instance_id, sync_mode)
              VALUES (
                ${e.entityId}::uuid,
                ${b.blockName},
                ${pos},
                ${p.moduleId}::uuid,
                ${p.contentInstanceId}::uuid,
                ${p.syncMode}
              )
            `);
            pos += 1;
          }
        } else {
          // Pre-v0.12 snapshot fallback — mint fresh content_instances
          // for replay so the new FK is satisfied.
          let pos = 0;
          for (const mid of b.moduleIds) {
            const minted = (await tx.execute(sql`
              INSERT INTO content_instances (module_id, "values")
              VALUES (${mid}::uuid, '{}'::jsonb)
              RETURNING id::text AS id
            `)) as unknown as { id: string }[];
            const newCiId = minted[0]?.id;
            if (!newCiId) {
              throw new Error(
                `publish: failed to mint content_instance for legacy pageLayout snapshot (page=${e.entityId} block=${b.blockName} pos=${pos})`,
              );
            }
            await tx.execute(sql`
              INSERT INTO page_modules
                (page_id, block_name, position, module_id, content_instance_id, sync_mode)
              VALUES (
                ${e.entityId}::uuid,
                ${b.blockName},
                ${pos},
                ${mid}::uuid,
                ${newCiId}::uuid,
                'unsynced'
              )
            `);
            pos += 1;
          }
        }
      }
      await tx.execute(sql`
        UPDATE pages SET updated_at = now(), version = version + 1
        WHERE id = ${e.entityId}::uuid
      `);
    } else if (e.kind === "module") {
      // v0.9.0 — also clears chat_branch_id so branched-create
      // modules graduate to main on merge.
      await tx.execute(sql`
        UPDATE modules
        SET slug = ${e.state.slug},
            display_name = ${e.state.displayName},
            html = ${e.state.html},
            css = ${e.state.css},
            js = ${e.state.js},
            fields = ${JSON.stringify(e.state.fields)}::text::jsonb,
            deleted_at = ${e.state.deletedAt ? sql`now()` : sql`NULL`},
            chat_branch_id = NULL,
            updated_at = now()
        WHERE id = ${e.entityId}::uuid
      `);
    } else if (e.kind === "template") {
      // v0.9.0 — template entity merge case (previously silently
      // dropped). TemplateState doesn't carry layout_id (the binding
      // lives only on the live row); the live UPDATE / branched
      // INSERT already set it, so merge just replays the editable
      // fields + clears chat_branch_id.
      await tx.execute(sql`
        UPDATE templates
        SET slug = ${e.state.slug},
            display_name = ${e.state.displayName},
            html = ${e.state.html},
            css = ${e.state.css},
            deleted_at = ${e.state.deletedAt ? sql`now()` : sql`NULL`},
            chat_branch_id = NULL,
            updated_at = now()
        WHERE id = ${e.entityId}::uuid
      `);
    } else if (e.kind === "contentInstance") {
      // v0.12.0 — content_instances merge: UPSERT the live row + clear
      // chat_branch_id so branched-create rows graduate to main. Mirrors
      // the modules merge shape. The content_instances row may already
      // exist on main (the chat edited a shared row) OR have been
      // branched-created by this chat (the row is new and currently tagged
      // with chat_branch_id).
      const valuesJson = JSON.stringify(e.state.values);
      await tx.execute(sql`
        INSERT INTO content_instances
          (id, module_id, slug, display_name, "values", version, deleted_at, chat_branch_id)
        VALUES (
          ${e.entityId}::uuid,
          ${e.state.moduleId}::uuid,
          ${e.state.slug},
          ${e.state.displayName},
          ${valuesJson}::jsonb,
          ${e.state.version},
          ${e.state.deletedAt ? sql`now()` : sql`NULL`},
          NULL
        )
        ON CONFLICT (id) DO UPDATE SET
          slug = EXCLUDED.slug,
          display_name = EXCLUDED.display_name,
          "values" = EXCLUDED."values",
          version = EXCLUDED.version,
          deleted_at = EXCLUDED.deleted_at,
          chat_branch_id = NULL,
          updated_at = now(),
          updated_by = ${ctx.actorId}::uuid
      `);
    }
  }

  // v0.9.0 — bulk clear chat_branch_id for any branched-create layouts
  // on this chat's branch. Layouts emit snapshots with entities=[] so
  // the per-entity replay loop above never sees them; query the live
  // table directly. Same for any layout entities the operator's filter
  // doesn't already cover via the replay path.
  if (includeAll) {
    // Honor includeAll only — partial-merge with entities filter doesn't
    // sweep layouts because we have no way to map a layout id into the
    // entities[] filter today (layouts.create snapshot carries no
    // entity row). Full-merge clears everything branched to this chat.
    await tx.execute(sql`
      UPDATE layouts SET chat_branch_id = NULL
      WHERE chat_branch_id = ${session.chat_branch_id}::uuid
    `);
  }

  if (options.recordPublishMarks) {
    for (const e of entities) {
      await tx.execute(sql`
        INSERT INTO chat_branch_publish_marks
          (chat_branch_id, entity_kind, entity_id, site_snapshot_id)
        VALUES (
          ${session.chat_branch_id}::uuid,
          ${e.kind},
          ${e.entityId}::uuid,
          ${result.siteSnapshotId}::uuid
        )
        ON CONFLICT DO NOTHING
      `);
    }
  }

  return {
    ok: true,
    value: { siteSnapshotId: result.siteSnapshotId, entityCount: total, session, includeAll },
  };
}

export const publishChatSessionOp = defineOperation({
  name: "chat.publish",
  // Why human-only: publish is a chat-keyed publish-boundary decision; AI proposes via the existing flow.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: chatPublishInput,
  output: z.object({
    siteSnapshotId: z.string().nullable(),
    entityCount: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    // Pre-merge guard — chat.publish is the boundary that closes the
    // session, so refuse if it's already closed. (chat.merge_to_main is
    // the re-stageable variant for /edit's Stage button and is exempt.)
    const guardRows = (await tx.execute(sql`
      SELECT published_at
      FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
      LIMIT 1
    `)) as unknown as { published_at: string | Date | null }[];
    const guardRow = guardRows[0];
    if (!guardRow) {
      return err({
        kind: "HandlerError",
        operation: "chat.publish",
        message: "session not found",
      });
    }
    if (guardRow.published_at !== null) {
      return err({
        kind: "HandlerError",
        operation: "chat.publish",
        message: "chat already published",
      });
    }

    const merged = await mergeBranchSnapshotsToMain(tx, ctx, input, {
      opKind: "chat.publish",
      skipAlreadyPublished: true,
      honourStageFilter: true,
      recordPublishMarks: true,
    });
    if (!merged.ok) return err(merged.error);

    const { siteSnapshotId, entityCount, includeAll } = merged.value;

    if (entityCount === 0) {
      await tx.execute(sql`
        UPDATE chat_sessions SET published_at = now()
        WHERE id = ${input.chatSessionId}::uuid
      `);
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "chat.publish",
        input,
        succeeded: true,
        entityId: input.chatSessionId,
        resultSummary: "no-op (empty branch)",
      });
      return ok({ siteSnapshotId: null, entityCount: 0 });
    }

    if (includeAll) {
      await tx.execute(sql`
        UPDATE chat_sessions SET published_at = now()
        WHERE id = ${input.chatSessionId}::uuid
      `);
      // v0.5.0 — release every per-entity lock held by this chat once
      // it's fully published. Partial publishes keep their locks so
      // subsequent writes against the same entities stay scoped to
      // this chat.
      await releaseChatLocks(tx, input.chatSessionId);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.publish",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: includeAll ? `entities=${entityCount}` : `partial entities=${entityCount}`,
    });

    return ok({ siteSnapshotId, entityCount });
  },
});

/**
 * v0.7.0 — Stage button companion. Merges the chat branch into main
 * the same way chat.publish does, but WITHOUT closing the session: no
 * published_at stamp, no lock release, no 'published' marks. Safe to
 * call repeatedly as the operator iterates on the same chat — each
 * call re-promotes whatever is currently latest in the branch so
 * staging reflects the live preview state 1:1.
 *
 * Use chat.publish (not this op) for the publish-boundary decision
 * that ends a chat session and ships to production.
 */
export const mergeChatToMainOp = defineOperation({
  name: "chat.merge_to_main",
  // Why human-only: same boundary as chat.publish — the operator owns the
  // decision to ship a merge, even when re-stageable.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: chatPublishInput,
  output: z.object({
    siteSnapshotId: z.string().nullable(),
    entityCount: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const merged = await mergeBranchSnapshotsToMain(tx, ctx, input, {
      opKind: "chat.merge_to_main",
      skipAlreadyPublished: false,
      honourStageFilter: false,
      recordPublishMarks: false,
    });
    if (!merged.ok) return err(merged.error);

    const { siteSnapshotId, entityCount, includeAll } = merged.value;

    // v0.10.8 — stamp `last_staged_at` so chat.branch_change_count /
    // branch_edited_entities / list_pending_changes can filter out
    // already-merged snapshots. Without this, the toolbar's pending-
    // changes pill stays at the chat's lifetime total after Stage
    // instead of resetting to 0.
    await tx.execute(sql`
      UPDATE chat_sessions SET last_staged_at = now()
      WHERE id = ${input.chatSessionId}::uuid
    `);

    // v0.10.19 — release per-entity locks at Stage. Pre-v0.10.19 only
    // chat.publish + chat.archive_session released locks; chat.merge_to_main
    // didn't. After Stage, branched edits are in main and the chat's
    // pending-count drops to 0 — the Stage button + Publish button both
    // disappear from the UI. But the lock persisted, so other chats
    // editing the same page hit "page X is busy in another chat
    // ('Live edit')" with no way to release it through the UI
    // (nothing left to publish). Stage is the merge-to-main boundary;
    // post-merge, the lock's purpose (prevent divergent unmerged
    // edits) no longer applies. Re-acquisition is automatic if the
    // same chat keeps editing the entity afterward (atomic upsert
    // in checkAndAcquireEntityLock).
    await releaseChatLocks(tx, input.chatSessionId);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.merge_to_main",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: includeAll ? `entities=${entityCount}` : `partial entities=${entityCount}`,
    });

    return ok({ siteSnapshotId, entityCount });
  },
});
