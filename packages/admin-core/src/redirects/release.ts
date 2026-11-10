// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — the writers of the LIVE redirects (model.ts has the model). The
 * live state changes only here, and only from a release:
 *
 * - {@link releaseRedirectChanges}: Publish live and an Owner's production
 *   build apply the Staged changes their plan listed (by id and revision,
 *   so a change saved after the confirmation waits for the next one); Go
 *   live now applies the manual changes a human chose.
 * - {@link takeOverRedirectsOnFirstPublishedPages}: the release that first
 *   ships a page deletes the rule on its URL (#1517).
 * - {@link rollBackRedirectReleases}: a rollback brings back the live state
 *   of the run it restores and makes the rolled-back releases' changes
 *   Staged again.
 *
 * Every live write takes {@link lockLiveRedirectWrites} first, so two of
 * them never interleave, and records what it did per address in
 * `redirect_release_log`: the live rules of the address before and after
 * (every stored spelling), and the change. A rollback reconstructs from it
 * the live state as of any run, rollbacks included. The provider push
 * happens after the commit (the caller's `redirects.sync_provider`); the
 * projection follows the row triggers.
 *
 * `scripts/no-draft-live-writes.test.ts` pins this file as the one place
 * that writes `redirects` rows.
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  findRedirectLoops,
  type RedirectTableRow,
  redirectAddress,
  redirectFromPathSpellings,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { ensureLeaseRow } from "../deploy/deploy-lease.js";
import { LIVE_RELEASE_LEASE } from "../deploy/live-release-lock.js";
import { jsonbParam } from "../sql-helpers.js";
import {
  liveRedirectsFingerprint,
  liveRowsByAddress,
  loadLiveRedirectRows,
  PENDING_COLUMNS,
  type PendingDbRow,
  pendingByAddress,
  pendingRowOf,
  type RedirectChangeState,
  type RedirectOrigin,
} from "./model.js";

/** A change a release applies: its id and the revision its plan listed. */
export interface ReleaseChangeRef {
  readonly id: string;
  readonly revision: number;
}

/** What a release did to one address. */
export interface ReleasedRedirect {
  readonly address: string;
  readonly fromPath: string;
  /** Null: the release removed the address's rule. */
  readonly toPath: string | null;
  readonly statusCode: number | null;
  readonly origin: RedirectOrigin;
}

/** Which release writes: a deploy run, or Go live now. */
export type RedirectRelease =
  | { readonly kind: "release"; readonly runId: string }
  | { readonly kind: "go_live_now" };

/** The rules of one address in the release log (every stored spelling). */
const loggedRulesSchema = z.array(
  z.object({ fromPath: z.string(), toPath: z.string(), statusCode: z.number().int() }).strict(),
);

type LoggedRules = z.infer<typeof loggedRulesSchema>;

interface LogEntry {
  readonly address: string;
  readonly before: LoggedRules;
  readonly after: LoggedRules;
  /** The change applied; null for a rollback, which applies none. */
  readonly change: {
    readonly origin: RedirectOrigin;
    readonly actorId: string;
    readonly chatSessionId: string | null;
  } | null;
}

const rulesOf = (rows: readonly RedirectTableRow[]): LoggedRules =>
  rows.map((r) => ({ fromPath: r.fromPath, toPath: r.toPath, statusCode: r.statusCode }));

/**
 * Order every write of the live table: the release transactions lock the
 * `live-release` lease row for the rest of their transaction, so a Go live
 * now never interleaves with a Publish live's finish, an Owner's
 * production build or a rollback. Long runs hold the lease itself
 * (live-release-lock.ts); this lock covers the seconds of the write.
 */
export async function lockLiveRedirectWrites(tx: TransactionRunner): Promise<void> {
  await ensureLeaseRow(tx, LIVE_RELEASE_LEASE);
  await tx.execute(sql`
    SELECT 1 FROM deploy_leases WHERE name = ${LIVE_RELEASE_LEASE} FOR UPDATE
  `);
}

async function writeLog(
  tx: TransactionRunner,
  kind: "release" | "take_over" | "go_live_now" | "rollback",
  runId: string | null,
  appliedBy: string,
  entries: readonly LogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({
    address: e.address,
    before_rules: e.before,
    after_rules: e.after,
    origin: e.change?.origin ?? null,
    change_actor_id: e.change?.actorId ?? null,
    change_chat_session_id: e.change?.chatSessionId ?? null,
  }));
  await tx.execute(sql`
    INSERT INTO redirect_release_log
      (run_id, kind, address, before_rules, after_rules, origin, change_actor_id,
       change_chat_session_id, applied_by)
    SELECT ${runId}::uuid, ${kind}, x.address, x.before_rules, x.after_rules, x.origin,
           x.change_actor_id, x.change_chat_session_id, ${appliedBy}::uuid
    FROM jsonb_to_recordset(${jsonbParam(rows)}) AS x(
      address text, before_rules jsonb, after_rules jsonb, origin text, change_actor_id uuid,
      change_chat_session_id uuid)
  `);
}

/** Options of {@link releaseRedirectChanges}. */
export interface ReleaseOptions {
  /** The states a listed change may be in: Publish live applies Staged ones, Go live now Draft ones too. */
  readonly states: readonly RedirectChangeState[];
  /**
   * The live table the plan was made against ({@link liveRedirectsFingerprint}).
   * The plan's chains hold only for that table, so a release onto another one
   * applies nothing.
   */
  readonly liveFingerprint: string;
}

/** What {@link releaseRedirectChanges} did. */
export type ReleaseResult =
  | { readonly released: true; readonly applied: readonly ReleasedRedirect[] }
  /** Nothing applied: a listed change, or the live table, moved on since the plan. */
  | { readonly released: false; readonly reason: string };

/**
 * Apply the pending changes `refs` to the live state, in the caller's
 * transaction, and record each in the release log — all of them or none.
 * The plan that listed them checked them together against the build and
 * the live table: if one moved on since (saved again, kept as a draft,
 * discarded) or the live table changed, the others may depend on what
 * changed (a chain through it), so none is applied; they stay pending for
 * the next release, which plans them again.
 */
export async function releaseRedirectChanges(
  tx: TransactionRunner,
  appliedBy: string,
  refs: readonly ReleaseChangeRef[],
  release: RedirectRelease,
  opts: ReleaseOptions,
): Promise<ReleaseResult> {
  if (refs.length === 0) return { released: true, applied: [] };
  await lockLiveRedirectWrites(tx);
  const chosen = (
    (await tx.execute(sql`
      SELECT ${PENDING_COLUMNS} FROM pending_redirects p
      JOIN jsonb_to_recordset(${jsonbParam(refs)}) AS l(id uuid, revision bigint)
        ON l.id = p.id AND l.revision = p.revision
      WHERE p.state = ANY(${textArray([...opts.states])})
      ORDER BY p.address
      FOR UPDATE OF p
    `)) as unknown as PendingDbRow[]
  ).map(pendingRowOf);
  if (chosen.length !== new Set(refs.map((r) => r.id.toLowerCase())).size) {
    return {
      released: false,
      reason:
        "a listed redirect change was saved again, kept as a draft or discarded since it was planned",
    };
  }
  if (liveRedirectsFingerprint(await loadLiveRedirectRows(tx)) !== opts.liveFingerprint) {
    return { released: false, reason: "the live redirects changed since the plan" };
  }
  const addresses = chosen.map((c) => c.address);
  const live = await liveRowsByAddress(tx, addresses, true);
  await writeLog(
    tx,
    release.kind,
    release.kind === "release" ? release.runId : null,
    appliedBy,
    chosen.map((c) => ({
      address: c.address,
      before: rulesOf(live.get(c.address) ?? []),
      after:
        c.toPath === null || c.statusCode === null
          ? []
          : [{ fromPath: c.fromPath, toPath: c.toPath, statusCode: c.statusCode }],
      change: { origin: c.origin, actorId: c.actorId, chatSessionId: c.chatSessionId },
    })),
  );
  await tx.execute(sql`
    DELETE FROM redirects WHERE address = ANY(${textArray(addresses)})
  `);
  const rules = chosen
    .filter((c) => c.toPath !== null && c.statusCode !== null)
    .map((c) => ({
      from_path: c.fromPath,
      to_path: c.toPath,
      status_code: c.statusCode,
      created_by: c.actorId,
    }));
  if (rules.length > 0) {
    await tx.execute(sql`
      INSERT INTO redirects (from_path, to_path, status_code, created_by)
      SELECT x.from_path, x.to_path, x.status_code, x.created_by
      FROM jsonb_to_recordset(${jsonbParam(rules)})
        AS x(from_path text, to_path text, status_code int, created_by uuid)
    `);
  }
  await tx.execute(sql`
    DELETE FROM pending_redirects WHERE id = ANY(${uuidArray(chosen.map((c) => c.id))})
  `);
  return {
    released: true,
    applied: chosen.map((c) => ({
      address: c.address,
      fromPath: c.fromPath,
      toPath: c.toPath,
      statusCode: c.statusCode,
      origin: c.origin,
    })),
  };
}

/**
 * #1517 — Publish live takes a page's URL over from a redirect rule: the
 * pages a production build ships for the first time (`pages`, stamped
 * `first_published_at` by that release) delete every rule on their path, in
 * both spellings, in the release's transaction. Until then the rule kept
 * answering on the live site, which did not serve the page yet; the build
 * that now serves it wins over the rule anyway (the redirect plan leaves a
 * served path out), so the delete only keeps the rule from coming back when
 * the page leaves the build. Not at the merge (Stage): the live site serves
 * the previous build until Publish live, and a rule deleted at Stage would
 * leave the URL answering 404 there. Logged like the release's own changes,
 * so a rollback brings the rule back.
 *
 * The caller pushes the table after its commit (the release's own sync).
 *
 * @returns how many rules were deleted.
 */
export async function takeOverRedirectsOnFirstPublishedPages(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  runId: string,
  pages: ReadonlyArray<{ readonly id: string; readonly path: string }>,
): Promise<number> {
  if (pages.length === 0) return 0;
  // The 404 page is served at /404.html: its own path is free for a rule.
  const designated = (await tx.execute(sql`
    SELECT not_found_page_id::text AS id FROM site_defaults WHERE id = 1
  `)) as unknown as { id: string | null }[];
  const notFound = designated[0]?.id ?? null;
  const spellings = pages
    .filter((p) => p.id !== notFound)
    .flatMap((p) => redirectFromPathSpellings(p.path));
  if (spellings.length === 0) return 0;
  await lockLiveRedirectWrites(tx);
  const gone = (await tx.execute(sql`
    DELETE FROM redirects WHERE from_path = ANY(${textArray(spellings)})
    RETURNING from_path, to_path, status_code
  `)) as unknown as { from_path: string; to_path: string; status_code: number }[];
  const byAddress = new Map<string, RedirectTableRow[]>();
  for (const r of gone) {
    const address = redirectAddress(r.from_path);
    byAddress.set(address, [
      ...(byAddress.get(address) ?? []),
      { fromPath: r.from_path, toPath: r.to_path, statusCode: r.status_code },
    ]);
  }
  await writeLog(
    tx,
    "take_over",
    runId,
    ctx.actorId,
    [...byAddress].map(([address, rows]) => ({
      address,
      before: rulesOf(rows),
      after: [],
      change: { origin: "page_move", actorId: ctx.actorId, chatSessionId: null },
    })),
  );
  return gone.length;
}

/** What {@link rollBackRedirectReleases} did. */
export interface RedirectRollback {
  /** Addresses whose live state is back to the restored run's. */
  readonly restored: readonly string[];
  /** Addresses whose rolled-back change is Staged again. */
  readonly restaged: readonly string[];
  /** Addresses left as they are, with why. */
  readonly skipped: readonly { readonly address: string; readonly reason: string }[];
}

interface LogRow {
  id: string;
  address: string;
  kind: "release" | "take_over" | "go_live_now" | "rollback";
  before_rules: unknown;
  after_rules: unknown;
  origin: RedirectOrigin | null;
  change_actor_id: string | null;
}

/** The same rules, whatever the order. */
function sameRules(a: LoggedRules, b: LoggedRules): boolean {
  const key = (r: LoggedRules[number]) => `${r.fromPath}\t${r.toPath}\t${r.statusCode}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

/**
 * Review on #1554 — hold back the restorations that would close a loop in
 * the table the rollback leaves, and say why. That table combines the
 * restored addresses with every address the rollback keeps (a Go live now
 * change, a newer pending change, a rule nobody released), so each part
 * was servable and the whole need not be: a kept `/b → /a` and a restored
 * `/a → /b` loop, and the hosting refuses such a table on every retry. A
 * held-back address keeps its live rule (and its change stays live).
 * Checked as if no page shadowed a rule: the rollback reads no file list of
 * the build it restores, and the next Publish live may drop that page.
 * Removes the held-back addresses from `restorations`.
 */
function holdBackLoopingRestorations(
  liveRows: readonly RedirectTableRow[],
  restorations: Map<string, { readonly target: LoggedRules }>,
): { address: string; reason: string }[] {
  const held: { address: string; reason: string }[] = [];
  for (;;) {
    const rows = [
      ...liveRows.filter((r) => !restorations.has(redirectAddress(r.fromPath))),
      ...[...restorations.values()].flatMap((r) => r.target),
    ];
    const looping = findRedirectLoops(rows, new Set()).flatMap((cycle) =>
      cycle
        .filter((address) => restorations.has(address))
        .map((address) => {
          // Told from the held-back address: "/a → /b → /a".
          const at = cycle.indexOf(address);
          const loop = [...cycle.slice(at), ...cycle.slice(0, at), address].join(" → ");
          return { address, loop };
        }),
    );
    // A loop no restoration is part of is the live table's own, not this
    // rollback's; the sync reports it as before.
    if (looping.length === 0) return held;
    for (const { address, loop } of looping) {
      if (!restorations.delete(address)) continue;
      held.push({
        address,
        reason: `restoring it would make the redirects ${loop} a loop, so it keeps its live rule`,
      });
    }
  }
}

/**
 * Roll the live redirects back with a rollback to `restoreRunId`. Every
 * address a later live write changed (a release, its take-over, a rollback)
 * gets the live state it had as of that run, reconstructed from the log —
 * so a rollback to a release a previous rollback undid restores that
 * release's redirects too. The change the rolled-back releases made to the
 * address is Staged again, so it goes live with the next Publish live that
 * ships it. Skipped and reported: an address with a newer pending change,
 * one a Go live now changed since (its change stays live), and one whose
 * restored rule would close a loop with what stays live.
 */
export async function rollBackRedirectReleases(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  args: { readonly restoreRunId: string; readonly rollbackRunId: string },
): Promise<RedirectRollback> {
  const restoredRun = (await tx.execute(sql`
    SELECT finished_at FROM deploy_runs WHERE id = ${args.restoreRunId}::uuid
  `)) as unknown as { finished_at: string | Date | null }[];
  const finished = restoredRun[0]?.finished_at;
  if (finished === undefined || finished === null) {
    throw new Error(
      `rollBackRedirectReleases: run ${args.restoreRunId} has no finish time, so the releases after it cannot be told`,
    );
  }
  const since = finished instanceof Date ? finished.toISOString() : String(finished);
  await lockLiveRedirectWrites(tx);
  // The live writes after the restored run (its own entries are its state).
  const later = (await tx.execute(sql`
    SELECT id::text AS id, address, kind, before_rules, after_rules, origin,
           change_actor_id::text AS change_actor_id
    FROM redirect_release_log
    WHERE applied_at > ${since}::timestamptz AND run_id IS DISTINCT FROM ${args.restoreRunId}::uuid
    ORDER BY applied_at, id
  `)) as unknown as LogRow[];
  if (later.length === 0) return { restored: [], restaged: [], skipped: [] };
  const byAddress = new Map<string, LogRow[]>();
  for (const e of later) byAddress.set(e.address, [...(byAddress.get(e.address) ?? []), e]);
  const addresses = [...byAddress.keys()];
  // The state as of the restored run: the newest entry at or before it.
  const asOf = new Map(
    (
      (await tx.execute(sql`
        SELECT DISTINCT ON (address) address, after_rules
        FROM redirect_release_log
        WHERE address = ANY(${textArray(addresses)})
          AND (applied_at <= ${since}::timestamptz OR run_id = ${args.restoreRunId}::uuid)
        ORDER BY address, applied_at DESC, id DESC
      `)) as unknown as { address: string; after_rules: unknown }[]
    ).map((r) => [r.address, loggedRulesSchema.parse(r.after_rules)]),
  );
  const live = await liveRowsByAddress(tx, addresses, true);
  const pending = await pendingByAddress(tx, addresses, true);
  const restored: string[] = [];
  const restaged: string[] = [];
  const skipped: { address: string; reason: string }[] = [];
  const entries: LogEntry[] = [];
  // What each address gets back; written after the loop check below.
  const restorations = new Map<
    string,
    { readonly current: LoggedRules; readonly target: LoggedRules; readonly group: LogRow[] }
  >();
  for (const [address, group] of byAddress) {
    const first = group[0];
    const newest = group[group.length - 1];
    if (!first || !newest) continue;
    if (pending.has(address)) {
      skipped.push({ address, reason: "a newer change of this address is pending" });
      continue;
    }
    if (group.some((e) => e.kind === "go_live_now")) {
      skipped.push({ address, reason: "it went live with Go live now, which a rollback keeps" });
      continue;
    }
    const current = rulesOf(live.get(address) ?? []);
    if (!sameRules(current, loggedRulesSchema.parse(newest.after_rules))) {
      skipped.push({ address, reason: "its live rule changed outside a release" });
      continue;
    }
    const target = asOf.get(address) ?? loggedRulesSchema.parse(first.before_rules);
    if (sameRules(current, target)) continue;
    restorations.set(address, { current, target, group });
  }
  if (restorations.size > 0) {
    skipped.push(...holdBackLoopingRestorations(await loadLiveRedirectRows(tx), restorations));
  }
  for (const [address, { current, target, group }] of restorations) {
    await tx.execute(sql`
      DELETE FROM redirects WHERE address = ${address}
    `);
    if (target.length > 0) {
      await tx.execute(sql`
        INSERT INTO redirects (from_path, to_path, status_code, created_by)
        SELECT x.from_path, x.to_path, x.status_code, ${ctx.actorId}::uuid
        FROM jsonb_to_recordset(${jsonbParam(
          target.map((r) => ({
            from_path: r.fromPath,
            to_path: r.toPath,
            status_code: r.statusCode,
          })),
        )}) AS x(from_path text, to_path text, status_code int)
      `);
    }
    entries.push({ address, before: current, after: target, change: null });
    restored.push(address);
    // The change the rolled-back releases made, Staged again: the newest
    // release (not a rollback) that left the live state as it is now.
    const source = [...group]
      .reverse()
      .find(
        (e) =>
          (e.kind === "release" || e.kind === "take_over") &&
          sameRules(current, loggedRulesSchema.parse(e.after_rules)),
      );
    if (source?.origin && source.change_actor_id && current.length <= 1) {
      const rule = current[0] ?? null;
      // Under the actor who made the change, but no chat's: it was
      // released, so no chat's Undo of unstaged work may take it away now.
      await tx.execute(sql`
        INSERT INTO pending_redirects
          (address, from_path, to_path, status_code, state, origin, actor_id)
        VALUES (${address}, ${rule?.fromPath ?? target[0]?.fromPath ?? address},
                ${rule?.toPath ?? null}, ${rule?.statusCode ?? null}, 'staged', ${source.origin},
                ${source.change_actor_id}::uuid)
      `);
      restaged.push(address);
    }
  }
  await writeLog(tx, "rollback", args.rollbackRunId, ctx.actorId, entries);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "redirects.roll_back",
    input: { restoreRunId: args.restoreRunId, rollbackRunId: args.rollbackRunId },
    succeeded: true,
    entityId: args.rollbackRunId,
    resultSummary:
      `restored=${restored.length} restaged=${restaged.length} skipped=${skipped.length}`.slice(
        0,
        500,
      ),
  });
  return { restored, restaged, skipped };
}
