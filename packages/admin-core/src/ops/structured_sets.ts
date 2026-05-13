// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.5 — generic named-list primitive. One table holds N kinds of
 * structured data (nav-menus, taxonomies, theme tokens, tag lists,
 * link blocks). The `kind` discriminator drives a per-kind Zod
 * validator from `@caelo-cms/shared/structured-sets` and a per-kind
 * renderer at preview / deploy time.
 *
 * Why a single table: every named-list editor surface ends up
 * structurally identical (CRUD on a `(kind, slug, items)` triple). One
 * primitive avoids a sprawl of one-off tables and gives `change_page_slug`
 * a single place to walk when retargeting links across menus + footers
 * + taxonomies + future kinds.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, structuredSetKind, validateStructuredSetItems } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { ZodError, z } from "zod";
import { recordAudit } from "../audit.js";
import { checkAndAcquireEntityLock, lockedError } from "../locks.js";
import { emitSnapshot } from "../snapshots/index.js";

const setRow = z.object({
  id: z.string(),
  kind: structuredSetKind,
  slug: z.string(),
  displayName: z.string(),
  items: z.unknown(),
  updatedAt: z.string(),
});

function describeZodIssues(e: ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}

/**
 * v0.5.1 — Ordered-list kinds (nav-menu, taxonomy, link-list) emit
 * one structured_set_operations row per discrete edit. Theme stays
 * whole-blob.
 *
 * Item identity per kind:
 *   nav-menu   → `href`
 *   taxonomy   → `slug`
 *   link-list  → `href`
 *
 * Falls back to `${index}` for items without an identity field (e.g.
 * a malformed prev row). Identity collisions are silently coerced to
 * "first wins" — the picker UI degrades to whole-list staging in that
 * case.
 */
const LIST_KINDS: ReadonlySet<string> = new Set(["nav-menu", "taxonomy", "link-list"]);

function itemId(kind: string, item: unknown, fallbackIndex: number): string {
  if (typeof item !== "object" || item === null) return `idx:${fallbackIndex}`;
  const obj = item as Record<string, unknown>;
  const fields = kind === "taxonomy" ? ["slug"] : ["href"];
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return `idx:${fallbackIndex}`;
}

type ListOp =
  | { kind: "add"; itemId: string; payload: { item: unknown; position: number } }
  | { kind: "rename"; itemId: string; payload: { from: string; to: string } }
  | { kind: "move"; itemId: string; payload: { from: number; to: number } }
  | { kind: "delete"; itemId: string; payload: { previousItem: unknown; previousPosition: number } }
  | {
      kind: "update";
      itemId: string;
      payload: { patch: Record<string, unknown>; previousItem: unknown };
    };

/**
 * Diff prev vs next item arrays for an ordered-list kind. Returns a
 * deterministic op list: deletes first (descending position), then
 * adds, then in-place renames/updates/moves keyed by stable item id.
 */
