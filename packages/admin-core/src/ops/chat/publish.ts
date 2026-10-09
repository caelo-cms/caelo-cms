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

import {
  applyPluginRowState,
  insertPluginRowSnapshot,
  type PluginRowState,
  withPluginScope,
} from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import type { ChatPublishInput, ExecutionContext } from "@caelo-cms/shared";
import { chatPublishInput, err, ok } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { pendingSnapshotSql } from "../../draft.js";
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
import { jsonbParam } from "../../sql-helpers.js";
import {
  AI_MERGE_BUSY_MESSAGE,
  enterAiMerge,
  isAiInitiated,
  recordAiStageHold,
} from "../../stage/ai-stage-hold.js";
import { refreshLivePathsAfterMerge } from "../content/current-path.js";
import { scanBranchInternalLinks } from "../content/link-integrity.js";
import { applyMediaUsageDelta } from "../content/media-usage.js";

interface SessionRow {
  chat_branch_id: string;
  published_at: string | Date | null;
  title: string;
  last_staged_at: string | Date | null;
  discarded_at: string | Date | null;
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
  /**
   * Migration run #9 / livedit regression (issue #262) —
   * chat.merge_to_main: replay only snapshots created AFTER the
   * session's `last_staged_at`, matching the v0.10.8 pending-changes
   * filter. Without this, every re-Stage in a long-lived page-bound
   * chat replayed the branch's LIFETIME snapshots, bumping
   * `updated_at` (and version) on every entity the chat ever touched
   * — a hero re-edit read as "all placements changed". chat.publish:
   * false — the publish boundary ships the whole branch (its
   * already-shipped dedup is the publish-marks mechanism).
   */
  readonly sinceLastStagedAt: boolean;
}

interface MergeResult {
  readonly siteSnapshotId: string | null;
  readonly entityCount: number;
  readonly session: SessionRow;
  /**
   * The pending branch headers this merge replayed — exactly what the
   * consumption step marks staged (never "everything older than the merge
   * time": a write that committed after the merge was not replayed).
   */
  readonly headerIds: readonly string[];
  readonly includeAll: boolean;
  /**
   * Internal hrefs in the merged pages that resolve to no existing page.
   * Surfaced (never blocking) so the operator + AI see dead links before
   * production — see `scanBranchInternalLinks`. Empty when clean or when
   * the branch had nothing to merge.
   */
  readonly brokenInternalLinks: string[];
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
  /** Merge exactly these pending headers (the set the Stage classified). */
  fixedHeaderIds?: readonly string[],
): Promise<
  | { ok: true; value: MergeResult }
  | {
      ok: false;
      error: { kind: "HandlerError"; operation: string; message: string };
    }
