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

import {
  defineOperation,
  type TransactionRunner,
  textArray,
  uuidArray,
} from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  chatHeadRowsSql,
  chatPendingSql,
  type HeadChat,
  loadChatBinding,
  pendingChangeKindSql,
} from "../../draft.js";

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
      "theme",
      // Epic #1107 — shared lists (the `lists` group), their types and
      // page types (globals).
      "list",
      "listType",
      "pageType",
      // v0.12.0 — content_instance edits surface in the Stage picker.
      "contentInstance",
      // A plugin private-storage row written on the branch.
      "pluginRow",
    ]),
    entityId: z.string(),
    /** Short label for the picker row (e.g. module slug, page title). */
    label: z.string(),
    /** Optional details (e.g. block_name#position for content rows). */
    detail: z.string().optional(),
  })
  .strict();
type EntityRef = z.infer<typeof entityRefSchema>;

const refGroupsSchema = z.object({
  pages: z.array(entityRefSchema),
  globals: z.array(entityRefSchema),
  lists: z.array(entityRefSchema),
});

/** Output shape of `chat.list_pending_changes`, reused by the Open changes overview. */
export const pendingChangesSchema = z.object({
  pending: refGroupsSchema,
  staged: refGroupsSchema,
});

/** Pending (not yet staged) vs staged change refs of one chat branch. */
export type PendingChanges = z.infer<typeof pendingChangesSchema>;

export const listPendingChangesOp = defineOperation({
  name: "chat.list_pending_changes",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: pendingChangesSchema,
  handler: async (_ctx, input, tx) => {
    const binding = await loadChatBinding(tx, input.chatSessionId);
    if (!binding) {
      return err({
        kind: "HandlerError",
        operation: "chat.list_pending_changes",
        message: "session not found",
      });
    }
    return ok(await loadPendingChanges(tx, binding));
  },
});

/**
 * Categorized change refs of a chat's pending changes — the Stage
 * picker's and the Open changes overview's view of "what this chat
 * changed". One per pending entity of the chat's draft head (issue #1268,
 * PENDING_CHANGE_KINDS — the count the pill and the banner show); the
 * branch's stage marks only decide the pending vs staged bucket.
 */
export async function loadPendingChanges(
  tx: TransactionRunner,
  binding: HeadChat,
): Promise<PendingChanges> {
  const all = await loadPendingChangesFor(tx, [binding]);
  return all.get(binding.chatSessionId) ?? emptyPendingChanges();
}

function emptyPendingChanges(): PendingChanges {
  return {
    pending: { pages: [], globals: [], lists: [] },
    staged: { pages: [], globals: [], lists: [] },
  };
}

/** One labelled head entity of a chat, as {@link loadPendingChangesFor} reads it. */
interface LabelledRow {
  chat: string;
  kind: string;
  entity_id: string;
  label: string | null;
  detail: string | null;
  stage_state: string;
  description: string | null;
  op_kind: string | null;
}

/** Which group of the picker each kind belongs to, in the order the groups list them. */
const GROUP_OF: Readonly<Record<string, { group: "pages" | "globals" | "lists"; order: number }>> =
  {
    pageModuleContent: { group: "pages", order: 0 },
    page: { group: "pages", order: 1 },
    pageLayout: { group: "pages", order: 2 },
    module: { group: "globals", order: 0 },
    template: { group: "globals", order: 1 },
    listType: { group: "globals", order: 2 },
    pageType: { group: "globals", order: 3 },
    layoutChrome: { group: "globals", order: 4 },
    contentInstance: { group: "globals", order: 5 },
    pluginRow: { group: "globals", order: 6 },
    theme: { group: "globals", order: 7 },
    list: { group: "lists", order: 0 },
  };

/**
 * {@link loadPendingChanges} for several chats in one statement: their
 * head rows, labelled from the live rows by primary key. The cost is the
 * chats' own pending entities, not the draft's history.
 */