function diffListItems(kind: string, prev: unknown[], next: unknown[]): ListOp[] {
  const prevById = new Map<string, { item: unknown; index: number }>();
  for (let i = 0; i < prev.length; i++) {
    prevById.set(itemId(kind, prev[i], i), { item: prev[i], index: i });
  }
  const nextById = new Map<string, { item: unknown; index: number }>();
  for (let i = 0; i < next.length; i++) {
    nextById.set(itemId(kind, next[i], i), { item: next[i], index: i });
  }

  const ops: ListOp[] = [];

  // Deletes — items in prev but not in next, descending by position
  // so the apply step doesn't reshuffle indices mid-flight.
  const deletes: ListOp[] = [];
  for (const [id, p] of prevById) {
    if (!nextById.has(id)) {
      deletes.push({
        kind: "delete",
        itemId: id,
        payload: { previousItem: p.item, previousPosition: p.index },
      });
    }
  }
  deletes.sort((a, b) => {
    const ai = (a.payload as { previousPosition: number }).previousPosition;
    const bi = (b.payload as { previousPosition: number }).previousPosition;
    return bi - ai;
  });
  ops.push(...deletes);

  // Adds — items in next but not in prev, ascending by position.
  for (const [id, n] of nextById) {
    if (!prevById.has(id)) {
      ops.push({
        kind: "add",
        itemId: id,
        payload: { item: n.item, position: n.index },
      });
    }
  }

  // Updates / moves — items in both. Detect by structural diff.
  for (const [id, n] of nextById) {
    const p = prevById.get(id);
    if (!p) continue;
    const prevItem = p.item as Record<string, unknown> | null;
    const nextItem = n.item as Record<string, unknown> | null;
    // Label rename (nav-menu / link-list).
    if (
      prevItem &&
      nextItem &&
      typeof prevItem.label === "string" &&
      typeof nextItem.label === "string" &&
      prevItem.label !== nextItem.label
    ) {
      ops.push({
        kind: "rename",
        itemId: id,
        payload: { from: prevItem.label, to: nextItem.label },
      });
    }
    // Any other field-level change → update op with the full patch.
    const patch: Record<string, unknown> = {};
    if (prevItem && nextItem) {
      for (const k of new Set([...Object.keys(prevItem), ...Object.keys(nextItem)])) {
        if (k === "label") continue; // covered by rename above
        if (JSON.stringify(prevItem[k]) !== JSON.stringify(nextItem[k])) {
          patch[k] = nextItem[k];
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      ops.push({ kind: "update", itemId: id, payload: { patch, previousItem: prevItem } });
    }
    // Position change.
    if (p.index !== n.index) {
      ops.push({
        kind: "move",
        itemId: id,
        payload: { from: p.index, to: n.index },
      });
    }
  }

  return ops;
}

function rowToOut(r: {
  id: string;
  kind: string;
  slug: string;
  display_name: string;
  items: unknown;
  updated_at: string | Date;
}): z.infer<typeof setRow> {
  return {
    id: r.id,
    kind: structuredSetKind.parse(r.kind),
    slug: r.slug,
    displayName: r.display_name,
    items: typeof r.items === "string" ? JSON.parse(r.items) : r.items,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export const setStructuredSetOp = defineOperation({
  name: "structured_sets.set",
  // P6.7.5 — AI calls this via the `set_structured_set` and
  // `update_theme` tools. Per-kind Zod validation runs in the handler.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      kind: structuredSetKind,
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9-]+$/, "lowercase letters/digits/hyphens"),
      displayName: z.string().min(1).max(200),
      items: z.array(z.unknown()),
    })
    .strict(),
  output: z.object({ setId: z.string() }),
  handler: async (ctx, input, tx) => {
    let validated: unknown[];
    try {
      validated = validateStructuredSetItems(input.kind, input.items);
    } catch (e) {
      if (e instanceof ZodError) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "structured_sets.set",
          input,
          succeeded: false,
          resultSummary: `validation: ${describeZodIssues(e)}`,
        });
        return err({
          kind: "HandlerError",
          operation: "structured_sets.set",
          message: `items invalid for kind=${input.kind}: ${describeZodIssues(e)}`,
        });
      }
      throw e;
    }
    // v0.5.0 — per-entity lock. Only meaningful when updating an
    // existing set (creates have no entity_id yet; race on first-create
    // is harmless — unique (kind, slug) catches it at upsert).
    const existing = (await tx.execute(sql`
      SELECT id::text AS id, items FROM structured_sets
      WHERE kind = ${input.kind} AND slug = ${input.slug}
      LIMIT 1
    `)) as unknown as { id: string; items: unknown }[];
    const existingRow = existing[0];
    const existingId = existingRow?.id;
    if (existingId) {
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "structuredSet",
        entityId: existingId,
        chatBranchId: ctx.chatBranchId,
      });
      if (!lock.permitted && lock.holder) {
        return err(lockedError("structured_sets.set", "structuredSet", existingId, lock.holder));
      }
    }
    // Capture prev items for ordered-list diff (nav-menu / taxonomy /
    // link-list). Theme stays whole-blob.
    const prevItems = existingRow
      ? typeof existingRow.items === "string"
        ? (JSON.parse(existingRow.items) as unknown[])
        : ((existingRow.items as unknown[]) ?? [])
      : [];

    // v0.5.3 — when ctx.chatBranchId is set, do NOT overwrite live
    // items. Two paths:
    //
    //   branched + existing row → keep live items unchanged; emit
    //     branched snapshot carrying the new items.
    //   branched + new row → INSERT row with EMPTY items so the
    //     structured_set_id is stable; emit branched snapshot with the
    //     new items. Publish materialises real items into live.
    //   unbranched → UPSERT live items (existing behaviour).
    //
    // Note: cast through ::text first so Bun's SQL adapter doesn't
    // try to JSON-encode the string a second time.
    const branched = !!ctx.chatBranchId;
    const itemsJson = JSON.stringify(validated);
    let id: string;
    if (branched) {
      if (existingId) {
        id = existingId;
      } else {
        // Allocate the row in main with empty items so all chats
        // see the same id; branched snapshot carries the real items.
        const insRows = (await tx.execute(sql`
          INSERT INTO structured_sets (kind, slug, display_name, items, updated_by)
          VALUES (
            ${input.kind},
            ${input.slug},
            ${input.displayName},
            '[]'::jsonb,
            ${ctx.actorId}::uuid
          )
          ON CONFLICT (kind, slug) DO UPDATE SET updated_at = structured_sets.updated_at
          RETURNING id::text AS id
        `)) as unknown as { id: string }[];
        const newId = insRows[0]?.id;
        if (!newId) {
          return err({
            kind: "HandlerError",
            operation: "structured_sets.set",
            message: "no id from branched create",
          });
        }
        id = newId;
      }
    } else {
      const rows = (await tx.execute(sql`
        INSERT INTO structured_sets (kind, slug, display_name, items, updated_by)
        VALUES (
          ${input.kind},
          ${input.slug},
          ${input.displayName},
          ${itemsJson}::text::jsonb,
          ${ctx.actorId}::uuid
        )
        ON CONFLICT (kind, slug) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          items        = EXCLUDED.items,
          updated_at   = now(),
          updated_by   = EXCLUDED.updated_by
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const newId = rows[0]?.id;
      if (!newId) {
        return err({ kind: "HandlerError", operation: "structured_sets.set", message: "no id" });
      }
      id = newId;
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "structured_sets.set",
      input,
      succeeded: true,
      entityId: id,
      resultSummary: `${input.kind}/${input.slug} items=${validated.length}${
        branched ? " (branched)" : ""
      }`,
    });

    // v0.5.3 — always emit a whole-blob structuredSet snapshot. Carries
    // the full new state so preview can overlay reads (branched) and
    // site-history can revert (unbranched).
    const result = await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "structured_sets.set",
      description: `structured_sets.set ${input.kind}/${input.slug} items=${validated.length}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [
        {
          kind: "structuredSet",
          entityId: id,
          state: {
            schemaVersion: 1,
            kind: input.kind,
            slug: input.slug,
            displayName: input.displayName,
            items: validated,
            deletedAt: null,
          },
        },
      ],
    });

    // v0.5.1 — for ordered-list kinds, also emit per-op rows so the
    // picker can stage individual changes. Attached to the same
    // site_snapshot as the whole-blob row above.
    if (LIST_KINDS.has(input.kind)) {
      const ops = diffListItems(input.kind, prevItems, validated);
      for (const op of ops) {
        await tx.execute(sql`
          INSERT INTO structured_set_operations
            (site_snapshot_id, structured_set_id, op_kind, item_id, op_payload)
          VALUES (
            ${result.siteSnapshotId}::uuid,
            ${id}::uuid,
            ${op.kind},
            ${op.itemId},
            ${JSON.stringify(op.payload)}::jsonb
          )
        `);
      }
    }

    return ok({ setId: id });
  },
});

