// SPDX-License-Identifier: MPL-2.0

/**
 * Deep copy of content instances, nested children included.
 *
 * A `module` / `module-list` field stores `{ moduleId, contentInstanceId }`
 * in the parent's `values`: the nested module's content is its own row,
 * with no `page_modules` placement. Copying only the parent's `values`
 * therefore copies the REFERENCE, and the copy keeps showing (and editing)
 * the source's children — translating a language variant's nested section
 * rewrote the original page's section. So a copy walks the whole nested
 * tree and mints one new row per instance in it, rewriting every copied
 * parent to point at the copied children.
 *
 * Values are read as the caller sees them: live rows visible on the
 * caller's branch, superseded by the branch's latest pending
 * content-instance snapshot (a chat's own edits exist only there until
 * Stage). New rows carry the caller's `chat_branch_id`, like every
 * branched create.
 *
 * Every row the copy mints comes back as a `contentInstance` snapshot
 * entity, nested copies included, so the caller's snapshot records them
 * (CLAUDE.md §2). Without it an undo of the duplicate or fork dropped the
 * page but left the copies behind as orphans, and revert/audit never saw
 * them (#1126).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { collectNestedRefs, rewriteNestedRefs } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { loadContentInstanceBranchStates, type SnapshotEntity } from "../../snapshots/index.js";
import { jsonbParam } from "../../sql-helpers.js";

interface InstanceInView {
  readonly moduleId: string;
  readonly values: Record<string, unknown>;
  readonly deleted: boolean;
}

/** Who writes the copies, and on which branch. */
export interface CloneActor {
  readonly actorId: string;
  readonly chatBranchId?: string | null;
}

/** Bound on the nested tree walk; matches the renderer's recursion cap (8) with slack. */
const MAX_NESTING_LEVELS = 16;

