// SPDX-License-Identifier: MPL-2.0

/**
 * The side effects of a page URL move — ONE implementation for every
 * cause: a slug change, a reparent / subtree move, a chat's moves going
 * live at publish, a plugin URL-shape change.
 *
 * A move is never just a column write: the old URL must keep working
 * (301), redirects that pointed at the old URL must not become chains,
 * a redirect sitting on the page's NEW URL must yield to the page, and
 * every nav-menu / link-list / module / content link that named the old
 * URL must follow. All of it runs on the caller's transaction, so the
 * move commits or rolls back as a whole (CLAUDE.md §11: a multi-step
 * patch belongs inside one op).
 *
 * Always main-line: callers pass a context without a chat branch —
 * redirects and link targets are live state, like the paths they follow.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { createRedirectOp } from "../redirects.js";
import { rewriteModuleLinksOp } from "../seo.js";
import { listStructuredSetsOp, setStructuredSetOp } from "../structured_sets.js";
import type { PathMove } from "./current-path.js";
import { buildPathMoveMap, rewritePathLinksInJson } from "./path-link-rewrite.js";

/** What a move set changed besides the paths themselves. */
export interface PathMoveEffects {
  readonly redirectsCreated: number;
  readonly rewrittenSets: number;
  readonly rewrittenModules: number;
  readonly rewrittenContentInstances: number;
  /**
   * Link sets whose rewrite was refused (another chat holds them). Their
   * stale links still reach the page through the 301; the caller reports
   * them so the AI can fix them once the set is free.
   */
  readonly blockedSets: readonly string[];
}

/**
 * Apply the side effects of already-persisted path moves.
 *
 * @param redirects `"skip"` suppresses the old-URL 301s (operator asked
 *   for the old URLs to 404); `{ skip }` decides per moved page (a publish
 *   carrying moves with different requests). Chain collapse, reclaim and
 *   link rewrites always run over the WHOLE move set in one pass — split
 *   passes would re-collapse one subset's fresh redirects and rewrite
 *   links twice.
 */
export async function applyPathMoveEffects(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  moves: ReadonlyArray<PathMove>,
  redirects: "auto" | "skip" | { readonly skip: (pageId: string) => boolean },
): Promise<PathMoveEffects> {
  const skipsRedirect = (pageId: string): boolean =>
    redirects === "skip" ? true : redirects === "auto" ? false : redirects.skip(pageId);
  const real = moves.filter((m) => m.from !== m.to);
  if (real.length === 0) {
    return {
      redirectsCreated: 0,
      rewrittenSets: 0,
      rewrittenModules: 0,
      rewrittenContentInstances: 0,
      blockedSets: [],
    };
  }
  const { chatBranchId: _b, chatTaskId: _t, ...mainCtx } = ctx;

  // A page now lives at each new path: a redirect from there (e.g. left
  // by an earlier move away, now moved back) would shadow it — drop it
  // BEFORE collapsing chains, or "new → old" would collapse into a
  // self-loop.
  const newPaths = new Set(real.map((m) => m.to));
  for (const m of real) {
    await tx.execute(sql`DELETE FROM redirects WHERE from_path = ${m.to}`);
  }
  // Collapse chains: X → old becomes X → new, so a visitor hops once.
  // ONE statement against the original targets: with chained or swapped
  // moves (/a → /b, /b → /c) sequential updates would carry "/legacy →
  // /a" on to /c, i.e. to the wrong page.
  await tx.execute(sql`
    UPDATE redirects r SET to_path = m.new_path
    FROM (VALUES ${sql.join(
      real.map((m) => sql`(${m.from}, ${m.to})`),
      sql`, `,
    )}) AS m(old_path, new_path)
    WHERE r.to_path = m.old_path
  `);
  let redirectsCreated = 0;
  for (const m of real) {
    if (skipsRedirect(m.pageId)) continue;
    // Two pages swapping URLs: the old URL is another page's new home.
    if (newPaths.has(m.from)) continue;
    const red = await createRedirectOp.handler(
      mainCtx,
      { fromPath: m.from, toPath: m.to, statusCode: 301 },
      tx,
    );
    // Loud: a move whose 301 failed is exactly the state that strands
    // inbound links, so it aborts the whole transaction.
    if (!red.ok) throw new Error(`page move aborted — redirect ${m.from} → ${m.to} failed`);
    redirectsCreated += 1;
  }

  const map = buildPathMoveMap(real);
  let rewrittenSets = 0;
  const blockedSets: string[] = [];
  // Only these kinds carry hrefs; the rest would be wasted reads.
  for (const kind of ["nav-menu", "link-list"] as const) {
    const listed = await listStructuredSetsOp.handler(mainCtx, { kind }, tx);
    if (!listed.ok) {
      throw new Error(`page move aborted — could not list ${kind} sets to rewrite their links`);
    }
    const sets = (
      listed.value as { sets: { slug: string; displayName: string; items: unknown[] }[] }
    ).sets;
    for (const s of sets) {
      const next = rewritePathLinksInJson(s.items, map);
      if (next === s.items) continue;
      const w = await setStructuredSetOp.handler(
        mainCtx,
        { kind, slug: s.slug, displayName: s.displayName, items: next as unknown[] },
        tx,
      );
      if (!w.ok) {
        blockedSets.push(`${kind}:${s.slug}`);
        continue;
      }
      rewrittenSets += 1;
    }
  }

  if (map.size === 0) {
    return {
      redirectsCreated,
      rewrittenSets,
      rewrittenModules: 0,
      rewrittenContentInstances: 0,
      blockedSets,
    };
  }
  const rewrite = await rewriteModuleLinksOp.handler(
    { ...mainCtx, actorKind: "system" },
    { moves: [...map].map(([fromPath, toPath]) => ({ fromPath, toPath })) },
    tx,
  );
  if (!rewrite.ok) throw new Error("page move aborted — rewriting module links failed");
  const rv = rewrite.value as {
    rewrittenModuleIds: string[];
    rewrittenContentInstanceIds: string[];
  };
  return {
    redirectsCreated,
    rewrittenSets,
    rewrittenModules: rv.rewrittenModuleIds.length,
    rewrittenContentInstances: rv.rewrittenContentInstanceIds.length,
    blockedSets,
  };
}