> {
  const sessionRows = (await tx.execute(sql`
    SELECT chat_branch_id::text AS chat_branch_id, published_at, title, last_staged_at, discarded_at,
           branch_kind
    FROM chat_sessions
    WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
    LIMIT 1
  `)) as unknown as (SessionRow & { branch_kind: string })[];
  const session = sessionRows[0];
  if (!session) {
    return {
      ok: false,
      error: { kind: "HandlerError", operation: options.opKind, message: "session not found" },
    };
  }
  if (session.discarded_at !== null) {
    // Merging would resurrect the branch-created rows the discard dropped.
    return {
      ok: false,
      error: {
        kind: "HandlerError",
        operation: options.opKind,
        message: "chat was discarded — its changes cannot be published; start a new chat",
      },
    };
  }
  if (session.branch_kind === "draft") {
    // Issue #620 — a draft chat shares its branch with every other draft
    // chat; merging "its branch" would ship theirs too. Draft chats merge
    // through chat.merge_draft_to_main, which selects exactly their changes.
    return {
      ok: false,
      error: {
        kind: "HandlerError",
        operation: options.opKind,
        message:
          "this chat works on the shared draft — stage it through the Stage flow (Open changes, the Stage button, or stage_changes), which merges exactly its changes",
      },
    };
  }
  // Issue #620 — pending is per snapshot (staged_at / undone_at), so a
  // Stage replays exactly what is still pending. chat.publish ships the
  // whole branch (its dedup is the publish marks).
  const pendingRows = (await tx.execute(sql`
    SELECT ss.id::text AS id FROM site_snapshots ss
    WHERE ss.chat_branch_id = ${session.chat_branch_id}::uuid AND ${pendingSnapshotSql()}
    ORDER BY ss.created_at, ss.id
  `)) as unknown as { id: string }[];
  let headerIds = pendingRows.map((r) => r.id);
  if (fixedHeaderIds) {
    const pending = new Set(headerIds);
    const missing = fixedHeaderIds.filter((id) => !pending.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        error: {
          kind: "HandlerError",
          operation: options.opKind,
          message: `${STAGE_CHANGED_PREFIX} ${missing.length} of the changes this Stage checked were staged or undone meanwhile — nothing was merged; stage again.`,
        },
      };
    }
    headerIds = [...fixedHeaderIds];
  }
  const windowFilter =
    headerIds.length === 0
      ? sql` AND false`
      : sql` AND ss.id IN (${sql.join(
          headerIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const filter =
    options.sinceLastStagedAt || fixedHeaderIds
      ? sql` AND ${pendingSnapshotSql()}${windowFilter}`
      : sql``;
  const merged = await mergeWindowToMain(
    tx,
    ctx,
    {
      branchId: session.chat_branch_id,
      title: session.title,
      filter,
      pluginCompletenessFilter: filter,
      graduateLayouts: input.entities === undefined,
    },
    input.entities,
    options,
  );
  if (!merged.ok) return merged;
  return { ok: true, value: { ...merged.value, session, headerIds } };
}

/**
 * Message prefix of a Stage refused because the branch changed between the
 * classification and the merge — the Stage flow classifies again and
 * retries (stage/stage-chats.ts).
 */
export const STAGE_CHANGED_PREFIX =
  "Conflict: the changes to stage moved on while this Stage was prepared:";

/** The snapshots one merge replays: a branch plus a header filter. */
export interface MergeWindow {
  readonly branchId: string;
  /** Snapshot-description title (the chat's, or "shared draft"). */
  readonly title: string;
  /** Extra predicate on `ss` (leading " AND"), e.g. pending or a header set. */
  readonly filter: SQL;
  /**
   * The window the "plugin rows go live together" check compares against
   * (leading " AND"). For a draft selection: every pending draft snapshot —
   * the selection closes over plugin rows, so it must contain them all.
   */
  readonly pluginCompletenessFilter: SQL;
  /** Clear chat_branch_id on layouts the branch created (whole-branch merges only). */
  readonly graduateLayouts: boolean;
}

/**
 * The replay core shared by every merge: latest snapshot per entity inside
 * the window → one main snapshot → live-table writes the branched handlers
 * deliberately skipped. Callers decide the window (an isolated chat's
 * pending branch snapshots, or a draft Stage selection).
 */
export async function mergeWindowToMain(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: ExecutionContext,
  window: MergeWindow,
  entitiesFilter: ChatPublishInput["entities"],
  options: MergeOptions,
): Promise<
  | { ok: true; value: Omit<MergeResult, "session" | "headerIds"> }
  | {
      ok: false;
      error: { kind: "HandlerError"; operation: string; message: string };
    }
> {
  type Row = { entity_id: string; state: unknown };
  const filterByKind = (
    kind:
      | "module"
      | "template"
      | "page"
      | "pageLayout"
      | "pageModuleContent"
      | "structuredSet"
      | "contentInstance"
      | "theme"
      | "pluginRow",
  ) => entitiesFilter?.filter((e) => e.kind === kind).map((e) => e.entityId) ?? null;
  const wantModules = filterByKind("module");
  const wantTemplates = filterByKind("template");
  const wantPages = filterByKind("page");
  const wantLayouts = filterByKind("pageLayout");
  const wantContent = filterByKind("pageModuleContent");
  const wantStructuredSets = filterByKind("structuredSet");
  const wantContentInstances = filterByKind("contentInstance");
  const wantThemes = filterByKind("theme");
  const includeAll = entitiesFilter === undefined;

  // The window (pending snapshots, or a draft Stage selection) — see
  // MergeWindow. Strict pending semantics replaced the per-chat
  // last_staged_at boundary in issue #620.
  const sinceFilter = window.filter;

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
      | "contentInstance"
      | "theme"
      | "pluginRow",
  ) =>
    options.skipAlreadyPublished
      ? sql`
          AND entity_id_text NOT IN (
            SELECT entity_id::text FROM chat_branch_publish_marks
            WHERE chat_branch_id = ${window.branchId}::uuid
              AND entity_kind = ${kind}
              AND stage_state = 'published'
          )
        `
      : sql``;
  const stagedCountRows = (await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM chat_branch_publish_marks
    WHERE chat_branch_id = ${window.branchId}::uuid
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
      | "contentInstance"
      | "theme"
      | "pluginRow",
  ) =>
    options.honourStageFilter && includeAll && hasStagedMarks
      ? sql`
          AND entity_id_text IN (
            SELECT entity_id::text FROM chat_branch_publish_marks
            WHERE chat_branch_id = ${window.branchId}::uuid
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
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
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
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
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
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
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
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
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
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
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
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
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
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
      ORDER BY cis.content_instance_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("contentInstance")} ${stageFilter("contentInstance")} ${inFilter(includeAll ? null : (wantContentInstances ?? []))}
  `)) as unknown as Row[]);

  // v0.11.0 (#45 step-11 round-2 opt §1) — themes merge. Mirrors the
  // structured_sets shape: pick the most-recent branched theme_snapshots
  // row per theme_id and replay (tokens + display_name + description +
  // asset FKs) onto the live themes row in the replay loop below.
  const themeRows =
    !includeAll && (wantThemes?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state FROM (
      SELECT DISTINCT ON (ts.theme_id)
             ts.theme_id::text AS entity_id,
             ts.state,
             ts.theme_id::text AS entity_id_text
      FROM theme_snapshots ts
      JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
      ORDER BY ts.theme_id, ss.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("theme")} ${stageFilter("theme")} ${inFilter(includeAll ? null : (wantThemes ?? []))}
  `)) as unknown as Row[]);

  // Plugin private-storage rows (docs/branch-aware-plugin-storage.md):
  // latest branch state per row. Applied after the core entities below,
  // so rows referencing core rows (ref:pages, ref:modules) find them.
  const wantPluginRows = filterByKind("pluginRow");
  const pluginRowRows =
    !includeAll && (wantPluginRows?.length ?? 0) === 0
      ? []
      : ((await tx.execute(sql`
    SELECT entity_id, state, plugin_id, schema_name, table_name FROM (
      SELECT DISTINCT ON (prs.row_id)
             prs.row_id::text AS entity_id, prs.row_id::text AS entity_id_text, prs.state,
             prs.plugin_id::text AS plugin_id, prs.schema_name, prs.table_name
      FROM plugin_row_snapshots prs
      JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
      ORDER BY prs.row_id, ss.created_at DESC, prs.created_at DESC
    ) sub
    WHERE 1=1 ${notYetPublished("pluginRow")} ${stageFilter("pluginRow")} ${inFilter(includeAll ? null : (wantPluginRows ?? []))}
  `)) as unknown as (Row & { plugin_id: string; schema_name: string; table_name: string })[]);

  // Plugin rows can shape page URLs, and the post-merge paths are
  // composed from the branch view (refreshLivePathsAfterMerge) — which is
  // only the post-merge state when every plugin row of the branch goes
  // live together.
  if (pluginRowRows.length > 0) {
    const pendingRows = (await tx.execute(sql`
      SELECT count(DISTINCT prs.row_id)::int AS n
      FROM plugin_row_snapshots prs
      JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
      WHERE ss.chat_branch_id = ${window.branchId}::uuid${window.pluginCompletenessFilter}
        AND prs.row_id::text NOT IN (
          SELECT entity_id::text FROM chat_branch_publish_marks
          WHERE chat_branch_id = ${window.branchId}::uuid
            AND entity_kind = 'pluginRow' AND stage_state = 'published'
        )
    `)) as unknown as { n: number }[];
    if ((pendingRows[0]?.n ?? 0) !== pluginRowRows.length) {
      return {
        ok: false,
        error: {
          kind: "HandlerError",
          operation: options.opKind,
          message:
            "plugin changes in this chat must be published together — they can shape page URLs. Include every plugin row, or none",
        },
      };
    }
  }

  // Issue #620 — layout chrome placed inside a chat (`layout_modules.set`
  // on a branch writes a pending block state, not the live table): the
  // latest state per (layout, block) in the window. Whole-window merges
  // only — an entity-filtered publish has no way to name a layout block.
  const layoutBlockRows = !includeAll
    ? []
    : ((await tx.execute(sql`
    SELECT DISTINCT ON (lms.layout_id, lms.block_name)
           lms.layout_id::text AS layout_id, lms.block_name, lms.state
    FROM layout_module_snapshots lms
    JOIN site_snapshots ss ON ss.id = lms.site_snapshot_id
    WHERE ss.chat_branch_id = ${window.branchId}::uuid${sinceFilter}
    ORDER BY lms.layout_id, lms.block_name, ss.created_at DESC, lms.created_at DESC
  `)) as unknown as { layout_id: string; block_name: string; state: unknown }[]);

  const total =
    layoutBlockRows.length +
    pluginRowRows.length +
    moduleRows.length +
    templateRows.length +
    pageRows.length +
    layoutRows.length +
    contentRows.length +
    structuredSetRows.length +
    contentInstanceRows.length +
    themeRows.length;
  if (total === 0) {
    return {
      ok: true,
      value: { siteSnapshotId: null, entityCount: 0, includeAll, brokenInternalLinks: [] },
    };
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
      ...themeRows.map((r): SnapshotEntity => {
        const raw = parseSnapshotState(r.state) as {
          schemaVersion: 1;
          slug: string;
          displayName: string;
          description: string | null;
          isActive: boolean;
          tokens: unknown;
          assets: {
            logo: string | null;
            logoDark: string | null;
            favicon: string | null;
            socialShare: string | null;
          };
          deletedAt: string | null;
        };
        return { kind: "theme", entityId: r.entity_id, state: raw };
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
      ? `${options.opKind} title=${window.title}`
      : `${options.opKind} (partial) title=${window.title} entities=${total}`,
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
        SET content_values = ${jsonbParam(valuesJson)},
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
    } else if (e.kind === "theme") {
      // v0.11.0 (#45, step-11 round-2 opt §1) — replay the branched
      // theme snapshot onto the live themes row. Mirrors the
      // structured_sets shape: tokens jsonb + display_name + description
      // + the four asset FKs come from the snapshot state. is_active is
      // intentionally NOT replayed here — activation lives in its own
      // gated propose/execute path and shouldn't be implicitly flipped
      // by a chat publish.
      const tokensJson = JSON.stringify(e.state.tokens);
      await tx.execute(sql`
        UPDATE themes
        SET tokens = ${tokensJson}::text::jsonb,
            display_name = ${e.state.displayName},
            description = ${e.state.description},
            logo_media_id = ${e.state.assets.logo === null ? null : sql`${e.state.assets.logo}::uuid`},
            logo_dark_media_id = ${e.state.assets.logoDark === null ? null : sql`${e.state.assets.logoDark}::uuid`},
            favicon_media_id = ${e.state.assets.favicon === null ? null : sql`${e.state.assets.favicon}::uuid`},
            social_share_media_id = ${e.state.assets.socialShare === null ? null : sql`${e.state.assets.socialShare}::uuid`},
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${e.entityId}::uuid
      `);
    } else if (e.kind === "page") {
      // v0.9.0 — pages.create now branches; merge UPSERTs the live row
      // AND clears chat_branch_id to graduate to main.
      await tx.execute(sql`
        INSERT INTO pages (id, slug, name, title, template_id, status, deleted_at, version, chat_branch_id)
        VALUES (
          ${e.entityId}::uuid,
          ${e.state.slug},
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
      // P7 usage-tracker: branched module writes skipped the live
      // usage_count delta; apply it now between what the live row counts
      // (its HTML while not soft-deleted — media-usage.ts invariant) and
      // the merged state.
      const live = (await tx.execute(sql`
        SELECT html, deleted_at FROM modules WHERE id = ${e.entityId}::uuid
      `)) as unknown as { html: string; deleted_at: Date | null }[];
      const liveRow = live[0];
      if (liveRow) {
        await applyMediaUsageDelta(
          tx,
          liveRow.deleted_at === null ? liveRow.html : "",
          e.state.deletedAt ? "" : e.state.html,
        );
      }
      // v0.9.0 — also clears chat_branch_id so branched-create
      // modules graduate to main on merge.
      await tx.execute(sql`
        UPDATE modules
        SET slug = ${e.state.slug},
            display_name = ${e.state.displayName},
            type = ${e.state.type},
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
          ${jsonbParam(valuesJson)},
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

  for (const r of pluginRowRows) {
    const ref = {
      pluginId: r.plugin_id,
      schema: r.schema_name,
      table: r.table_name,
      rowId: r.entity_id,
    };
    const state = parseSnapshotState(r.state) as PluginRowState;
    await withPluginScope(tx, r.plugin_id, () => applyPluginRowState(tx, ref, state));
    // The main-line copy under the merge's header: undo after publish.
    await insertPluginRowSnapshot(tx, result.siteSnapshotId, ref, state);
  }

  // Layout chrome: the merged block state becomes the live placement list
  // (the referenced modules were replayed above — a module created in the
  // branch graduates in the same merge). Recorded under the main snapshot
  // with the state it replaced, so the history shows what changed.
  for (const b of layoutBlockRows) {
    const state = (typeof b.state === "string" ? JSON.parse(b.state) : b.state) as {
      moduleIds?: unknown;
    };
    if (!Array.isArray(state.moduleIds)) {
      return {
        ok: false,
        error: {
          kind: "HandlerError",
          operation: options.opKind,
          message: `layout block snapshot for ${b.layout_id}/${b.block_name} has no moduleIds — the snapshot is corrupt; undo that chat's layout change and redo it`,
        },
      };
    }
    const moduleIds = state.moduleIds.filter((m): m is string => typeof m === "string");
    await tx.execute(sql`
      DELETE FROM layout_modules
      WHERE layout_id = ${b.layout_id}::uuid AND block_name = ${b.block_name}
    `);
    for (const [position, moduleId] of moduleIds.entries()) {
      await tx.execute(sql`
        INSERT INTO layout_modules (layout_id, block_name, position, module_id)
        VALUES (${b.layout_id}::uuid, ${b.block_name}, ${position}, ${moduleId}::uuid)
      `);
    }
    await tx.execute(sql`
      INSERT INTO layout_module_snapshots (site_snapshot_id, layout_id, block_name, state)
      VALUES (${result.siteSnapshotId}::uuid, ${b.layout_id}::uuid, ${b.block_name},
              ${jsonbParam({ schemaVersion: 1, moduleIds })})
    `);
  }

  // Plugin rows can carry URL annotations (a locale variant link); now
  // that they are live, recompose main-line paths and 301 what moved.
  if (pluginRowRows.length > 0) {
    await refreshLivePathsAfterMerge(ctx, tx, window.branchId);
  }

  // v0.9.0 — bulk clear chat_branch_id for any branched-create layouts
  // on this chat's branch. Layouts emit snapshots with entities=[] so
  // the per-entity replay loop above never sees them; query the live
  // table directly. Same for any layout entities the operator's filter
  // doesn't already cover via the replay path.
  if (window.graduateLayouts) {
    // Honor includeAll only — partial-merge with entities filter doesn't
    // sweep layouts because we have no way to map a layout id into the
    // entities[] filter today (layouts.create snapshot carries no
    // entity row). Full-merge clears everything branched to this chat.
    await tx.execute(sql`
      UPDATE layouts SET chat_branch_id = NULL
      WHERE chat_branch_id = ${window.branchId}::uuid
    `);
  }

  if (options.recordPublishMarks) {
    const marked = [
      ...entities.map((e) => ({ kind: e.kind, entityId: e.entityId })),
      ...pluginRowRows.map((r) => ({ kind: "pluginRow" as const, entityId: r.entity_id })),
    ];
    for (const e of marked) {
      await tx.execute(sql`
        INSERT INTO chat_branch_publish_marks
          (chat_branch_id, entity_kind, entity_id, site_snapshot_id)
        VALUES (
          ${window.branchId}::uuid,
          ${e.kind},
          ${e.entityId}::uuid,
          ${result.siteSnapshotId}::uuid
        )
        ON CONFLICT DO NOTHING
      `);
    }
  }

  // Internal-link integrity — runs AFTER the replay loop wrote the merged
  // state to the live tables, so the scan reads post-merge slugs +
  // content. Warn-only: dead links are surfaced in the op result, never
  // block the merge (CLAUDE.md §2 loud-honesty).
  const { brokenInternalLinks } = await scanBranchInternalLinks(tx, window.branchId);

  return {
    ok: true,
    value: {
      siteSnapshotId: result.siteSnapshotId,
      entityCount: total,
      includeAll,
      brokenInternalLinks,
    },
  };
}

/**
 * Issue #620 — mark an isolated branch's pending snapshots consumed: the
 * ones a Stage merged (created at or before the merge time; edits made
 * while the staging build ran stay pending), or all of them (`bound` null —
 * the publish boundary).
 */
async function markBranchStaged(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  branchId: string,
  headerIds: readonly string[],
  stagedAt: string | null,
): Promise<void> {
  if (headerIds.length === 0) return;
  await tx.execute(sql`
    UPDATE site_snapshots SET staged_at = COALESCE(${stagedAt}::timestamptz, now())
    WHERE chat_branch_id = ${branchId}::uuid AND staged_at IS NULL AND undone_at IS NULL
      AND id IN (${sql.join(
        headerIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
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
    /**
     * Internal links in the published pages that point at no existing
     * page. Non-blocking — the publish succeeded; these are dead links
     * to fix. Empty when clean.
     */
    brokenInternalLinks: z.array(z.string()),
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
      sinceLastStagedAt: false,
    });
    if (!merged.ok) return err(merged.error);

    const { siteSnapshotId, entityCount, includeAll, brokenInternalLinks } = merged.value;

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
      return ok({ siteSnapshotId: null, entityCount: 0, brokenInternalLinks: [] });
    }

    if (includeAll) {
      await tx.execute(sql`
        UPDATE chat_sessions SET published_at = now()
        WHERE id = ${input.chatSessionId}::uuid
      `);
      await markBranchStaged(tx, merged.value.session.chat_branch_id, merged.value.headerIds, null);
      // v0.5.0 — release every per-entity lock held by this chat once
      // it's fully published. Partial publishes keep their locks so
      // subsequent writes against the same entities stay scoped to
      // this chat.
      await releaseChatLocks(tx, input.chatSessionId);
    }

    // Loud-honesty warning line — dead internal links ride into the
    // audit summary (and the op result below) so they're visible at the
    // publish boundary, not discovered as production 404s.
    const linkWarning =
      brokenInternalLinks.length > 0
        ? ` WARNING broken-internal-links=${brokenInternalLinks.length}: ${brokenInternalLinks.slice(0, 10).join(", ")}`
        : "";
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.publish",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary:
        (includeAll ? `entities=${entityCount}` : `partial entities=${entityCount}`) + linkWarning,
    });

    return ok({ siteSnapshotId, entityCount, brokenInternalLinks });
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
const chatMergeToMainInput = chatPublishInput.extend({
  /**
   * Run #8 R6 (issue #262) — when true, the merge promotes entity state
   * to the live tables but SKIPS the branch-consumption side effects
   * (`last_staged_at` stamp + lock release). The Stage flow merges with
   * `deferConsume: true`, runs the staging build (a separate process
   * reading COMMITTED state — a single tx spanning merge + build is
   * impossible), and calls `chat.finalize_stage` only when the build
   * SUCCEEDED. On a failed build nothing is consumed: the pending
   * counter stays up, the Stage button stays offered, and a retry
   * re-merges the freshest branch state.
   */
  deferConsume: z.boolean().optional(),
  /**
   * Issue #620 — merge exactly these pending headers: the set
   * `quality_audits.classify_stage` classified, so nothing unaudited slips
   * in between. A header no longer pending refuses the merge ("Conflict:
   * …", the Stage flow classifies again).
   */
  headerIds: z.array(z.string().uuid()).max(20000).optional(),
  /**
   * Issue #620 Part B — the AI initiated this Stage (stage_changes runs the
   * flow with the operator's context): opens the production hold. Asking
   * for a hold only ever restricts, so any caller may set it.
   */
  aiInitiated: z.boolean().optional(),
});

export const mergeChatToMainOp = defineOperation({
  name: "chat.merge_to_main",
  // Issue #620 Part B — the AI may Stage (stage_changes runs this op as
  // the AI). Staging is not public, snapshots stay revertable (§11.A
  // routine test), and an AI merge opens a production hold in this same
  // transaction, so it can never reach production without a human Publish
  // live (stage/ai-stage-hold.ts).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: chatMergeToMainInput,
  output: z.object({
    siteSnapshotId: z.string().nullable(),
    entityCount: z.number().int().nonnegative(),
    /**
     * Merge-time timestamp (ISO). `chat.finalize_stage` stamps
     * `last_staged_at` to exactly this value so branch edits made
     * WHILE the staging build ran stay pending (they were not built).
     */
    mergedAt: z.string(),
    /**
     * Internal links in the staged pages that point at no existing page.
     * Non-blocking — staging proceeds — but surfaced so dead links are
     * caught before the operator promotes staging to production.
     */
    brokenInternalLinks: z.array(z.string()),
    /** The headers replayed — pass them to chat.finalize_stage. */
    mergedHeaderIds: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    const ai = isAiInitiated(ctx, input.aiInitiated);
    if (ai && !(await enterAiMerge(tx))) {
      return err({
        kind: "HandlerError",
        operation: "chat.merge_to_main",
        message: AI_MERGE_BUSY_MESSAGE,
      });
    }
    const { headerIds: fixedHeaderIds, aiInitiated: _ai, ...publishInput } = input;
    const merged = await mergeBranchSnapshotsToMain(
      tx,
      ctx,
      publishInput,
      {
        opKind: "chat.merge_to_main",
        skipAlreadyPublished: false,
        honourStageFilter: false,
        recordPublishMarks: false,
        sinceLastStagedAt: true,
      },
      fixedHeaderIds,
    );
    if (!merged.ok) return err(merged.error);

    const { siteSnapshotId, entityCount, includeAll, brokenInternalLinks } = merged.value;

    // Merge-time boundary for the pending-changes filters. Emitted as a
    // deterministic ISO string (not a driver-dependent Date/text row) so
    // chat.finalize_stage can round-trip it through its Zod boundary.
    const mergedAtRows = (await tx.execute(sql`
      SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS merged_at
    `)) as unknown as { merged_at: string }[];
    const mergedAt = mergedAtRows[0]?.merged_at;
    if (!mergedAt) {
      return err({
        kind: "HandlerError",
        operation: "chat.merge_to_main",
        message: "could not read merge timestamp",
      });
    }

    // Even a merge of nothing: the AI still triggers the staging build an
    // automatic publish would promote.
    if (ai) await recordAiStageHold(tx, ctx, [input.chatSessionId]);

    if (!input.deferConsume) {
      await markBranchStaged(
        tx,
        merged.value.session.chat_branch_id,
        merged.value.headerIds,
        mergedAt,
      );
      // v0.10.8 — stamp `last_staged_at` so chat.branch_change_count /
      // branch_edited_entities / list_pending_changes can filter out
      // already-merged snapshots. Without this, the toolbar's pending-
      // changes pill stays at the chat's lifetime total after Stage
      // instead of resetting to 0.
      await tx.execute(sql`
        UPDATE chat_sessions SET last_staged_at = ${mergedAt}::timestamptz
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
    }

    const linkWarning =
      brokenInternalLinks.length > 0
        ? ` WARNING broken-internal-links=${brokenInternalLinks.length}: ${brokenInternalLinks.slice(0, 10).join(", ")}`
        : "";
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.merge_to_main",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary:
        (includeAll ? `entities=${entityCount}` : `partial entities=${entityCount}`) + linkWarning,
    });

    return ok({
      siteSnapshotId,
      entityCount,
      mergedAt,
      brokenInternalLinks,
      mergedHeaderIds: [...merged.value.headerIds],
    });
  },
});