export async function loadPendingChangesFor(
  tx: TransactionRunner,
  chats: readonly HeadChat[],
): Promise<Map<string, PendingChanges>> {
  const out = new Map<string, PendingChanges>();
  for (const c of chats) out.set(c.chatSessionId, emptyPendingChanges());
  if (chats.length === 0) return out;
  const rows = (await tx.execute(sql`
    WITH c AS (
      SELECT * FROM unnest(
        ${uuidArray(chats.map((c) => c.chatSessionId))},
        ${uuidArray(chats.map((c) => c.branchId))},
        ${textArray(chats.map((c) => c.kind))}
      ) AS c(id, branch, branch_kind)
    ),
    h AS (
      -- One row per entity: on an isolated branch a change written outside
      -- any chat and the chat's own change of it are one pending entity.
      SELECT DISTINCT ON (c.id, d.entity_kind, d.entity_id, d.entity_sub)
             c.id AS chat, c.branch, d.entity_kind AS kind, d.entity_id,
             d.snapshot_row_id, d.page_id, d.plugin_id, d.table_name,
             bool_or(d.seo_changed)
               OVER (PARTITION BY c.id, d.entity_kind, d.entity_id, d.entity_sub) AS seo_changed
        FROM c
        CROSS JOIN LATERAL (
          ${chatHeadRowsSql({ id: "c.id", branch: "c.branch", kind: "c.branch_kind" }, pendingChangeKindSql())}
        ) d
       ORDER BY c.id, d.entity_kind, d.entity_id, d.entity_sub,
                d.header_created_at DESC, d.row_created_at DESC
    )
    -- Labels by primary key, one lookup per listed entity: correlated
    -- subqueries, because joining every label table lets the planner hash
    -- (seq-scan) all of them, which costs the size of the site.
    SELECT h.chat::text AS chat, h.kind, h.entity_id::text AS entity_id,
           CASE h.kind
             WHEN 'pageModuleContent'
               THEN (SELECT COALESCE(x.title, x.slug) FROM pages x WHERE x.id = h.page_id)
             WHEN 'page'
               THEN (SELECT COALESCE(x.title, x.slug) FROM pages x WHERE x.id = h.entity_id)
             WHEN 'pageLayout'
               THEN (SELECT COALESCE(x.title, x.slug) FROM pages x WHERE x.id = h.entity_id)
             WHEN 'module' THEN (SELECT x.display_name FROM modules x WHERE x.id = h.entity_id)
             WHEN 'template' THEN (SELECT x.display_name FROM templates x WHERE x.id = h.entity_id)
             WHEN 'layoutChrome' THEN 'Layout chrome'
             WHEN 'list' THEN COALESCE(
               (SELECT COALESCE(x.name, x.slug) FROM lists x WHERE x.id = h.entity_id),
               h.entity_id::text)
             WHEN 'listType' THEN COALESCE(
               (SELECT COALESCE(x.definition->>'name', x.slug) FROM list_types x WHERE x.id = h.entity_id),
               h.entity_id::text)
             WHEN 'pageType' THEN COALESCE(
               (SELECT COALESCE(x.definition->>'name', x.slug) FROM page_types x WHERE x.id = h.entity_id),
               h.entity_id::text)
             WHEN 'contentInstance' THEN COALESCE(
               (SELECT COALESCE(x.display_name, x.slug) FROM content_instances x WHERE x.id = h.entity_id),
               h.entity_id::text)
             WHEN 'theme' THEN COALESCE(
               (SELECT COALESCE(x.display_name, x.slug) FROM themes x WHERE x.id = h.entity_id),
               h.entity_id::text)
             WHEN 'pluginRow' THEN COALESCE(
               (SELECT x.slug FROM plugins x WHERE x.id = h.plugin_id), h.plugin_id::text)
               || ' · ' || h.table_name
           END AS label,
           CASE h.kind
             WHEN 'pageModuleContent' THEN
               (SELECT x.current_path FROM pages x WHERE x.id = h.page_id) || ' · ' ||
               (SELECT x.block_name || '#' || x.position
                  FROM page_module_content_snapshots x WHERE x.id = h.snapshot_row_id)
             -- #1156: an SEO change waiting for Stage is marked on its page.
             WHEN 'page' THEN (SELECT x.current_path FROM pages x WHERE x.id = h.entity_id)
               || CASE WHEN h.seo_changed THEN ' · SEO' ELSE '' END
             WHEN 'pageLayout'
               THEN (SELECT x.current_path FROM pages x WHERE x.id = h.entity_id) || ' · placements'
             WHEN 'module' THEN (SELECT x.slug FROM modules x WHERE x.id = h.entity_id)
             WHEN 'template' THEN (SELECT x.slug FROM templates x WHERE x.id = h.entity_id)
             WHEN 'list' THEN (SELECT x.slug FROM lists x WHERE x.id = h.entity_id)
             WHEN 'listType'
               THEN (SELECT 'list type ' || x.slug FROM list_types x WHERE x.id = h.entity_id)
             WHEN 'pageType'
               THEN (SELECT 'page type ' || x.slug FROM page_types x WHERE x.id = h.entity_id)
             WHEN 'contentInstance' THEN (
               SELECT m.slug || CASE WHEN x.slug IS NOT NULL THEN ' · ' || x.slug ELSE '' END
                 FROM content_instances x LEFT JOIN modules m ON m.id = x.module_id
                WHERE x.id = h.entity_id)
             WHEN 'theme' THEN (SELECT x.slug FROM themes x WHERE x.id = h.entity_id)
             WHEN 'pluginRow' THEN
               (SELECT CASE WHEN x.state->>'deletedAt' IS NOT NULL THEN 'deleted ' ELSE '' END
                  FROM plugin_row_snapshots x WHERE x.id = h.snapshot_row_id)
               || left(h.entity_id::text, 8)
           END AS detail,
           CASE WHEN h.kind = 'layoutChrome' THEN 'pending' ELSE COALESCE(
             (SELECT mk.stage_state FROM chat_branch_publish_marks mk
               WHERE mk.chat_branch_id = h.branch AND mk.entity_kind = h.kind
                 AND mk.entity_id = h.entity_id),
             'pending') END AS stage_state,
           CASE WHEN h.kind = 'layoutChrome'
             THEN (SELECT x.description FROM site_snapshots x WHERE x.id = h.entity_id) END AS description,
           CASE WHEN h.kind = 'layoutChrome'
             THEN (SELECT x.op_kind FROM site_snapshots x WHERE x.id = h.entity_id) END AS op_kind
      FROM h
     ORDER BY 1, 4, 3
  `)) as unknown as LabelledRow[];

  // Kind order inside each group, then label and id (the ORDER BY above).
  const sorted = [...rows].sort(
    (a, b) => (GROUP_OF[a.kind]?.order ?? 99) - (GROUP_OF[b.kind]?.order ?? 99),
  );
  for (const r of sorted) {
    const changes = out.get(r.chat);
    const group = GROUP_OF[r.kind];
    if (!changes || !group) continue;
    const ref = toRef(r);
    // A mark 'published' under a pending head is stale: the entity changed
    // again after it shipped, so the change is pending (#1268: the list
    // shows exactly what the count counts).
    const bucket = r.stage_state === "staged" ? changes.staged : changes.pending;
    bucket[group.group].push(ref);
  }
  return out;
}

