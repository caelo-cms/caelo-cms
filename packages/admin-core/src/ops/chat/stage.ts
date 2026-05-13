// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.0 — staging ops.
 *
 *   chat.list_pending_changes — categorized read for the Stage picker
 *   chat.stage                — flips selected entity rows from
 *                               stage_state='pending' to 'staged'
 *   chat.unstage              — flips selected entity rows back to
 *                               'pending'
 *
 * Background:
 *
 *   Stage states live in `chat_branch_publish_marks.stage_state`:
 *     'pending'  — branch snapshot exists; not yet staged
 *     'staged'   — selected for next publish; visible in staging env
 *     'published'— merged to main (existing rows, pre-v0.5.0)
 *
 *   Pre-v0.5.0 a row in this table implicitly meant published; the new
 *   column defaults to 'published' so existing rows are unaffected.
 *
 *   `chat.publish` (existing op, v0.5.0 update) only merges entities
 *   whose `stage_state='staged'`. The picker UI controls what graduates
 *   from 'pending' to 'staged'; publish does the merge atomically.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

/**
 * Categorized read of every snapshot tagged with the chat's branch
 * grouped by `stage_state`. The picker shows the 'pending' subset for
 * the per-row checkboxes; the 'staged' subset shows what's already
 * queued for publish (so the operator can untick + click Unstage).
 */
const entityRefSchema = z
  .object({
    kind: z.enum([
      "module",
      "template",
      "page",
      "pageLayout",
      "pageModuleContent",
      "layout",
      "structuredSet",
      "theme",
    ]),
    entityId: z.string(),
    /** Short label for the picker row (e.g. module slug, page title). */
    label: z.string(),
    /** Optional details (e.g. block_name#position for content rows). */
    detail: z.string().optional(),
  })
  .strict();
type EntityRef = z.infer<typeof entityRefSchema>;

