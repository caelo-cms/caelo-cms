// SPDX-License-Identifier: MPL-2.0

/**
 * v0.4.0 — Page-placement content ops.
 *
 * Module rows hold the structure (HTML/CSS/JS + field schema). The content
 * that fills field placeholders on each page-placement lives here. Per
 * CLAUDE.md, this is the *only* page-level entity that's per-chat-branched:
 * module edits are global + immediate; content edits are page-bound and
 * branch-isolated per chat until publish.
 */

import {
  defineOperation,
  OperationAbortError,
  type TransactionRunner,
  uuidArray,
} from "@caelo-cms/query-api";
import { err, ok, pageModuleContentSetManySchema } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { withHumanisedLinks } from "../../links/humanise.js";
import {
  loadBranchedModuleStates,
  loadContentInstanceBranchStates,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { runEveryItem } from "../_bulk.js";
import { setContentInstanceValuesOp } from "./content-instances.js";
import { loadNestedContent, placementFieldsOf } from "./page-content-tree.js";

/** A module field as `list_for_page` returns it (see page-content-tree.ts). */
const placementFieldSchema = z.object({
  name: z.string(),
  kind: z.string(),
  default: z.unknown().optional(),
  listType: z.string().optional(),
  bind: z.string().optional(),
});

const pageModuleContentRowSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  blockName: z.string(),
  position: z.number().int().nonnegative(),
  contentValues: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function rowTo(r: {
  id: string;
  page_id: string;
  block_name: string;
  position: number;
  content_values: unknown;
  version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}): z.infer<typeof pageModuleContentRowSchema> {
  const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
  const raw = r.content_values;
  return {
    id: r.id,
    pageId: r.page_id,
    blockName: r.block_name,
    position: r.position,
    contentValues: (raw ?? {}) as Record<string, unknown>,
    version: typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/**
 * Look up the current content row for a (page, block, position) placement.
 * Returns null if the placement exists in `page_modules` but no content row
 * has been written yet (i.e. before its first edit).
 */
export const getPageModuleContentOp = withHumanisedLinks(
  defineOperation({
    name: "page_module_content.get",
    readScope: "request",
    // #397 — plugin actors read too (international-site's translator).
    actorScope: ["human", "ai", "plugin", "system"],
    database: "cms_admin",
    input: z
      .object({
        pageId: z.string().uuid(),
        blockName: z.string().min(1),
        position: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.object({ content: pageModuleContentRowSchema.nullable() }),
    handler: async (_ctx, input, tx) => {
      const rows = (await tx.execute(sql`
      SELECT id::text AS id, page_id::text AS page_id, block_name, position,
             content_values, version, created_at, updated_at
      FROM page_module_content
      WHERE page_id = ${input.pageId}::uuid
        AND block_name = ${input.blockName}
        AND position = ${input.position}
      LIMIT 1
    `)) as unknown as Parameters<typeof rowTo>[0][];
      const r = rows[0];
      return ok({ content: r ? rowTo(r) : null });
    },
  }),
);

/**
 * The nested content instance at `path` inside the placement bound to
 * `rootId`, as the caller sees it — or why it may not be written: it does
 * not exist, or another page renders it too (`fork` names the remedy).
 */
async function resolveNestedTarget(
  tx: TransactionRunner,
  chatBranchId: string | null,
  rootId: string,
  path: string,
): Promise<
  { ok: true; contentInstanceId: string } | { ok: false; message: string; fork: boolean }
> {
  const rows = (await tx.execute(sql`
    SELECT "values" FROM content_instances WHERE id = ${rootId}::uuid AND deleted_at IS NULL
  `)) as unknown as { values: unknown }[];
  let values = rows[0] ? ((rows[0].values ?? {}) as Record<string, unknown>) : undefined;
  if (chatBranchId) {
    const branched = (await loadContentInstanceBranchStates(tx, [rootId], chatBranchId)).get(
      rootId,
    );
    if (branched)
      values = branched.deletedAt ? undefined : (branched.values as Record<string, unknown>);
  }
  if (values === undefined) {
    return { ok: false, message: `content instance ${rootId} does not exist`, fork: false };
  }
  const tree = await loadNestedContent(tx, chatBranchId, [
    { key: "root", contentInstanceId: rootId, values },
  ]);
  const hit = tree.get("root")?.find((n) => n.path === path);
  if (!hit) {
    return {
      ok: false,
      message: `no nested content at "${path}" — page_module_content.list_for_page lists the nested paths`,
      fork: false,
    };
  }
  if (!hit.exclusive) {
    return {
      ok: false,
      message: `the nested content at "${path}" is shared with another page; writing it would change that page too`,
      fork: true,
    };
  }
  return { ok: true, contentInstanceId: hit.contentInstanceId };
}

/**
 * Set / upsert the content values for a placement. Emits a snapshot tagged
 * with the caller's `chat_branch_id` so the preview overlay shows the new
 * content only on the chat that authored it; publish merges the branch
 * snapshot into the live row.
 */
export const setPageModuleContentOp = defineOperation({
  name: "page_module_content.set",
  readScope: "request",
  // #397 — plugin actors write translated values (decision 3: signed
  // plugins hold cms_admin writes; every write still snapshots).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      blockName: z.string().min(1),
      position: z.number().int().nonnegative(),
      /**
       * Object mapping module field name → value. Fully replaces the
       * existing `content_values` (callers patch by reading first via
       * `page_module_content.get` if they need merge semantics).
       */
      contentValues: z.record(z.string(), z.unknown()),
      /**
       * Write the NESTED content at this path inside the placement
       * (`cards[2]`, `hero>cta`; the paths `list_for_page` returns)
       * instead of the placement's own. The write is bound to this page:
       * it is refused when another page renders the same nested instance.
       */
      nestedPath: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({ pageModuleContentId: z.string() }),
  handler: async (ctx, input, tx) => {
    // A routing shim (reached per item from set_page_module_content_many
    // via page_module_content.set_many). It resolves (page, block,
    // position) → the placement's content_instance_id + sync_mode and
    // forwards the unsynced (much more common) case to
    // content_instances.set_values, which owns locks, branch isolation and
    // snapshot bookkeeping. A synced placement is refused with a pointer
    // at fork_placement_content or set_content_instance_values_many, so
    // the operator's "edit this hero on /home" intent never silently
    // propagates to every other page bound to the same instance.
    //
    // #1045 — the placement is resolved through the caller's
    // branch-overlaid layout (the same view the preview renders and
    // `patch_fields` uses). Reading live `page_modules` first and the
    // branch snapshot only as a fallback made every write on the shared
    // draft hit MAIN's placement at that position as soon as the branch
    // had reshaped the page (add_module, fork, remove + build_page):
    // positions shift on the branch, main still has a row there, and the
    // edit landed on the wrong (or a stale) content instance.
    const layout = await loadPageLayoutStateWithBranchOverlay(
      tx,
      input.pageId,
      ctx.chatBranchId ?? null,
    );
    const placement = layout.blocks.find((b) => b.blockName === input.blockName)?.placements?.[
      input.position
    ];
    if (!placement) {
      return err({
        kind: "HandlerError",
        operation: "page_module_content.set",
        message: `no placement at (${input.blockName}, ${input.position}) on page ${input.pageId}`,
        nextAction: {
          tool: "inspect_page_render",
          args: { pageId: input.pageId },
          reason:
            "fetch the page's actual blocks + placements; pick a (blockName, position) pair that exists and retry",
        },
      });
    }

    if (placement.syncMode === "synced") {
      return err({
        kind: "HandlerError",
        operation: "page_module_content.set",
        message:
          `placement at (${input.blockName}, ${input.position}) on page ${input.pageId} is SYNCED to content_instance ${placement.contentInstanceId}. ` +
          `Editing via set_page_module_content_many would propagate to every page bound to the same instance, ` +
          `which is rarely the intent of "set the content on this page". ` +
          `Either (a) call set_content_instance_values_many({ items: [{ id: "${placement.contentInstanceId}", values: ... }] }) to commit to the blast radius, or ` +
          `(b) call fork_placement_content first to detach this placement into a private instance, then retry.`,
        nextAction: {
          tool: "fork_placement_content",
          args: {
            pageId: input.pageId,
            blockName: input.blockName,
            position: input.position,
          },
          reason:
            "detach this placement so the edit stays local to this page; rerun set_page_module_content_many after the fork",
        },
      });
    }

    // Nested content: resolved from THIS placement's tree, written only
    // when no other page renders it (plugins hold this op, never
    // content_instances.set_values: a write stays bound to a page).
    let targetId = placement.contentInstanceId;
    if (input.nestedPath !== undefined) {
      const nested = await resolveNestedTarget(
        tx,
        ctx.chatBranchId ?? null,
        placement.contentInstanceId,
        input.nestedPath,
      );
      if (!nested.ok) {
        return err({
          kind: "HandlerError",
          operation: "page_module_content.set",
          message: `${nested.message} (placement ${input.blockName}#${input.position} on page ${input.pageId})`,
          ...(nested.fork
            ? {
                nextAction: {
                  tool: "fork_placement_content",
                  args: {
                    pageId: input.pageId,
                    blockName: input.blockName,
                    position: input.position,
                  },
                  reason:
                    "the fork copies the placement's nested content, so this page owns it; retry the write after the fork",
                },
              }
            : {}),
        });
      }
      targetId = nested.contentInstanceId;
    }

    // Unsynced — write through to content_instances.set_values. The
    // op handles the lock + branch isolation + snapshot.
    const setValuesResult = await setContentInstanceValuesOp.handler(
      ctx,
      {
        id: targetId,
        values: input.contentValues,
      },
      tx,
    );
    if (!setValuesResult.ok) {
      // Forward the error with the shim's operation tag so audit + the
      // AI's error-handling expectations stay consistent.
      const inner = setValuesResult.error as {
        message?: string;
        nextAction?: { tool: string; args?: Record<string, unknown>; reason: string };
      };
      return err({
        kind: "HandlerError" as const,
        operation: "page_module_content.set",
        message: inner.message ?? "content_instances.set_values failed",
        nextAction: inner.nextAction,
      });
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "page_module_content.set",
      input,
      succeeded: true,
      entityId: placement.contentInstanceId,
      resultSummary: `routed=content_instances.set_values fields=${Object.keys(input.contentValues).length}`,
    });

    return ok({ pageModuleContentId: placement.contentInstanceId });
  },
});

/**
 * Issue #299 — bulk variant of `page_module_content.set` per CLAUDE.md
 * §11. A content-only pass over N existing placements (run #15 fired
 * the singular 29× at 110K–556K input tokens per round-trip).
 *
 * Each item runs the exact singular path — placement resolution
 * (branch-aware), synced-placement refusal, nested-ref + field-shape
 * validation, lock, snapshot — inside ONE shared transaction.
 *
 * All-or-nothing: every item runs, and any failure throws
 * `OperationAbortError` so the written items roll back too. The error
 * names every failing `items[i]` and forwards each singular error under
 * it (field paths for value-shape problems, the fork/commit guidance for
 * synced placements) (#1277).
 */
export const setPageModuleContentManyOp = defineOperation({
  name: "page_module_content.set_many",
  readScope: "request",
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: pageModuleContentSetManySchema,
  output: z.object({ updated: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    // #1277 — every item runs; every failing index is reported at once.
    const run = await runEveryItem("page_module_content.set_many", "items", input.items, (item) =>
      setPageModuleContentOp.handler(ctx, item, tx),
    );
    if (!run.ok) {
      if (run.writtenItems === 0) return err(run.error);
      throw new OperationAbortError(run.error);
    }
    const updated = run.results.length;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "page_module_content.set_many",
      input,
      succeeded: true,
      resultSummary: `updated=${updated}`,
    });
    return ok({ updated });
  },
});

/**
 * #397 — every placement of a page with its EFFECTIVE content values
 * (from the bound content_instance) + module slug, ordered by (blockName, position) — deterministic and identical to the preview composer's per-block ordering, though template/layout slot layout decides actual on-page visual order.
 * The read surface the international-site translator builds its
 * whole-page prompt from; open to plugin actors like the other reads.
 *
 * `fields` (with defaults) and `nested` (./page-content-tree.ts) carry
 * the text the stored values alone miss: copy that renders from a field
 * default, and the content of nested modules.
 */
export const listPageModuleContentOp = withHumanisedLinks(
  defineOperation({
    name: "page_module_content.list_for_page",
    readScope: "request",
    actorScope: ["human", "ai", "plugin", "system"],
    database: "cms_admin",
    input: z.object({ pageId: z.string().uuid() }).strict(),
    output: z.object({
      placements: z.array(
        z.object({
          blockName: z.string(),
          position: z.number().int().nonnegative(),
          moduleSlug: z.string(),
          values: z.record(z.string(), z.unknown()),
          contentInstanceId: z.string(),
          fields: z.array(placementFieldSchema),
          nested: z.array(
            z.object({
              path: z.string(),
              contentInstanceId: z.string(),
              moduleSlug: z.string(),
              fields: z.array(placementFieldSchema),
              values: z.record(z.string(), z.unknown()),
              exclusive: z.boolean(),
            }),
          ),
        }),
      ),
    }),
    handler: async (ctx, input, tx) => {
      // #1045 — the caller's view of the page: the branch-overlaid layout,
      // each instance's branch state, each module's branch state. Reading
      // live `page_modules` / `content_instances` handed a chat main's
      // placements and pre-edit values, so a translation (or any reader)
      // built on it overwrote the draft with stale content.
      const branchId = ctx.chatBranchId ?? null;
      const layout = await loadPageLayoutStateWithBranchOverlay(tx, input.pageId, branchId);
      const placed = layout.blocks
        .flatMap((b) => {
          if (!b.placements) {
            throw new Error(
              `page_module_content.list_for_page: layout of page ${input.pageId} block ${b.blockName} has no placements — the snapshot predates v0.12; undo that chat's layout change and redo it`,
            );
          }
          return b.placements.map((p, position) => ({ blockName: b.blockName, position, ...p }));
        })
        .sort((a, b) => a.blockName.localeCompare(b.blockName) || a.position - b.position);
      if (placed.length === 0) return ok({ placements: [] });

      const moduleIds = [...new Set(placed.map((p) => p.moduleId))];
      const instanceIds = [...new Set(placed.map((p) => p.contentInstanceId))];
      const moduleRows = (await tx.execute(sql`
        SELECT id::text AS id, slug, fields, deleted_at FROM modules
        WHERE id = ANY(${uuidArray(moduleIds)})
      `)) as unknown as {
        id: string;
        slug: string;
        fields: unknown;
        deleted_at: string | Date | null;
      }[];
      const modules = new Map(
        moduleRows.map((m) => [
          m.id,
          { slug: m.slug, fields: placementFieldsOf(m.fields), deleted: m.deleted_at !== null },
        ]),
      );
      const instanceRows = (await tx.execute(sql`
        SELECT id::text AS id, "values" FROM content_instances
        WHERE id = ANY(${uuidArray(instanceIds)})
      `)) as unknown as { id: string; values: unknown }[];
      const values = new Map<string, Record<string, unknown>>(
        instanceRows.map((r) => [r.id, (r.values ?? {}) as Record<string, unknown>]),
      );
      if (branchId) {
        for (const [id, state] of await loadBranchedModuleStates(tx, branchId, moduleIds)) {
          modules.set(id, {
            slug: state.slug,
            fields: placementFieldsOf(state.fields),
            deleted: state.deletedAt !== null,
          });
        }
        for (const [id, state] of await loadContentInstanceBranchStates(
          tx,
          instanceIds,
          branchId,
        )) {
          values.set(id, state.values);
        }
      }
      const live = placed.flatMap((p) => {
        const m = modules.get(p.moduleId);
        if (!m || m.deleted) return [];
        const v = values.get(p.contentInstanceId);
        if (v === undefined) {
          throw new Error(
            `page_module_content.list_for_page: placement ${p.blockName}#${p.position} of page ${input.pageId} binds content_instance ${p.contentInstanceId}, which does not exist`,
          );
        }
        return [{ p, m, v, key: `${p.blockName}|${p.position}` }];
      });
      const nested = await loadNestedContent(
        tx,
        branchId,
        live.map((l) => ({ key: l.key, contentInstanceId: l.p.contentInstanceId, values: l.v })),
      );
      return ok({
        placements: live.map(({ p, m, v, key }) => ({
          blockName: p.blockName,
          position: p.position,
          moduleSlug: m.slug,
          values: v,
          contentInstanceId: p.contentInstanceId,
          fields: m.fields,
          nested: nested.get(key) ?? [],
        })),
      });
    },
  }),
);
