// SPDX-License-Identifier: MPL-2.0

/**
 * #1453 — writes that know exactly which shared content they touch.
 *
 * `placement.fork_content` deep-copies a placement: right for "this page
 * goes its own way", wrong for a language version that shares part of its
 * tree on purpose. international-site's update pass forked through it, so
 * changing one text replaced the page's whole nested tree with private
 * copies, and instances the pages of a language share stopped being
 * shared.
 *
 * Who may share with whom is the plugin's knowledge: core has no language
 * concept (epic #380). So core offers the two neutral halves: where an
 * instance renders (`content_instances.rendered_on_many`), and a copy of
 * exactly the instances a caller names (`placement.fork_paths`). The
 * write stays bound to pages: anything the op changes in place has to
 * render only on pages the caller declared, which core checks itself
 * instead of trusting the caller's earlier read.
 */

import { defineOperation, OperationAbortError, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import { emitSnapshot, loadPageLayoutStateWithBranchOverlay } from "../../snapshots/index.js";
import { insertContentInstanceCopies, loadInstancesInView } from "./content-instance-clone.js";
import { loadContentInstanceReach } from "./content-instance-reach.js";
import { rebindPlacementToFork, setContentInstanceValuesOp } from "./content-instances.js";
import { loadNestedContent, rewriteNestedRefsAt } from "./page-content-tree.js";

/** Other pages a write may change. Bounded by the site size target (50k pages). */
export const alsoChangesPagesSchema = z.array(z.string().uuid()).max(50_000);

/** One reason per instance that renders somewhere outside `allowedPageIds`. */
export async function rendersBeyond(
  tx: TransactionRunner,
  chatBranchId: string | null,
  contentInstanceIds: readonly string[],
  allowedPageIds: readonly string[],
): Promise<string[]> {
  const allowed = new Set(allowedPageIds);
  const out: string[] = [];
  const reach = await loadContentInstanceReach(tx, chatBranchId, contentInstanceIds);
  for (const [id, r] of reach) {
    const pages = r.pages.filter((p) => !allowed.has(p.pageId)).map((p) => p.path);
    if (pages.length > 0) {
      out.push(`content instance ${id} also renders on ${pages.slice(0, 5).join(", ")}`);
    }
    if (r.chromeLayouts.length > 0 || r.viaLists.length > 0) {
      out.push(`content instance ${id} renders site-wide (layout chrome or a shared list)`);
    }
  }
  return out;
}

export const contentInstancesRenderedOnManyOp = defineOperation({
  name: "content_instances.rendered_on_many",
  readScope: "request",
  // Why system-only (plugins included): a building block for a plugin that
  // writes shared content. The AI reads the same through get_content_instance and
  // list_content_instances, which carry the context to decide with.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }).strict(),
  output: z.object({
    instances: z.array(
      z.object({
        id: z.string(),
        /** Every live page it renders on, directly or through a parent. */
        pageIds: z.array(z.string()),
        /** It also renders in layout chrome or a shared list. */
        siteWide: z.boolean(),
      }),
    ),
  }),
  handler: async (ctx, input, tx) => {
    const reach = await loadContentInstanceReach(tx, ctx.chatBranchId ?? null, input.ids);
    return ok({
      instances: [...reach].map(([id, r]) => ({
        id,
        pageIds: r.pages.map((p) => p.pageId),
        siteWide: r.chromeLayouts.length > 0 || r.viaLists.length > 0,
      })),
    });
  },
});

const forkPathsInput = z
  .object({
    pageId: z.string().uuid(),
    blockName: z.string().min(1).max(80),
    position: z.number().int().nonnegative(),
    /** Copy the instance the placement binds, and bind the copy unsynced. */
    root: z.boolean(),
    /** Copy the nested instances at these paths (`list_for_page`'s paths). */
    nestedPaths: z.array(z.string().min(1).max(500)).max(1000),
    /**
     * Pages besides `pageId` an in-place change may reach: an instance on
     * the way to a copy that is not copied itself is rewritten to point at
     * the copy, which shows on every page that instance renders on.
     */
    alsoChangesPages: alsoChangesPagesSchema,
  })
  .strict()
  .refine((v) => v.root || v.nestedPaths.length > 0, {
    message: "name something to copy: root, or at least one nested path",
  });

/**
 * Give a placement its own copy of exactly the named instances, leaving
 * the rest of its tree where it is.
 *
 * Each copy is shallow: its other nested references keep pointing at what
 * they pointed at. Every instance between the placement and a copy is
 * rewritten to reference the copy, in place unless it is named too. One
 * instance reached by several named paths gets one copy, so sharing
 * inside the tree is kept, as in a deep copy.
 *
 * Only the named references move: a parent outside the named paths keeps
 * its reference, and so does a parent's other reference to the same
 * instance.
 */
export const forkPlacementPathsOp = defineOperation({
  name: "placement.fork_paths",
  readScope: "request",
  // Why system-only (plugins included): which instances to copy is a
  // decision the caller needs reach and language data for. The AI forks a placement
  // whole through fork_placement_content, and edits a shared instance on
  // purpose through set_content_instance_values_many.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: forkPathsInput,
  output: z.object({
    /** The instance the placement binds now. */
    contentInstanceId: z.string(),
    copied: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const operation = "placement.fork_paths";
    const refuse = (message: string) => err({ kind: "HandlerError" as const, operation, message });
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(await entityWriteBlockedError(tx, operation, "page", input.pageId, lock));
    }
    const branchId = ctx.chatBranchId ?? null;
    const layout = await loadPageLayoutStateWithBranchOverlay(tx, input.pageId, branchId);
    const placement = layout.blocks.find((b) => b.blockName === input.blockName)?.placements?.[
      input.position
    ];
    if (!placement) {
      return refuse(
        `no placement at (${input.blockName}, ${input.position}) on page ${input.pageId}`,
      );
    }
    const rootId = placement.contentInstanceId;
    const root = (await loadInstancesInView(tx, [rootId], branchId)).get(rootId);
    if (!root || root.deleted) {
      return refuse(
        `content instance ${rootId} is ${root ? "deleted" : "missing"} but still placed on the page; bind the placement to existing content before copying`,
      );
    }

    // The named chains as edges between instances, each edge the
    // reference's path inside its parent: one instance reached twice is
    // one node, so it is copied and rewritten once.
    const tree = await loadNestedContent(tx, branchId, input.pageId, [
      { key: "root", contentInstanceId: rootId, values: root.values },
    ]);
    const idAt = new Map((tree.get("root") ?? []).map((n) => [n.path, n.contentInstanceId]));
    const named = new Set(input.root ? [rootId] : []);
    const childrenOf = new Map<string, Map<string, string>>();
    for (const path of input.nestedPaths) {
      let parent = rootId;
      let prefix = "";
      for (const step of path.split(">")) {
        prefix = prefix === "" ? step : `${prefix}>${step}`;
        const id = idAt.get(prefix);
        if (id === undefined) {
          return refuse(
            `no nested content at "${prefix}" of placement ${input.blockName}#${input.position} — page_module_content.list_for_page lists the nested paths`,
          );
        }
        const children = childrenOf.get(parent) ?? new Map<string, string>();
        children.set(step, id);
        childrenOf.set(parent, children);
        parent = id;
      }
      named.add(parent);
    }

    const ids = [...new Set([rootId, ...named, ...childrenOf.keys()])];
    const inView = await loadInstancesInView(tx, ids, branchId);
    const copyOf = new Map([...named].map((id) => [id, crypto.randomUUID()]));
    const copies: { id: string; moduleId: string; values: Record<string, unknown> }[] = [];
    const rewrites: { id: string; values: Record<string, unknown> }[] = [];
    for (const id of ids) {
      const instance = inView.get(id);
      if (!instance || instance.deleted) {
        return refuse(
          `nested content instance ${id} is ${instance ? "deleted" : "missing"} but still referenced from a module field; remove or replace that reference before copying`,
        );
      }
      const moved = new Map(
        [...(childrenOf.get(id) ?? [])].flatMap(([step, child]) => {
          const childCopy = copyOf.get(child);
          return childCopy === undefined ? [] : [[step, childCopy] as const];
        }),
      );
      const values =
        moved.size === 0 ? instance.values : rewriteNestedRefsAt(instance.values, moved);
      const copy = copyOf.get(id);
      if (copy !== undefined) copies.push({ id: copy, moduleId: instance.moduleId, values });
      else if (moved.size > 0) rewrites.push({ id, values });
    }

    const beyond = await rendersBeyond(
      tx,
      branchId,
      rewrites.map((r) => r.id),
      [input.pageId, ...input.alsoChangesPages],
    );
    if (beyond.length > 0) {
      return refuse(
        `${beyond.join("; ")} — nothing was written. Name it for copying too, or name those pages in alsoChangesPages.`,
      );
    }

    const snapshotEntities = await insertContentInstanceCopies(tx, ctx, copies);
    for (const r of rewrites) {
      const written = await setContentInstanceValuesOp.handler(ctx, r, tx);
      // Rows are written by now: `return err` would commit them.
      if (!written.ok) throw new OperationAbortError(written.error);
    }
    const boundId = copyOf.get(rootId) ?? rootId;
    const entities = input.root
      ? [
          ...snapshotEntities,
          {
            kind: "pageLayout" as const,
            entityId: input.pageId,
            state: await rebindPlacementToFork(tx, ctx, input, layout, boundId),
          },
        ]
      : snapshotEntities;
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      // A fork like any other: undo and history need no second kind.
      opKind: "placement.fork_content",
      description: `${operation} page=${input.pageId} block=${input.blockName} pos=${input.position} copied=${copies.length}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: branchId,
      entities,
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation,
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `copied=${copies.length} rewritten=${rewrites.length}`,
    });
    return ok({ contentInstanceId: boundId, copied: copies.length });
  },
});
