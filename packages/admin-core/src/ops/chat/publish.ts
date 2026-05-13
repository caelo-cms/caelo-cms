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

import { defineOperation } from "@caelo-cms/query-api";
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
    //
    // Partial-publish (P5.2 #5): if `input.entities` is set, narrow the
    // per-kind id list to that subset; the unselected entities stay on
    // the branch for a future chat.publish call. Empty arrays are
    // collapsed to "no rows" so the SQL doesn't see an empty IN ().
    type Row = { entity_id: string; state: unknown };
    const filterByKind = (
      kind: "module" | "template" | "page" | "pageLayout" | "pageModuleContent" | "structuredSet",
    ) => input.entities?.filter((e) => e.kind === kind).map((e) => e.entityId) ?? null;
    const wantModules = filterByKind("module");
    const wantTemplates = filterByKind("template");
    const wantPages = filterByKind("page");
    const wantLayouts = filterByKind("pageLayout");
    const wantContent = filterByKind("pageModuleContent");
    const wantStructuredSets = filterByKind("structuredSet");
    const includeAll = input.entities === undefined;

    // For each entity kind, pull the latest branch snapshot per entity,
    // then exclude entities the user already published from this branch
    // (chat_branch_publish_marks). When `entities` is set, narrow further
    // to the requested ids.
    const inFilter = (ids: readonly string[] | null) =>
      ids === null
        ? sql``
        : sql`AND entity_id_text IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`;
    // v0.5.0 — only entities marked `stage_state='staged'` are merged.
    // Pre-v0.5.0 marks default to 'published' (existing behavior); 'pending'
    // means "snapshot exists but operator hasn't clicked Stage yet" — those
    // stay on the branch for the next publish.
    const notYetPublished = (
      kind: "module" | "template" | "page" | "pageLayout" | "pageModuleContent" | "structuredSet",
    ) => sql`
      AND entity_id_text NOT IN (
        SELECT entity_id::text FROM chat_branch_publish_marks
        WHERE chat_branch_id = ${session.chat_branch_id}::uuid
          AND entity_kind = ${kind}
          AND stage_state = 'published'
      )
    `;
    /**
     * v0.5.0 — when the operator hasn't passed an explicit `entities[]`,
     * include only entities that are currently 'staged'. This is the
     * Split-button + picker flow: pick → stage → publish. Operator
     * passing entities[] explicitly bypasses the stage filter so
     * scripted / direct publish paths keep working unchanged.
     *
     * Backward-compat: if the branch has ZERO 'staged' marks (operator
     * never used the picker), fall through to the pre-v0.5.0 path of
     * publishing every pending entity. This preserves the existing
     * /content/chat publish button + AI workflow.
     */
    const stagedCountRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM chat_branch_publish_marks
      WHERE chat_branch_id = ${session.chat_branch_id}::uuid
        AND stage_state = 'staged'
    `)) as unknown as { n: number }[];
    const hasStagedMarks = (stagedCountRows[0]?.n ?? 0) > 0;
    const stageFilter = (
      kind: "module" | "template" | "page" | "pageLayout" | "pageModuleContent" | "structuredSet",
    ) =>
      includeAll && hasStagedMarks
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

    // v0.4.0 — page_module_content snapshots ride the same branch-publish
    // path. Each entity_id here is a `page_module_content.id`. The merge
    // step below updates the live row in addition to re-emitting the
    // snapshot, because content writes go to branch-only (live is not
    // touched at write time when ctx.chatBranchId is set).
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

    // v0.5.3 — structured_set snapshots. Live `items` were NOT updated at
    // chat-time when ctx.chatBranchId was set; publish promotes them here.
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

    const total =
      moduleRows.length +
      templateRows.length +
      pageRows.length +
      layoutRows.length +
      contentRows.length +
      structuredSetRows.length;
    if (total === 0) {
      // Nothing happened in the branch — mark published anyway so the
      // session is closed; no merged snapshot.
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
        // v0.4.0 — page_module_content. We trust the branch-snapshot
        // state shape here (written by our own op a moment ago); no
        // upgrade step needed since v0.4.0 is the initial version.
        ...contentRows.map((r): SnapshotEntity => {
          const raw = parseSnapshotState(r.state) as {
            schemaVersion: 1;
            pageId: string;
            blockName: string;
            position: number;
            contentValues: Record<string, unknown>;
            version: number;
          };
          return {
            kind: "pageModuleContent",
            entityId: r.entity_id,
            state: raw,
          };
        }),
        // v0.5.3 — structuredSet whole-blob state. Trust the branch
        // snapshot shape (written by our own op); no upgrade step.
        ...structuredSetRows.map((r): SnapshotEntity => {
          const raw = parseSnapshotState(r.state) as {
            schemaVersion: 1;
            kind: string;
            slug: string;
            displayName: string;
            items: readonly unknown[];
            deletedAt: string | null;
          };
          return {
            kind: "structuredSet",
            entityId: r.entity_id,
            state: raw,
          };
        }),
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
      description: includeAll
        ? `chat.publish title=${session.title}`
        : `chat.publish (partial) title=${session.title} entities=${total}`,
      entities,
    });

    // v0.4.0 — page_module_content writes go to branch-only at
    // chat-time; publish must promote them into the live table here.
    // Other kinds (module/template/page/pageLayout) already wrote live
    // at chat-time (pre-v0.4.0 behavior unchanged) so they don't need
    // a re-write step.
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
        // v0.5.3 — live items[] were left untouched at chat-time. Promote
        // the staged whole-blob into live now.
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
        // v0.5.3 — branched pages.update/delete skipped the live UPDATE.
        // v0.5.7 — branched pages.create skipped the live INSERT too.
        // Upsert by id covers both: existing rows get the patch; new
        // branched-created pages get materialised here.
        await tx.execute(sql`
          INSERT INTO pages (id, slug, locale, name, title, template_id, status, deleted_at, version)
          VALUES (
            ${e.entityId}::uuid,
            ${e.state.slug},
            ${e.state.locale},
            ${e.state.title},
            ${e.state.title},
            ${e.state.templateId}::uuid,
            ${e.state.status},
            ${e.state.deletedAt ? sql`now()` : sql`NULL`},
            ${e.state.version}
          )
          ON CONFLICT (id) DO UPDATE SET
            slug        = EXCLUDED.slug,
            title       = EXCLUDED.title,
            template_id = EXCLUDED.template_id,
            status      = EXCLUDED.status,
            deleted_at  = EXCLUDED.deleted_at,
            version     = pages.version + 1,
            updated_at  = now()
        `);
      } else if (e.kind === "pageLayout") {
        // v0.5.3 — branched pages.set_modules skipped the page_modules
        // rewrite. Replay it now from the staged blocks.
        await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${e.entityId}::uuid`);
        for (const b of e.state.blocks) {
          let pos = 0;
          for (const mid of b.moduleIds) {
            await tx.execute(sql`
              INSERT INTO page_modules (page_id, block_name, position, module_id)
              VALUES (${e.entityId}::uuid, ${b.blockName}, ${pos}, ${mid}::uuid)
            `);
            pos += 1;
          }
        }
        await tx.execute(sql`
          UPDATE pages SET updated_at = now(), version = version + 1
          WHERE id = ${e.entityId}::uuid
        `);
      } else if (e.kind === "module") {
        // v0.5.1 — branched modules.update/delete skipped the live row.
        // Promote here.
        await tx.execute(sql`
          UPDATE modules
          SET slug = ${e.state.slug},
              display_name = ${e.state.displayName},
              html = ${e.state.html},
              css = ${e.state.css},
              js = ${e.state.js},
              fields = ${JSON.stringify(e.state.fields)}::text::jsonb,
              deleted_at = ${e.state.deletedAt ? sql`now()` : sql`NULL`},
              updated_at = now()
          WHERE id = ${e.entityId}::uuid
        `);
      }
    }

    // Mark every published entity so subsequent publishes (with no filter)
    // skip them — partial publish would otherwise re-pick already-shipped
    // entities on the next call.
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

    // Only stamp published_at on a full publish — partial publishes leave
    // the session open so the editor can continue working on the
    // unselected branch entities and ship them later.
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
      resultSummary: includeAll ? `entities=${total}` : `partial entities=${total}`,
    });

    return ok({ siteSnapshotId: result.siteSnapshotId, entityCount: total });
  },
});
