// SPDX-License-Identifier: MPL-2.0

/**
 * #1762 — a page removed on purpose: `pages.delete` with disposition
 * `"410"` leaves a 410 Gone rule at the page's address, so search engines
 * drop the URL sooner than for a 404 and nobody mistakes it for a broken
 * link.
 *
 * The rule is a redirects-table row with status 410, written like the
 * delete's 301 (#1550): an automatic change (`page_delete`), Staged, live
 * with the Publish live that ships the delete, taken back by the chat's
 * Undo. Each provider serves the table at its edge (redirect-plan.ts); the
 * hosts that cannot send a bare 410 answer the 404 a path without a file
 * gets (`goneStatusOnProvider`, docs/dev/gone-pages.md has the matrix).
 *
 * A removed page that already has a redirect keeps it: a rule at the
 * address (live, or pending and not a removal) means someone already
 * decided where the old URL leads, and turning a 301 into a 410 would
 * strand every link that followed it.
 *
 * A 410 row's target is never served; the plan only reads its from path.
 * It is stored as `/`, the one target every site has.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type ExecutionContext, redirectAddress } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { liveRowsByAddress, ownerOfContext, pendingByAddress } from "../../redirects/model.js";
import { writeRedirectChanges } from "../../redirects/write.js";
import { redirectWriteIssue } from "../redirects.js";

/** The target stored on a page delete's 410 row (never served). */
export const GONE_ROW_TARGET = "/";

/** A redirect a removed page kept instead of a 410 rule. */
export interface KeptRedirect {
  readonly fromPath: string;
  readonly toPath: string;
  readonly statusCode: number;
  /** `live`: the rule the live site serves; `pending`: a change not live yet. */
  readonly state: "live" | "pending";
}

/**
 * Leave a 410 rule at the address of the page `pageId`, deleted on this
 * transaction, unless a redirect already sits there.
 *
 * @returns the redirect the address keeps, or null when the 410 was written.
 * @throws when the page has no path, is the site's home (its address is the
 *   root, where a 410 would take the whole site's front door), or a static
 *   file owns the path: the caller's transaction aborts with the delete.
 */
export async function writeGoneRule(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  pageId: string,
  causeSnapshotId: string | null,
): Promise<KeptRedirect | null> {
  const rows = (await tx.execute(sql`
    SELECT current_path FROM pages WHERE id = ${pageId}::uuid
  `)) as unknown as { current_path: string }[];
  const fromPath = rows[0]?.current_path;
  if (fromPath === undefined) {
    throw new Error(`page delete aborted — page ${pageId} has no current_path`);
  }
  const address = redirectAddress(fromPath);
  if (address === redirectAddress(GONE_ROW_TARGET)) {
    throw new Error(
      `page delete aborted — page ${pageId} is the site's home (${fromPath}); its address cannot answer 410 Gone. Make another page the home page first (set_home_page), or delete it with disposition "404" or "redirect".`,
    );
  }
  const pending = (await pendingByAddress(tx, [address])).get(address);
  if (pending && pending.toPath !== null && pending.statusCode !== null) {
    return {
      fromPath: pending.fromPath,
      toPath: pending.toPath,
      statusCode: pending.statusCode,
      state: "pending",
    };
  }
  // A pending removal of the live rule is a decision too, but to leave the
  // address free: the 410 replaces it.
  const live = pending ? [] : ((await liveRowsByAddress(tx, [address])).get(address) ?? []);
  const rule = live[0];
  if (rule) {
    return {
      fromPath: rule.fromPath,
      toPath: rule.toPath,
      statusCode: rule.statusCode,
      state: "live",
    };
  }
  const issue = await redirectWriteIssue(tx, fromPath, GONE_ROW_TARGET);
  if (issue) throw new Error(`page delete aborted — 410 for ${fromPath}: ${issue}`);
  await writeRedirectChanges(tx, [{ fromPath, toPath: GONE_ROW_TARGET, statusCode: 410 }], {
    origin: "page_delete",
    state: "staged",
    owner: await ownerOfContext(tx, ctx, "pages.delete"),
    causeSnapshotId,
  });
  return null;
}