export const getStructuredSetOp = defineOperation({
  name: "structured_sets.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      kind: structuredSetKind,
      slug: z.string().min(1).max(120),
    })
    .strict(),
  output: z.object({ set: setRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, slug, display_name, items, updated_at
      FROM structured_sets
      WHERE kind = ${input.kind} AND slug = ${input.slug}
      LIMIT 1
    `)) as unknown as {
      id: string;
      kind: string;
      slug: string;
      display_name: string;
      items: unknown;
      updated_at: string | Date;
    }[];
    const r = rows[0];
    return ok({ set: r ? rowToOut(r) : null });
  },
});

export const listStructuredSetsOp = defineOperation({
  name: "structured_sets.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ kind: structuredSetKind.optional() }).strict(),
  output: z.object({ sets: z.array(setRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = input.kind
      ? ((await tx.execute(sql`
          SELECT id::text AS id, kind, slug, display_name, items, updated_at
          FROM structured_sets WHERE kind = ${input.kind}
          ORDER BY kind, slug
        `)) as unknown as {
          id: string;
          kind: string;
          slug: string;
          display_name: string;
          items: unknown;
          updated_at: string | Date;
        }[])
      : ((await tx.execute(sql`
          SELECT id::text AS id, kind, slug, display_name, items, updated_at
          FROM structured_sets
          ORDER BY kind, slug
        `)) as unknown as {
          id: string;
          kind: string;
          slug: string;
          display_name: string;
          items: unknown;
          updated_at: string | Date;
        }[]);
    return ok({ sets: rows.map(rowToOut) });
  },
});

export const deleteStructuredSetOp = defineOperation({
  name: "structured_sets.delete",
  // CLAUDE.md §11: parity with `set` — AI manages nav-menus / tags
  // / link-lists end-to-end (create, edit, delete) instead of
  // deferring deletes to a human round-trip.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ setId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM structured_sets WHERE id = ${input.setId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "structured_sets.delete",
      input,
      succeeded: true,
      entityId: input.setId,
    });
    return ok({});
  },
});

/**
 * P6.7.5 — slug-rewrite helper. Walks every nav-menu / link-list item
 * (and recursively into nav-menu children) and swaps any `href`
 * matching `oldPath` to `newPath`. Called from the page-update path
 * when the slug changes so menus stay valid in the same transaction
 * as the redirect insert.
 *
 * Path matching is exact — `oldPath = "/about-us"` doesn't touch
 * `"/about-us/team"`. That's deliberate; partial-match rewriting
 * lives in the cross-page link rewriter (P8).
 */
export async function rewriteSlugReferences(
  tx: TransactionRunner,
  oldPath: string,
  newPath: string,
): Promise<{ rewrittenSets: number }> {
  const sets = (await tx.execute(sql`
    SELECT id::text AS id, kind, items::text AS items
    FROM structured_sets
    WHERE kind IN ('nav-menu', 'link-list')
  `)) as unknown as { id: string; kind: string; items: string }[];

  let touched = 0;
  for (const s of sets) {
    const items = JSON.parse(s.items) as unknown[];
    const next = rewriteHrefsInArray(items, oldPath, newPath);
    if (next.changed) {
      // See note in setStructuredSetOp — cast through ::text first.
      const nextJson = JSON.stringify(next.items);
      await tx.execute(sql`
        UPDATE structured_sets
        SET items = ${nextJson}::text::jsonb, updated_at = now()
        WHERE id = ${s.id}::uuid
      `);
      touched += 1;
    }
  }
  return { rewrittenSets: touched };
}

interface HrefRewriteResult {
  items: unknown[];
  changed: boolean;
}

function rewriteHrefsInArray(
  items: unknown[],
  oldPath: string,
  newPath: string,
): HrefRewriteResult {
  let changed = false;
  const next = items.map((it) => {
    if (!it || typeof it !== "object") return it;
    const obj = it as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    if (typeof obj.href === "string" && obj.href === oldPath) {
      out.href = newPath;
      changed = true;
    }
    if (Array.isArray(obj.children)) {
      const child = rewriteHrefsInArray(obj.children as unknown[], oldPath, newPath);
      if (child.changed) {
        out.children = child.items;
        changed = true;
      }
    }
    return out;
  });
  return { items: next, changed };
}