export const listPendingChangesOp = defineOperation({
  name: "chat.list_pending_changes",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({
    pending: z.object({
      pages: z.array(entityRefSchema),
      globals: z.array(entityRefSchema),
      lists: z.array(entityRefSchema),
    }),
    staged: z.object({
      pages: z.array(entityRefSchema),
      globals: z.array(entityRefSchema),
      lists: z.array(entityRefSchema),
    }),
  }),
  handler: async (_ctx, input, tx) => {
    const sessionRows = (await tx.execute(sql`
      SELECT chat_branch_id::text AS chat_branch_id FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid LIMIT 1
    `)) as unknown as { chat_branch_id: string }[];
    const branchId = sessionRows[0]?.chat_branch_id;
    if (!branchId) {
      return err({
        kind: "HandlerError",
        operation: "chat.list_pending_changes",
        message: "session not found",
      });
    }

    /**
     * Walk every branched snapshot table once. For each entity, ask
     * the publish-marks table what stage_state it's in (pending if no
     * mark exists yet; 'staged' if marked; 'published' if already
     * shipped and we should hide it).
     */
    type Row = { entity_id: string; label: string; detail: string | null; stage_state: string };

    // page_module_content — branch overlay rows since v0.4.0.
    const contentRows = (await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (pmcs.page_module_content_id)
          pmcs.page_module_content_id::text AS entity_id,
          pmcs.page_id::text AS page_id,
          pmcs.block_name,
          pmcs.position
        FROM page_module_content_snapshots pmcs
        JOIN site_snapshots ss ON ss.id = pmcs.site_snapshot_id
        WHERE ss.chat_branch_id = ${branchId}::uuid
        ORDER BY pmcs.page_module_content_id, ss.created_at DESC
      )
      SELECT
        l.entity_id,
        COALESCE(p.title, p.slug) AS label,
        (p.slug || ' · ' || l.block_name || '#' || l.position) AS detail,
        COALESCE(m.stage_state, 'pending') AS stage_state
      FROM latest l
      LEFT JOIN pages p ON p.id::text = l.page_id
      LEFT JOIN chat_branch_publish_marks m
        ON m.chat_branch_id = ${branchId}::uuid
       AND m.entity_kind = 'pageModuleContent'
       AND m.entity_id::text = l.entity_id
    `)) as unknown as Row[];

    // page snapshots — page metadata edits.
    const pageRows = (await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS entity_id
        FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
        WHERE ss.chat_branch_id = ${branchId}::uuid
        ORDER BY ps.page_id, ss.created_at DESC
      )
      SELECT
        l.entity_id,
        COALESCE(p.title, p.slug) AS label,
        ('/' || p.slug) AS detail,
        COALESCE(m.stage_state, 'pending') AS stage_state
      FROM latest l
      LEFT JOIN pages p ON p.id::text = l.entity_id
      LEFT JOIN chat_branch_publish_marks m
        ON m.chat_branch_id = ${branchId}::uuid
       AND m.entity_kind = 'page'
       AND m.entity_id::text = l.entity_id
    `)) as unknown as Row[];

    // pageLayout snapshots (placements).
    const layoutRows = (await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (pls.page_id) pls.page_id::text AS entity_id
        FROM page_layout_snapshots pls
        JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
        WHERE ss.chat_branch_id = ${branchId}::uuid
        ORDER BY pls.page_id, ss.created_at DESC
      )
      SELECT
        l.entity_id,
        COALESCE(p.title, p.slug) AS label,
        ('/' || p.slug || ' · placements') AS detail,
        COALESCE(m.stage_state, 'pending') AS stage_state
      FROM latest l
      LEFT JOIN pages p ON p.id::text = l.entity_id
      LEFT JOIN chat_branch_publish_marks m
        ON m.chat_branch_id = ${branchId}::uuid
       AND m.entity_kind = 'pageLayout'
       AND m.entity_id::text = l.entity_id
    `)) as unknown as Row[];

    // module + template snapshots — global category.
    const moduleRows = (await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS entity_id
        FROM module_snapshots ms
        JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
        WHERE ss.chat_branch_id = ${branchId}::uuid
        ORDER BY ms.module_id, ss.created_at DESC
      )
      SELECT
        l.entity_id,
        m.display_name AS label,
        m.slug AS detail,
        COALESCE(marks.stage_state, 'pending') AS stage_state
      FROM latest l
      LEFT JOIN modules m ON m.id::text = l.entity_id
      LEFT JOIN chat_branch_publish_marks marks
        ON marks.chat_branch_id = ${branchId}::uuid
       AND marks.entity_kind = 'module'
       AND marks.entity_id::text = l.entity_id
    `)) as unknown as Row[];

    const templateRows = (await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (ts.template_id) ts.template_id::text AS entity_id
        FROM template_snapshots ts
        JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
        WHERE ss.chat_branch_id = ${branchId}::uuid
        ORDER BY ts.template_id, ss.created_at DESC
      )
      SELECT
        l.entity_id,
        t.display_name AS label,
        t.slug AS detail,
        COALESCE(marks.stage_state, 'pending') AS stage_state
      FROM latest l
      LEFT JOIN templates t ON t.id::text = l.entity_id
      LEFT JOIN chat_branch_publish_marks marks
        ON marks.chat_branch_id = ${branchId}::uuid
       AND marks.entity_kind = 'template'
       AND marks.entity_id::text = l.entity_id
    `)) as unknown as Row[];

    // v0.5.3 — structured_set snapshots. Theme kind goes in `globals`;
    // ordered-list kinds (nav-menu / taxonomy / link-list) go in `lists`.
    const structuredSetRows = (await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (sss.structured_set_id)
          sss.structured_set_id::text AS entity_id,
          sss.state
        FROM structured_set_snapshots sss
        JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
        WHERE ss.chat_branch_id = ${branchId}::uuid
        ORDER BY sss.structured_set_id, ss.created_at DESC
      )
      SELECT
        l.entity_id,
        ss.display_name AS label,
        (ss.kind || '/' || ss.slug) AS detail,
        ss.kind AS kind,
        COALESCE(marks.stage_state, 'pending') AS stage_state
      FROM latest l
      LEFT JOIN structured_sets ss ON ss.id::text = l.entity_id
      LEFT JOIN chat_branch_publish_marks marks
        ON marks.chat_branch_id = ${branchId}::uuid
       AND marks.entity_kind = 'structuredSet'
       AND marks.entity_id::text = l.entity_id
    `)) as unknown as (Row & { kind: string })[];

    function bucketize(
      rows: Row[],
      kind: EntityRef["kind"],
    ): { pending: EntityRef[]; staged: EntityRef[] } {
      const pending: EntityRef[] = [];
      const staged: EntityRef[] = [];
      for (const r of rows) {
        const ref: EntityRef = {
          kind,
          entityId: r.entity_id,
          label: r.label ?? r.entity_id,
          ...(r.detail ? { detail: r.detail } : {}),
        };
        if (r.stage_state === "staged") staged.push(ref);
        else if (r.stage_state === "pending") pending.push(ref);
        // 'published' → drop (already shipped from this branch).
      }
      return { pending, staged };
    }

    const content = bucketize(contentRows, "pageModuleContent");
    const pages = bucketize(pageRows, "page");
    const layouts = bucketize(layoutRows, "pageLayout");
    const modules = bucketize(moduleRows, "module");
    const templates = bucketize(templateRows, "template");

    // v0.5.3 — structured_set rows split between globals (theme) and
    // lists (nav-menu / taxonomy / link-list) based on `kind`.
    const ssPendingGlobals: EntityRef[] = [];
    const ssPendingLists: EntityRef[] = [];
    const ssStagedGlobals: EntityRef[] = [];
    const ssStagedLists: EntityRef[] = [];
    for (const r of structuredSetRows) {
      const ref: EntityRef = {
        kind: "structuredSet",
        entityId: r.entity_id,
        label: r.label ?? r.entity_id,
        ...(r.detail ? { detail: r.detail } : {}),
      };
      const isList = r.kind === "nav-menu" || r.kind === "taxonomy" || r.kind === "link-list";
      if (r.stage_state === "staged") {
        (isList ? ssStagedLists : ssStagedGlobals).push(ref);
      } else if (r.stage_state === "pending") {
        (isList ? ssPendingLists : ssPendingGlobals).push(ref);
      }
    }

    return ok({
      pending: {
        pages: [...content.pending, ...pages.pending, ...layouts.pending],
        globals: [...modules.pending, ...templates.pending, ...ssPendingGlobals],
        lists: ssPendingLists,
      },
      staged: {
        pages: [...content.staged, ...pages.staged, ...layouts.staged],
        globals: [...modules.staged, ...templates.staged, ...ssStagedGlobals],
        lists: ssStagedLists,
      },
    });
  },
});

