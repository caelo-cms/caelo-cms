// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — `quality_audits.classify_stage`: does the chat's next Stage
 * need a quality audit, and which pages does it touch?
 *
 * Reads the same window `chat.list_pending_changes` shows (branch
 * snapshots since the chat's last Stage), takes the latest state of every
 * entity, compares it with the main (live) version, and hands the reduced
 * `StageChange` list to the pure `classifyStageChanges`. Must run BEFORE
 * `chat.merge_to_main`: afterwards the live rows already hold the branch
 * state and "did the module's code change" is no longer answerable.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { classifyStageChanges, type StageChange } from "../../quality/classify.js";
import { stageClassificationSchema, uuidList } from "./_shared.js";

/** Structured-set kinds that are content lists, not theme/design data. */
const LIST_KINDS = new Set(["nav-menu", "taxonomy", "link-list"]);

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

interface Window {
  readonly branchId: string;
  readonly since: string | null;
}

function sinceFilter(w: Window) {
  return w.since ? sql` AND ss.created_at > ${w.since}::timestamptz` : sql``;
}

async function moduleChanges(tx: Tx, w: Window): Promise<StageChange[]> {
  const rows = (await tx.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (ms.module_id) ms.module_id, ms.state
      FROM module_snapshots ms
      JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
      WHERE ss.chat_branch_id = ${w.branchId}::uuid${sinceFilter(w)}
      ORDER BY ms.module_id, ss.created_at DESC
    )
    SELECT l.module_id::text AS id,
           COALESCE(m.display_name, l.state->>'displayName', l.module_id::text) AS label,
           (m.chat_branch_id = ${w.branchId}::uuid) AS created_on_branch,
           (l.state->>'deletedAt') IS NOT NULL AS deleted,
           COALESCE(l.state->>'html', '') IS DISTINCT FROM COALESCE(m.html, '')
             OR COALESCE(l.state->>'css', '') IS DISTINCT FROM COALESCE(m.css, '')
             OR COALESCE(l.state->>'js', '') IS DISTINCT FROM COALESCE(m.js, '') AS code_changed,
           m.id IS NULL AS missing_live
    FROM latest l
    LEFT JOIN modules m ON m.id = l.module_id
    ORDER BY label
  `)) as unknown as {
    id: string;
    label: string;
    created_on_branch: boolean | null;
    deleted: boolean;
    code_changed: boolean;
    missing_live: boolean;
  }[];
  return rows.map((r) => ({
    entity: "module" as const,
    entityId: r.id,
    label: r.label,
    change: r.deleted
      ? ("deleted" as const)
      : r.created_on_branch || r.missing_live
        ? ("created" as const)
        : r.code_changed
          ? ("code_changed" as const)
          : ("other" as const),
  }));
}

async function pageChanges(tx: Tx, w: Window): Promise<StageChange[]> {
  const rows = (await tx.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (ps.page_id) ps.page_id, ps.state
      FROM page_snapshots ps
      JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
      WHERE ss.chat_branch_id = ${w.branchId}::uuid${sinceFilter(w)}
      ORDER BY ps.page_id, ss.created_at DESC
    )
    SELECT l.page_id::text AS id,
           COALESCE(l.state->>'title', p.title, l.page_id::text) AS label,
           (l.state->>'deletedAt') IS NOT NULL AS deleted,
           (l.state->>'status') = 'published' AS published_now,
           (p.chat_branch_id = ${w.branchId}::uuid) AS created_on_branch,
           (p.status = 'published' AND p.deleted_at IS NULL) AS live_on_main
    FROM latest l
    LEFT JOIN pages p ON p.id = l.page_id
    ORDER BY label
  `)) as unknown as {
    id: string;
    label: string;
    deleted: boolean;
    published_now: boolean;
    created_on_branch: boolean | null;
    live_on_main: boolean | null;
  }[];
  return rows.map((r) => ({
    entity: "page" as const,
    entityId: r.id,
    label: r.label,
    change: r.deleted
      ? ("deleted" as const)
      : r.created_on_branch && r.published_now
        ? ("created" as const)
        : r.published_now && !r.live_on_main && !r.created_on_branch
          ? ("published" as const)
          : ("updated" as const),
  }));
}

/** Entities whose kind alone decides (templates, themes, structured sets,
 *  placements, content instances, plugin rows, layout chrome). */
