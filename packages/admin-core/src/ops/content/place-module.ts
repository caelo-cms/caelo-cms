// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1246 — `pages.place_module`: the write half of the `add_module`
 * tool as ONE transaction. Optional module mint, the splice into a block of
 * one page / every page of a template / a layout, and the new placements'
 * initial content all commit together or not at all.
 *
 * Before, `add_module` ran `modules.create`, `pages.set_modules` and
 * `content_instances.set_values` as separate ops: a `values` entry that did
 * not fit the module's fields left the module placed with EMPTY content (and,
 * in mint mode, a minted module behind) — #1149, #1246. The tool then had to
 * tell the AI "it IS placed, do not call add_module again", which an AI fixing
 * its values reads as one more state to track.
 *
 * Reuse over reimplementation (like `pages.build_page`): the handler runs the
 * existing op handlers (`modules.create`, `pages.set_modules`,
 * `content_instances.set_values`, `layout_modules.get/set`) with the SHARED
 * tx, so every validation rule, lock, audit row and snapshot those paths emit
 * applies unchanged. Any nested failure THROWS `OperationAbortError` so the
 * adapter rolls the whole call back — a returned error would commit the
 * writes made before it.
 */

import { defineOperation, OperationAbortError, type QueryError } from "@caelo-cms/query-api";
import {
  contentInstanceUpdateSchema,
  moduleCreateSchema,
  ok,
  type Result,
} from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { loadPageLayoutStateWithBranchOverlay } from "../../snapshots/index.js";
import { setContentInstanceValuesOp } from "./content-instances.js";
import { getLayoutBlockModulesOp, setLayoutModulesOp } from "./layouts.js";
import { createModuleOp } from "./modules.js";
import { setPageModulesOp } from "./pages.js";

const OP = "pages.place_module";

/** `top` / `bottom` / a 0-based index (clamped to the block's length). */
/**
 * Most pages one call places on, in one transaction. A template fan-out
 * beyond it is refused by `add_module` with what to do instead.
 */
export const PLACE_MODULE_MAX_PAGES = 5000;

const positionSchema = z.union([z.enum(["top", "bottom"]), z.number().int().min(0).max(1000)]);

export const placeModuleInputSchema = z
  .object({
    /** Pages (one, or every page of a template) or one layout. */
    target: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("pages"),
          pageIds: z.array(z.string().uuid()).min(1).max(PLACE_MODULE_MAX_PAGES),
        })
        .strict(),
      z.object({ kind: z.literal("layout"), layoutId: z.string().uuid() }).strict(),
    ]),
    blockName: z.string().min(1).max(80),
    position: positionSchema,
    /** Place an existing module, or mint one with `modules.create`'s input. */
    module: z.union([
      z.object({ moduleId: z.string().uuid() }).strict(),
      z.object({ create: moduleCreateSchema }).strict(),
    ]),
    /**
     * Initial content of every new page placement (each gets its own copy).
     * Layout chrome has no content instance: its copy is the minted
     * module's field defaults, so `values` is refused there.
     */
    values: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => v.target.kind === "pages" || v.values === undefined, {
    path: ["values"],
    message:
      "layout chrome has no content instance — put the copy into the minted module's field defaults",
  });

/** Insert `moduleId` into `existing` at `position`; returns the new list + its index. */
export function spliceAt<T>(
  existing: readonly T[],
  item: T,
  position: z.infer<typeof positionSchema>,
): { items: T[]; idx: number } {
  const idx =
    position === "top"
      ? 0
      : position === "bottom"
        ? existing.length
        : Math.min(position, existing.length);
  return { items: [...existing.slice(0, idx), item, ...existing.slice(idx)], idx };
}

/** Unwrap a nested op's result; any failure aborts (rolls back) the whole call. */
function orAbort<T>(r: Result<T, QueryError>): T {
  if (!r.ok) throw new OperationAbortError(r.error);
  return r.value;
}