async function loadInstancesInView(
  tx: TransactionRunner,
  ids: readonly string[],
  chatBranchId: string | null,
): Promise<Map<string, InstanceInView>> {
  const out = new Map<string, InstanceInView>();
  if (ids.length === 0) return out;
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const visibility = chatBranchId
    ? sql`AND (chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`AND chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, module_id::text AS module_id, "values", deleted_at
      FROM content_instances
     WHERE id IN (${idList}) ${visibility}
  `)) as unknown as {
    id: string;
    module_id: string;
    values: unknown;
    deleted_at: string | Date | null;
  }[];
  for (const r of rows) {
    const values = typeof r.values === "string" ? JSON.parse(r.values) : r.values;
    out.set(r.id, {
      moduleId: r.module_id,
      values: (values ?? {}) as Record<string, unknown>,
      deleted: r.deleted_at !== null,
    });
  }
  if (chatBranchId) {
    const branched = await loadContentInstanceBranchStates(tx, ids, chatBranchId);
    for (const [id, state] of branched) {
      out.set(id, {
        moduleId: state.moduleId,
        values: state.values,
        deleted: state.deletedAt !== null,
      });
    }
  }
  return out;
}

/**
 * Copy `sourceIds` (one fresh row per entry, even when two entries name
 * the same instance — each placement of a duplicated page owns its copy)
 * together with every content instance nested under them. A nested
 * instance reached from several places in this copy is copied once, so
 * sharing INSIDE the copied tree is kept while nothing is shared with the
 * source.
 *
 * Fails, without writing, when an instance in the tree is missing,
 * deleted, or not visible to the caller: copying around it would either
 * keep a reference into the source or silently drop content.
 *
 * @returns `ids`: the new id for each entry of `sourceIds`, in the same
 *   order; `snapshotEntities`: one `contentInstance` entity per row
 *   written (roots and nested copies), for the caller's `emitSnapshot`.
 */
export async function cloneContentInstancesDeep(
  tx: TransactionRunner,
  actor: CloneActor,
  sourceIds: readonly string[],
): Promise<
  { ok: true; ids: string[]; snapshotEntities: SnapshotEntity[] } | { ok: false; message: string }
> {
  const branchId = actor.chatBranchId ?? null;
  const inView = new Map<string, InstanceInView>();
  const nestedIds = new Set<string>();
  let frontier = [...new Set(sourceIds)];
  let isRootLevel = true;
  for (let level = 0; frontier.length > 0; level += 1) {
    if (level > MAX_NESTING_LEVELS) {
      return {
        ok: false,
        message: `nested content is more than ${MAX_NESTING_LEVELS} levels deep; flatten the nested module references before copying`,
      };
    }
    const loaded = await loadInstancesInView(tx, frontier, branchId);
    const next = new Set<string>();
    for (const id of frontier) {
      const inst = loaded.get(id);
      if (!inst || inst.deleted) {
        return {
          ok: false,
          message: isRootLevel
            ? `content instance ${id} is ${inst ? "deleted" : "missing"} but still placed on the page; bind the placement to existing content (set_placement_content) before copying`
            : `nested content instance ${id} is ${inst ? "deleted" : "missing"} but still referenced from a module field; remove or replace that reference (set_content_instance_values_many) before copying`,
        };
      }
      inView.set(id, inst);
      for (const ref of collectNestedRefs(inst.values)) {
        if (!nestedIds.has(ref.contentInstanceId)) {
          nestedIds.add(ref.contentInstanceId);
          next.add(ref.contentInstanceId);
        }
      }
    }
    // A nested id already loaded as a root still needs its own copy (the
    // root copies are per placement), but its values are known.
    frontier = [...next].filter((id) => !inView.has(id));
    isRootLevel = false;
  }

  // Ids are minted here, not by the database, so each copy pairs with
  // its source by construction (no positional matching on RETURNING).
  const nestedCopy = new Map<string, string>([...nestedIds].map((id) => [id, crypto.randomUUID()]));
  const remap = (id: string): string => {
    const copy = nestedCopy.get(id);
    if (copy === undefined)
      throw new Error(`content copy: no copy minted for nested instance ${id}`);
    return copy;
  };
  const rows: { id: string; sourceId: string }[] = [
    ...sourceIds.map((sourceId) => ({ id: crypto.randomUUID(), sourceId })),
    ...[...nestedCopy].map(([sourceId, id]) => ({ id, sourceId })),
  ];
  const copies = rows.map(({ id, sourceId }) => {
    const inst = inView.get(sourceId);
    if (!inst) throw new Error(`content copy: instance ${sourceId} was not loaded`);
    return { id, moduleId: inst.moduleId, values: rewriteNestedRefs(inst.values, remap) };
  });
  const snapshotEntities: SnapshotEntity[] = [];
  if (copies.length > 0) {
    const inserted = (await tx.execute(sql`
      INSERT INTO content_instances (id, module_id, slug, display_name, "values", updated_by, chat_branch_id)
      VALUES ${sql.join(
        copies.map(
          (c) => sql`(
            ${c.id}::uuid, ${c.moduleId}::uuid, NULL, NULL, ${jsonbParam(c.values)},
            ${actor.actorId}::uuid, ${branchId}::uuid
          )`,
        ),
        sql`, `,
      )}
      RETURNING id::text AS id, version
    `)) as unknown as { id: string; version: number | string }[];
    const versions = new Map(inserted.map((r) => [r.id, Number(r.version)]));
    for (const c of copies) {
      const version = versions.get(c.id);
      if (version === undefined) throw new Error(`content copy: row ${c.id} was not inserted`);
      snapshotEntities.push({
        kind: "contentInstance",
        entityId: c.id,
        state: {
          schemaVersion: 1,
          moduleId: c.moduleId,
          slug: null,
          displayName: null,
          values: c.values,
          version,
          deletedAt: null,
        },
      });
    }
  }
  return { ok: true, ids: rows.slice(0, sourceIds.length).map((r) => r.id), snapshotEntities };
}