function toRef(r: LabelledRow): EntityRef {
  if (r.kind === "layoutChrome") {
    // layouts.ts stamps "layout_modules.set block=<name>" (or similar).
    const block = /block=([\w-]+)/.exec(r.description ?? "");
    return {
      kind: "layout",
      entityId: r.entity_id,
      label: "Layout chrome",
      detail: block ? `block=${block[1]}` : (r.op_kind ?? "layout_modules.set"),
    };
  }
  return {
    kind: r.kind as EntityRef["kind"],
    entityId: r.entity_id,
    label: r.label ?? r.entity_id,
    ...(r.detail ? { detail: r.detail } : {}),
  };
}

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
  // Why site-wide: Stage merges every pending change of the draft and builds the whole site.
  readScope: "site",
  // Why human-only: the legacy per-entity stage PICKER (marks an isolated chat's entities for
  // chat.publish). The AI stages through the Stage flow (stage_changes, issue #620), not this
  // picker; it is an operator UI gesture.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: stageInput,
  output: z.object({ staged: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    const binding = await loadChatBinding(tx, input.chatSessionId);
    if (!binding) {
      return err({
        kind: "HandlerError",
        operation: "chat.stage",
        message: "session not found",
      });
    }
    if (binding.kind === "draft") {
      // Issue #620 — the per-entity stage picker predates the shared draft
      // (its marks key on the branch every draft chat shares). Draft chats
      // stage through the Stage flow (Open changes, /edit, stage_changes).
      return err({
        kind: "HandlerError",
        operation: "chat.stage",
        message:
          "this chat works on the shared draft — stage it from Open changes or the Stage button (the AI: stage_changes); the per-entity picker is for isolated chats only",
      });
    }
    const branchId = binding.branchId;
    const window = chatPendingSql(binding);

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
            case "list":
              return "list_snapshots";
            case "listType":
              return "list_type_snapshots";
            case "pageType":
              return "page_type_snapshots";
            case "contentInstance":
              return "content_instance_snapshots";
            case "pluginRow":
              return "plugin_row_snapshots";
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
            case "list":
              return "list_id";
            case "listType":
              return "list_type_id";
            case "pageType":
              return "page_type_id";
            case "contentInstance":
              return "content_instance_id";
            case "pluginRow":
              return "row_id";
            default:
              return "id";
          }
        })();
        const found = (await tx.execute(sql`
          SELECT site_snapshot_id::text AS site_snapshot_id
          FROM ${sql.raw(table)}
          JOIN site_snapshots ss ON ss.id = ${sql.raw(table)}.site_snapshot_id
          WHERE ${window}
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
          WHERE ${window}
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
          WHERE ${window}
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
          WHERE ${window}
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
          WHERE ${window}
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
          WHERE ${window}
          ORDER BY pmcs.page_module_content_id, ss.created_at DESC
        ) c
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (lsn.list_id)
            lsn.list_id::text AS entity_id,
            'list'::text AS entity_kind,
            lsn.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM list_snapshots lsn
          JOIN site_snapshots ss ON ss.id = lsn.site_snapshot_id
          WHERE ${window}
          ORDER BY lsn.list_id, ss.created_at DESC
        ) lsn_sub
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (ltn.list_type_id)
            ltn.list_type_id::text AS entity_id,
            'listType'::text AS entity_kind,
            ltn.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM list_type_snapshots ltn
          JOIN site_snapshots ss ON ss.id = ltn.site_snapshot_id
          WHERE ${window}
          ORDER BY ltn.list_type_id, ss.created_at DESC
        ) ltn_sub
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (ptn.page_type_id)
            ptn.page_type_id::text AS entity_id,
            'pageType'::text AS entity_kind,
            ptn.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM page_type_snapshots ptn
          JOIN site_snapshots ss ON ss.id = ptn.site_snapshot_id
          WHERE ${window}
          ORDER BY ptn.page_type_id, ss.created_at DESC
        ) ptn_sub
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (cis.content_instance_id)
            cis.content_instance_id::text AS entity_id,
            'contentInstance'::text AS entity_kind,
            cis.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM content_instance_snapshots cis
          JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
          WHERE ${window}
          ORDER BY cis.content_instance_id, ss.created_at DESC
        ) ci
        UNION ALL
        SELECT entity_id, entity_kind, site_snapshot_id FROM (
          SELECT DISTINCT ON (prs.row_id)
            prs.row_id::text AS entity_id,
            'pluginRow'::text AS entity_kind,
            prs.site_snapshot_id::text AS site_snapshot_id,
            ss.created_at
          FROM plugin_row_snapshots prs
          JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
          WHERE ${window}
          ORDER BY prs.row_id, ss.created_at DESC, prs.created_at DESC
        ) pr
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
  readScope: "request",
  // Why human-only: undoes the operator's stage gesture (see chat.stage) — part of the human review
  // step.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: unstageInput,
  output: z.object({ unstaged: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    const binding = await loadChatBinding(tx, input.chatSessionId);
    if (!binding) {
      return err({
        kind: "HandlerError",
        operation: "chat.unstage",
        message: "session not found",
      });
    }
    if (binding.kind === "draft") {
      // Issue #620 — the per-entity stage picker predates the shared draft
      // (its marks key on the branch every draft chat shares). Draft chats
      // stage through the Stage flow (Open changes, /edit, stage_changes).
      return err({
        kind: "HandlerError",
        operation: "chat.unstage",
        message:
          "this chat works on the shared draft — stage it from Open changes or the Stage button (the AI: stage_changes); the per-entity picker is for isolated chats only",
      });
    }
    const branchId = binding.branchId;

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