export const placeModuleOp = defineOperation({
  name: OP,
  readScope: "request",
  // CLAUDE.md §11 — the AI reaches this through `add_module`.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: placeModuleInputSchema,
  output: z.object({
    moduleId: z.string(),
    /** True when this call minted the module. */
    minted: z.boolean(),
    /** One per page placed (pages target) — the index it landed at. */
    placements: z.array(
      z.object({
        pageId: z.string(),
        position: z.number().int().nonnegative(),
        contentInstanceId: z.string(),
      }),
    ),
    /** The index in the layout block (layout target), else null. */
    layoutPosition: z.number().int().nonnegative().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    let moduleId: string;
    const minted = "create" in input.module;
    if ("create" in input.module) {
      const created = orAbort(await createModuleOp.handler(ctx, input.module.create, tx));
      moduleId = (created as { moduleId: string }).moduleId;
    } else {
      moduleId = input.module.moduleId;
    }

    if (input.target.kind === "layout") {
      const { layoutId } = input.target;
      const existing = orAbort(
        await getLayoutBlockModulesOp.handler(ctx, { layoutId, blockName: input.blockName }, tx),
      ) as { moduleIds: string[] };
      const { items, idx } = spliceAt(existing.moduleIds, moduleId, input.position);
      orAbort(
        await setLayoutModulesOp.handler(
          ctx,
          { layoutId, blockName: input.blockName, moduleIds: items },
          tx,
        ),
      );
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: OP,
        input,
        succeeded: true,
        entityId: layoutId,
        resultSummary: `layout block=${input.blockName}@${idx} minted=${minted}`,
      });
      return ok({ moduleId, minted, placements: [], layoutPosition: idx });
    }

    const branchId = ctx.chatBranchId ?? null;
    const placements: { pageId: string; position: number; contentInstanceId: string }[] = [];
    for (const pageId of input.target.pageIds) {
      // The caller's branch view, so a chat's own pending placements stay.
      // Every surviving placement is named by its content instance (#1195),
      // so no placement trades content with another while the block shifts.
      // A block without placement metadata (a pre-v0.12 layout snapshot)
      // names none and leaves the binding to pages.set_modules' own
      // per-(block, module) carry-over, exactly as a direct call would.
      const prior = await loadPageLayoutStateWithBranchOverlay(tx, pageId, branchId);
      const blocks: {
        blockName: string;
        moduleIds: string[];
        contentInstanceIds?: (string | null)[];
      }[] = prior.blocks.map((b) => ({
        blockName: b.blockName,
        moduleIds: [...b.moduleIds],
        ...(b.placements !== undefined && b.placements.length === b.moduleIds.length
          ? { contentInstanceIds: b.placements.map((p) => p.contentInstanceId) }
          : {}),
      }));
      let target = blocks.find((b) => b.blockName === input.blockName);
      if (!target) {
        target = { blockName: input.blockName, moduleIds: [], contentInstanceIds: [] };
        blocks.push(target);
      }
      const spliced = spliceAt(target.moduleIds, moduleId, input.position);
      target.moduleIds = spliced.items;
      if (target.contentInstanceIds !== undefined) {
        target.contentInstanceIds = spliceAt(target.contentInstanceIds, null, input.position).items;
      }
      orAbort(await setPageModulesOp.handler(ctx, { pageId, blocks }, tx));

      // The instance pages.set_modules minted for the new placement.
      const after = await loadPageLayoutStateWithBranchOverlay(tx, pageId, branchId);
      const contentInstanceId = after.blocks.find((b) => b.blockName === input.blockName)
        ?.placements?.[spliced.idx]?.contentInstanceId;
      if (!contentInstanceId) {
        throw new OperationAbortError({
          kind: "HandlerError",
          operation: OP,
          message: `the new placement on page ${pageId} has no content instance — a defect in Caelo, reported automatically; nothing was written`,
        });
      }
      if (input.values !== undefined) {
        // A copy per page: set_values normalises its input in place.
        const setInput = contentInstanceUpdateSchema.parse({
          id: contentInstanceId,
          values: structuredClone(input.values),
        });
        orAbort(await setContentInstanceValuesOp.handler(ctx, setInput, tx));
      }
      placements.push({ pageId, position: spliced.idx, contentInstanceId });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: OP,
      input,
      succeeded: true,
      entityId: moduleId,
      resultSummary: `pages=${placements.length} block=${input.blockName} minted=${minted} values=${input.values !== undefined}`,
    });
    return ok({ moduleId, minted, placements, layoutPosition: null });
  },
});