const stageInput = z
  .object({
    chatSessionId: z.string().uuid(),
    /**
     * Entities to flip pending→staged. Omit to stage ALL pending
     * entities on this chat's branch.
     */
    entities: z
      .array(
        z
          .object({
            kind: z.string(),
            entityId: z.string().uuid(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/**
 * Flip selected (or all) pending publish-marks to stage_state='staged'.
 * Inserts a mark row if one doesn't exist yet (pre-v0.5.0 branches
 * have snapshots but no marks — the mark IS the stage gesture).
 */
export const stageChatChangesOp = defineOperation({
  name: "chat.stage",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: stageInput,
  output: z.object({ staged: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    const sessionRows = (await tx.execute(sql`
      SELECT chat_branch_id::text AS chat_branch_id FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid LIMIT 1
    `)) as unknown as { chat_branch_id: string }[];
    const branchId = sessionRows[0]?.chat_branch_id;
    if (!branchId) {
      return err({
        kind: "HandlerError",
        operation: "chat.stage",
        message: "session not found",
      });
    }

    // For each (kind, entityId) in selection: upsert a publish-mark row
    // with stage_state='staged'. site_snapshot_id picks the latest
    // branch snapshot for the entity (DISTINCT ON ... ORDER BY created_at DESC).
    // No selection → stage every branched entity currently 'pending'.
    if (input.entities && input.entities.length === 0) {
      return ok({ staged: 0 });
    }

    type SnapshotPick = { entity_id: string; site_snapshot_id: string; kind: string };
    const picks: SnapshotPick[] = [];

    if (input.entities) {
      // Targeted: pick the latest branch snapshot per (kind, entityId).
      for (const e of input.entities) {
        const table = ((): string | null => {
          switch (e.kind) {
            case "module":
              return "module_snapshots";
            case "template":
              return "template_snapshots";
            case "page":
              return "page_snapshots";
            case "pageLayout":
              return "page_layout_snapshots";
            case "pageModuleContent":
              return "page_module_content_snapshots";
            case "structuredSet":
              return "structured_set_snapshots";
            default:
              return null;
          }
        })();
        if (!table) continue;
        const col = ((): string => {
          switch (e.kind) {
            case "module":
              return "module_id";
            case "template":
              return "template_id";
            case "page":
              return "page_id";
            case "pageLayout":
              return "page_id";
            case "pageModuleContent":
              return "page_module_content_id";
            case "structuredSet":
              return "structured_set_id";
            default:
              return "id";
          }
        })();
        const found = (await tx.execute(sql`
          SELECT site_snapshot_id::text AS site_snapshot_id
          FROM ${sql.raw(table)}
          JOIN site_snapshots ss ON ss.id = ${sql.raw(table)}.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid
            AND ${sql.raw(table)}.${sql.raw(col)} = ${e.entityId}::uuid
          ORDER BY ss.created_at DESC
          LIMIT 1
        `)) as unknown as { site_snapshot_id: string }[];
        const ssid = found[0]?.site_snapshot_id;
        if (ssid) {
          picks.push({ entity_id: e.entityId, site_snapshot_id: ssid, kind: e.kind });
        }
      }
    } else {
      // Stage everything pending on the branch — pull every latest
      // snapshot per entity from every branched snapshot table.
      const allLatest = (await tx.execute(sql`
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (ms.module_id)
            ms.module_id::text AS entity_id,
            'module'::text AS entity_kind,
            ms.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid
          ORDER BY ms.module_id, ss.created_at DESC
        ) m
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (ts.template_id)
            ts.template_id::text AS entity_id,
            'template'::text AS entity_kind,
            ts.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM template_snapshots ts
          JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid
          ORDER BY ts.template_id, ss.created_at DESC
        ) t
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (ps.page_id)
            ps.page_id::text AS entity_id,
            'page'::text AS entity_kind,
            ps.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM page_snapshots ps
          JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid
          ORDER BY ps.page_id, ss.created_at DESC
        ) p
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (pls.page_id)
            pls.page_id::text AS entity_id,
            'pageLayout'::text AS entity_kind,
            pls.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM page_layout_snapshots pls
          JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid
          ORDER BY pls.page_id, ss.created_at DESC
        ) pl
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (pmcs.page_module_content_id)
            pmcs.page_module_content_id::text AS entity_id,
            'pageModuleContent'::text AS entity_kind,
            pmcs.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM page_module_content_snapshots pmcs
          JOIN site_snapshots ss ON ss.id = pmcs.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid
          ORDER BY pmcs.page_module_content_id, ss.created_at DESC
        ) c
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (sss.structured_set_id)
            sss.structured_set_id::text AS entity_id,
            'structuredSet'::text AS entity_kind,
            sss.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM structured_set_snapshots sss
          JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid
          ORDER BY sss.structured_set_id, ss.created_at DESC
        ) s
      `)) as unknown as { entity_id: string; entity_kind: string; site_snapshot_id: string }[];
      for (const row of allLatest) {
        picks.push({
          entity_id: row.entity_id,
          site_snapshot_id: row.site_snapshot_id,
          kind: row.entity_kind,
        });
      }
    }

    let staged = 0;
    for (const p of picks) {
      await tx.execute(sql`
        INSERT INTO chat_branch_publish_marks
          (chat_branch_id, entity_kind, entity_id, site_snapshot_id, stage_state)
        VALUES (
          ${branchId}::uuid,
          ${p.kind},
          ${p.entity_id}::uuid,
          ${p.site_snapshot_id}::uuid,
          'staged'
        )
        ON CONFLICT (chat_branch_id, entity_kind, entity_id, site_snapshot_id) DO UPDATE
          SET stage_state = 'staged'
        WHERE chat_branch_publish_marks.stage_state = 'pending'
      `);
      staged += 1;
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.stage",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `staged=${staged}`,
    });

    return ok({ staged });
  },
});

const unstageInput = z
  .object({
    chatSessionId: z.string().uuid(),
    entities: z
      .array(
        z
          .object({
            kind: z.string(),
            entityId: z.string().uuid(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/**
 * Flip selected (or all) staged publish-marks back to stage_state='pending'.
 * Other chats' previews stop seeing these via the staged overlay (when
 * the overlay lands in v0.5.1).
 */
export const unstageChatChangesOp = defineOperation({
  name: "chat.unstage",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: unstageInput,
  output: z.object({ unstaged: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    const sessionRows = (await tx.execute(sql`
      SELECT chat_branch_id::text AS chat_branch_id FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid LIMIT 1
    `)) as unknown as { chat_branch_id: string }[];
    const branchId = sessionRows[0]?.chat_branch_id;
    if (!branchId) {
      return err({
        kind: "HandlerError",
        operation: "chat.unstage",
        message: "session not found",
      });
    }

    let unstaged = 0;
    if (input.entities && input.entities.length > 0) {
      for (const e of input.entities) {
        const r = (await tx.execute(sql`
          UPDATE chat_branch_publish_marks
          SET stage_state = 'pending'
          WHERE chat_branch_id = ${branchId}::uuid
            AND entity_kind = ${e.kind}
            AND entity_id = ${e.entityId}::uuid
            AND stage_state = 'staged'
          RETURNING 1
        `)) as unknown as unknown[];
        unstaged += r.length;
      }
    } else {
      const r = (await tx.execute(sql`
        UPDATE chat_branch_publish_marks
        SET stage_state = 'pending'
        WHERE chat_branch_id = ${branchId}::uuid AND stage_state = 'staged'
        RETURNING 1
      `)) as unknown as unknown[];
      unstaged = r.length;
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.unstage",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `unstaged=${unstaged}`,
    });

    return ok({ unstaged });
  },
});
