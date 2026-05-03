// SPDX-License-Identifier: MPL-2.0

/**
 * Snapshot emitter — call from inside a mutation op handler, in the same
 * `tx`, so the snapshot row(s) and the live write share rollback semantics.
 *
 * One `site_snapshots` row groups N entity-level rows (modules, templates,
 * pages, page layouts). The caller passes one flat `entities` array tagged
 * with `kind`; this collapses what used to be four separate optional arrays
 * into a single shape that future entity kinds (P12A A/B variants) ride on
 * without expanding the API surface.
 *
 * Returns the new site_snapshots id so the caller can attach it to the
 * audit trail.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { ModuleState, PageLayoutState, PageState, TemplateState } from "./state.js";

/**
 * Catalog of write kinds that can produce a snapshot. Mirrors the Postgres
 * CHECK constraint added by 0009_p4_snapshot_op_kind.sql; keep in sync.
 */
export type SnapshotOpKind =
  | "modules.create"
  | "modules.update"
  | "modules.delete"
  | "templates.create"
  | "templates.update"
  | "templates.delete"
  | "template_blocks.set"
  | "pages.create"
  | "pages.update"
  | "pages.set_modules"
  | "pages.delete"
  | "snapshots.revert_site"
  | "snapshots.revert_module"
  | "snapshots.revert_template"
  | "snapshots.revert_page"
  | "chat.publish"
  | "layout_modules.set";

export type SnapshotEntity =
  | { readonly kind: "module"; readonly entityId: string; readonly state: ModuleState }
  | { readonly kind: "template"; readonly entityId: string; readonly state: TemplateState }
  | { readonly kind: "page"; readonly entityId: string; readonly state: PageState }
  | { readonly kind: "pageLayout"; readonly entityId: string; readonly state: PageLayoutState };

export interface SnapshotInput {
  readonly actorId: string;
  readonly opKind: SnapshotOpKind;
  readonly description: string;
  /** Set by P5 once chat sessions exist; NULL otherwise. */
  readonly chatTaskId?: string | null;
  /** Set by P5 for ephemeral chat preview branches; NULL otherwise. */
  readonly chatBranchId?: string | null;
  /** Non-null when this snapshot is a revert of another snapshot. */
  readonly revertOf?: string | null;
  readonly entities: readonly SnapshotEntity[];
}

export async function emitSnapshot(
  tx: TransactionRunner,
  input: SnapshotInput,
): Promise<{ siteSnapshotId: string }> {
  const headerRows = (await tx.execute(sql`
    INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id, revert_of)
    VALUES (
      ${input.actorId}::uuid,
      ${input.opKind},
      ${input.description},
      ${input.chatTaskId ?? null},
      ${input.chatBranchId ?? null},
      ${input.revertOf ?? null}
    )
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  const siteSnapshotId = headerRows[0]?.id;
  if (!siteSnapshotId) {
    throw new Error("emitSnapshot: site_snapshots insert returned no row");
  }

  // One switch over the discriminated union — every kind lands in its own
  // table. New entity kinds (P12A A/B variants) only need a new branch here.
  for (const entity of input.entities) {
    const stateJson = JSON.stringify(entity.state);
    switch (entity.kind) {
      case "module":
        await tx.execute(sql`
          INSERT INTO module_snapshots (site_snapshot_id, module_id, state)
          VALUES (${siteSnapshotId}::uuid, ${entity.entityId}::uuid, ${stateJson}::jsonb)
        `);
        break;
      case "template":
        await tx.execute(sql`
          INSERT INTO template_snapshots (site_snapshot_id, template_id, state)
          VALUES (${siteSnapshotId}::uuid, ${entity.entityId}::uuid, ${stateJson}::jsonb)
        `);
        break;
      case "page":
        await tx.execute(sql`
          INSERT INTO page_snapshots (site_snapshot_id, page_id, state)
          VALUES (${siteSnapshotId}::uuid, ${entity.entityId}::uuid, ${stateJson}::jsonb)
        `);
        break;
      case "pageLayout":
        await tx.execute(sql`
          INSERT INTO page_layout_snapshots (site_snapshot_id, page_id, state)
          VALUES (${siteSnapshotId}::uuid, ${entity.entityId}::uuid, ${stateJson}::jsonb)
        `);
        break;
    }
  }

  return { siteSnapshotId };
}