/**
 * Run #8 R6 (issue #262) — second half of the deferred Stage
 * consumption. The Stage flow is merge (`deferConsume: true`) → staging
 * build → THIS op on build success. It stamps `last_staged_at` to the
 * merge timestamp and releases the chat's entity locks — the two side
 * effects that make the UI treat the branch as "consumed". Never call
 * it after a FAILED build: leaving it uncalled is exactly what keeps
 * the pending counter and the Stage button alive for the retry.
 *
 * Idempotent: `GREATEST(...)` keeps a newer stamp when a stale retry
 * lands late, and releasing already-released locks is a no-op.
 */
export const finalizeStageOp = defineOperation({
  name: "chat.finalize_stage",
  // Issue #620 Part B — paired with chat.merge_to_main, which the AI may
  // run (stage_changes); the Stage flow calls it after the staging build
  // succeeded.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      /** `mergedAt` as returned by the paired chat.merge_to_main call. */
      stagedAt: z.string().datetime(),
      /** `mergedHeaderIds` of the paired merge: exactly these become staged. */
      headerIds: z.array(z.string().uuid()).max(20000),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE chat_sessions
      SET last_staged_at = GREATEST(
        COALESCE(last_staged_at, '-infinity'::timestamptz),
        ${input.stagedAt}::timestamptz
      )
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
      RETURNING chat_branch_id::text AS chat_branch_id
    `)) as unknown as { chat_branch_id: string }[];
    const finalized = rows[0];
    if (!finalized) {
      return err({
        kind: "HandlerError",
        operation: "chat.finalize_stage",
        message: "session not found",
      });
    }
    await markBranchStaged(tx, finalized.chat_branch_id, input.headerIds, input.stagedAt);

    await releaseChatLocks(tx, input.chatSessionId);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.finalize_stage",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `stagedAt=${input.stagedAt}`,
    });

    return ok({});
  },
});
