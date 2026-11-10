// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — redirects are draft state. An address (a from path, both
 * trailing-slash spellings together) has a live state (a row of the
 * `redirects` table, or none) and at most one pending change: a create, a
 * change or a removal, in state Draft or Staged. Draft is served nowhere.
 * A Staged change is served by staging and goes live with the Publish live
 * that ships it.
 *
 * Which Staged changes a build serves is decided here, against the files of
 * that build, so the staging gateway (the staging view, against the staged
 * build) and the admin (Publish live, against the build going live; Go live
 * now, against the live build) decide the same way:
 *
 * - **A change waits for its target.** A change whose same-site target the
 *   build does not serve (after the plan's chain collapse) is left out: the
 *   address keeps its live state, and the change stays Staged until a build
 *   that serves the target goes live. An address on another domain, a
 *   target under `/api/` and a 410 never wait.
 * - **An automatic removal waits for its page.** A page that moves onto an
 *   address takes it over from the rule there (`applyPathMoveEffects`). That
 *   removal goes live with the build that serves the page at the address, so
 *   the rule keeps answering until then instead of leaving a 404.
 *
 * Leaving a change out can make another change's chain end at a target the
 * build does not serve, so the check repeats until nothing more is left out.
 * Each round leaves out every unserved change at once, so the rounds are
 * bounded by the length of the longest chain, not by the number of changes.
 */

import {
  buildRedirectPlan,
  type RedirectPageUrlStyle,
  type RedirectPlan,
  type RedirectTableRow,
  redirectFromPathSpellings,
  redirectPathServed,
  redirectsToUnservedPaths,
} from "./redirect-plan.js";

/** A pending change of one address, as the planner reads it. */
export interface PendingRedirectChange {
  readonly id: string;
  /** The bare from path (`/old`, `/` for the root): {@link redirectAddress}. */
  readonly address: string;
  /** The spelling the live row gets (`/old` or `/old/`). */
  readonly fromPath: string;
  /** Null: the change removes the address's live rule. */
  readonly toPath: string | null;
  /** Null exactly when `toPath` is. */
  readonly statusCode: number | null;
  /** A change a page write or a plugin made (never chosen by a person). */
  readonly automatic: boolean;
}

/** Why a change is left out of a build. */
export type RedirectWaitReason =
  /** Its same-site target is not served by the build. */
  | "target"
  /** An automatic removal whose page the build does not serve at the address yet. */
  | "page";

/** What {@link planRedirectRelease} decided. */
export interface RedirectRelease {
  /** The table the build is served with: the live rows with every applied change. */
  readonly rows: readonly RedirectTableRow[];
  /** {@link buildRedirectPlan} of {@link rows} against the build. */
  readonly plan: RedirectPlan;
  /** Ids of the changes in {@link rows}. */
  readonly applied: readonly string[];
  /** The changes left out, with why. */
  readonly waiting: readonly { readonly id: string; readonly reason: RedirectWaitReason }[];
}

/** Arguments of {@link planRedirectRelease}. */
export interface PlanRedirectReleaseArgs {
  /** The live state: every row of the `redirects` table. */
  readonly live: readonly RedirectTableRow[];
  /** The changes that may go live with this build. */
  readonly changes: readonly PendingRedirectChange[];
  /** Every file of the build, relative and without a leading slash. */
  readonly servedFiles: ReadonlySet<string>;
  readonly pageUrlStyle: RedirectPageUrlStyle;
}

/**
 * The address a from path belongs to: the path without its trailing slash
 * (`/` stays `/`). Both spellings of a path are one address.
 *
 * @example
 *   redirectAddress("/old/") // → "/old"
 */
export function redirectAddress(fromPath: string): string {
  const [bare] = redirectFromPathSpellings(fromPath);
  if (bare === undefined) throw new Error(`redirectAddress: no spelling for ${fromPath}`);
  return bare;
}

/**
 * The live rows with `changes` applied: a change replaces every live row of
 * its address (both spellings), a removal leaves none. Ordered by from path,
 * like the table dump every serving layer reads.
 */
export function applyRedirectChanges(
  live: readonly RedirectTableRow[],
  changes: readonly PendingRedirectChange[],
): RedirectTableRow[] {
  const changed = new Set(changes.map((c) => c.address));
  const rows: RedirectTableRow[] = live.filter((r) => !changed.has(redirectAddress(r.fromPath)));
  for (const c of changes) {
    if (c.toPath === null || c.statusCode === null) continue;
    rows.push({ fromPath: c.fromPath, toPath: c.toPath, statusCode: c.statusCode });
  }
  return rows.sort((a, b) => (a.fromPath < b.fromPath ? -1 : a.fromPath > b.fromPath ? 1 : 0));
}

/**
 * Decide which of `changes` a build serves (see the module comment) and the
 * table it is served with. Throws what {@link buildRedirectPlan} throws for a
 * table no host can serve (a loop, two rules for one address): the caller
 * refuses with that message, it never serves a guess.
 *
 * @example
 *   planRedirectRelease({
 *     live: [],
 *     changes: [{ id: "c1", address: "/old", fromPath: "/old", toPath: "/new",
 *                 statusCode: 301, automatic: false }],
 *     servedFiles: new Set(["index.html"]),
 *     pageUrlStyle: "directory",
 *   }).waiting
 *   // → [{ id: "c1", reason: "target" }]: the build has no page at /new
 */
export function planRedirectRelease(args: PlanRedirectReleaseArgs): RedirectRelease {
  const waiting: { id: string; reason: RedirectWaitReason }[] = [];
  let applied: PendingRedirectChange[] = [];
  for (const c of args.changes) {
    if (c.automatic && c.toPath === null && !redirectPathServed(c.address, args.servedFiles)) {
      waiting.push({ id: c.id, reason: "page" });
    } else {
      applied.push(c);
    }
  }
  for (;;) {
    const rows = applyRedirectChanges(args.live, applied);
    const plan = buildRedirectPlan({
      rows,
      pageUrlStyle: args.pageUrlStyle,
      servedFiles: args.servedFiles,
    });
    const unserved = new Set(
      redirectsToUnservedPaths(plan, args.servedFiles).map((r) => r.fromPath),
    );
    const late = applied.filter((c) => c.toPath !== null && unserved.has(c.address));
    if (late.length === 0) {
      return { rows, plan, applied: applied.map((c) => c.id), waiting };
    }
    const lateIds = new Set(late.map((c) => c.id));
    applied = applied.filter((c) => !lateIds.has(c.id));
    for (const c of late) waiting.push({ id: c.id, reason: "target" });
  }
}