async function kindOnlyChanges(tx: Tx, w: Window): Promise<StageChange[]> {
  const f = sinceFilter(w);
  const rows = (await tx.execute(sql`
    SELECT 'template' AS entity, ts.template_id::text AS id,
           COALESCE(max(t.display_name), ts.template_id::text) AS label, NULL::text AS kind
    FROM template_snapshots ts
    JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
    LEFT JOIN templates t ON t.id = ts.template_id
    WHERE ss.chat_branch_id = ${w.branchId}::uuid${f}
    GROUP BY ts.template_id
    UNION ALL
    SELECT 'theme', th.theme_id::text, COALESCE(max(t.display_name), th.theme_id::text), NULL
    FROM theme_snapshots th
    JOIN site_snapshots ss ON ss.id = th.site_snapshot_id
    LEFT JOIN themes t ON t.id = th.theme_id
    WHERE ss.chat_branch_id = ${w.branchId}::uuid${f}
    GROUP BY th.theme_id
    UNION ALL
    SELECT 'structuredSet', sss.structured_set_id::text,
           COALESCE(max(s.display_name), sss.structured_set_id::text),
           COALESCE(max(s.kind), max(sss.state->>'kind'))
    FROM structured_set_snapshots sss
    JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
    LEFT JOIN structured_sets s ON s.id = sss.structured_set_id
    WHERE ss.chat_branch_id = ${w.branchId}::uuid${f}
    GROUP BY sss.structured_set_id
    UNION ALL
    SELECT 'placement', pls.page_id::text, COALESCE(max(p.title), pls.page_id::text), NULL
    FROM page_layout_snapshots pls
    JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
    LEFT JOIN pages p ON p.id = pls.page_id
    WHERE ss.chat_branch_id = ${w.branchId}::uuid${f}
    GROUP BY pls.page_id
    UNION ALL
    SELECT 'content', cis.content_instance_id::text,
           COALESCE(max(ci.display_name), max(ci.slug), cis.content_instance_id::text), NULL
    FROM content_instance_snapshots cis
    JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
    LEFT JOIN content_instances ci ON ci.id = cis.content_instance_id
    WHERE ss.chat_branch_id = ${w.branchId}::uuid${f}
    GROUP BY cis.content_instance_id
    UNION ALL
    SELECT 'pluginConfig', prs.plugin_id::text,
           COALESCE(max(pl.slug), prs.plugin_id::text) || ' · ' || string_agg(DISTINCT prs.table_name, ', '),
           NULL
    FROM plugin_row_snapshots prs
    JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
    LEFT JOIN plugins pl ON pl.id = prs.plugin_id
    WHERE ss.chat_branch_id = ${w.branchId}::uuid${f}
    GROUP BY prs.plugin_id
    UNION ALL
    SELECT 'layout', ss.id::text, COALESCE(ss.description, 'layout chrome'), NULL
    FROM site_snapshots ss
    WHERE ss.chat_branch_id = ${w.branchId}::uuid AND ss.op_kind = 'layout_modules.set'${f}
  `)) as unknown as { entity: string; id: string; label: string; kind: string | null }[];
  const out: StageChange[] = [];
  for (const r of rows) {
    switch (r.entity) {
      case "template":
      case "theme":
      case "placement":
      case "content":
      case "pluginConfig":
      case "layout":
        out.push({ entity: r.entity, entityId: r.id, label: r.label });
        break;
      case "structuredSet":
        out.push({
          entity: r.kind !== null && LIST_KINDS.has(r.kind) ? "list" : "theme",
          entityId: r.id,
          label: r.label,
        });
        break;
    }
  }
  return out;
}

/**
 * Pages whose rendering the changes touch: changed pages and placements,
 * pages placing a module whose code changed, pages on a changed template.
 */
async function touchedPageIds(tx: Tx, changes: readonly StageChange[]): Promise<string[]> {
  const direct = new Set<string>();
  const moduleIds: string[] = [];
  const templateIds: string[] = [];
  for (const c of changes) {
    if ((c.entity === "page" && c.change !== "deleted") || c.entity === "placement") {
      direct.add(c.entityId);
    } else if (c.entity === "module" && (c.change === "created" || c.change === "code_changed")) {
      moduleIds.push(c.entityId);
    } else if (c.entity === "template") {
      templateIds.push(c.entityId);
    }
  }
  if (moduleIds.length > 0 || templateIds.length > 0) {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT pm.page_id::text AS id FROM page_modules pm
      WHERE pm.module_id = ANY(${uuidList(moduleIds)})
      UNION
      SELECT p.id::text FROM pages p WHERE p.template_id = ANY(${uuidList(templateIds)})
    `)) as unknown as { id: string }[];
    for (const r of rows) direct.add(r.id);
  }
  return [...direct].sort();
}

export const classifyStageOp = defineOperation({
  name: "quality_audits.classify_stage",
  // CLAUDE.md §11: read-only; the AI may ask whether its next Stage will be
  // audited (and why) before telling the operator what to expect.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({
    classification: stageClassificationSchema,
    /** Pages whose rendering the Stage touches (audit candidates). */
    touchedPageIds: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT chat_branch_id::text AS branch_id, last_staged_at
      FROM chat_sessions WHERE id = ${input.chatSessionId}::uuid
    `)) as unknown as { branch_id: string; last_staged_at: string | Date | null }[];
    const session = rows[0];
    if (!session) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.classify_stage",
        message: `chat session ${input.chatSessionId} not found — pass the id of the chat whose changes will be staged`,
      });
    }
    const w: Window = {
      branchId: session.branch_id,
      since:
        session.last_staged_at === null
          ? null
          : session.last_staged_at instanceof Date
            ? session.last_staged_at.toISOString()
            : session.last_staged_at,
    };
    const changes = [
      ...(await moduleChanges(tx, w)),
      ...(await pageChanges(tx, w)),
      ...(await kindOnlyChanges(tx, w)),
    ];
    return ok({
      classification: classifyStageChanges(changes),
      touchedPageIds: await touchedPageIds(tx, changes),
    });
  },
});
