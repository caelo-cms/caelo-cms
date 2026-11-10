// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — the writers of the LIVE redirects (model.ts has the model). The
 * live state changes only here, and only from a release:
 *
 * - {@link releaseRedirectChanges}: Publish live and an Owner's production
 *   build apply exactly the Staged changes their confirmation listed (by id
 *   and revision, so a change saved after the confirmation waits for the
 *   next one); Go live now applies the manual changes a human chose.
 * - {@link takeOverRedirectsOnFirstPublishedPages}: the release that first
 *   ships a page deletes the rule on its URL (#1517).
 * - {@link rollBackRedirectReleases}: a rollback restores the live state the
 *   rolled-back releases replaced and makes their changes Staged again.
 *
 * Each records what it did per address in `redirect_release_log` (the live
 * state before and after, and the change), in the release's transaction:
 * that is what a rollback reads. The entries are written before the
 * release's run is stamped finished, so a rollback to a run finds exactly
 * the entries of the releases after it by time. The provider push happens
 * after the commit (the caller's `redirects.sync_provider`); the projection
 * follows the row triggers.
 *
 * `scripts/no-draft-live-writes.test.ts` pins this file as the one place
 * that writes `redirects` rows.
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import { type ExecutionContext, redirectFromPathSpellings } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import {
  liveRowsByAddress,
  PENDING_COLUMNS,
  type PendingDbRow,
  pendingByAddress,
  pendingRowOf,
  type RedirectChangeState,
  type RedirectOrigin,
} from "./model.js";

/** A change a release applies: its id and the revision the confirmation listed. */
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

interface LogEntry {
  readonly address: string;
  readonly before: { fromPath: string; toPath: string; statusCode: number } | null;
  readonly after: { fromPath: string; toPath: string; statusCode: number } | null;
  readonly origin: RedirectOrigin;
  readonly changeActorId: string;
  readonly changeChatSessionId: string | null;
}

async function writeLog(
  tx: TransactionRunner,
  kind: "release" | "take_over" | "go_live_now",
  runId: string | null,
  appliedBy: string,
  entries: readonly LogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({
    address: e.address,
    before_from_path: e.before?.fromPath ?? null,
    before_to_path: e.before?.toPath ?? null,
    before_status_code: e.before?.statusCode ?? null,
    after_from_path: e.after?.fromPath ?? null,
    after_to_path: e.after?.toPath ?? null,
    after_status_code: e.after?.statusCode ?? null,
    origin: e.origin,
    change_actor_id: e.changeActorId,
    change_chat_session_id: e.changeChatSessionId,
  }));
  await tx.execute(sql`
    INSERT INTO redirect_release_log
      (run_id, kind, address, before_from_path, before_to_path, before_status_code,
       after_from_path, after_to_path, after_status_code, origin, change_actor_id,
       change_chat_session_id, applied_by)
    SELECT ${runId}::uuid, ${kind}, x.address, x.before_from_path, x.before_to_path,
           x.before_status_code, x.after_from_path, x.after_to_path, x.after_status_code,
           x.origin, x.change_actor_id, x.change_chat_session_id, ${appliedBy}::uuid
    FROM jsonb_to_recordset(${jsonbParam(rows)}) AS x(
      address text, before_from_path text, before_to_path text, before_status_code int,
      after_from_path text, after_to_path text, after_status_code int, origin text,
      change_actor_id uuid, change_chat_session_id uuid)
  `);
}

/**
 * Apply the pending changes `refs` to the live state, in the caller's
 * transaction, and record each in the release log. A ref whose change moved
 * on since it was listed (a newer revision, another state, discarded) is
 * skipped: it waits for the next release.
 *
 * @param states the states a listed change may be in: Publish live applies
 *   Staged changes only, Go live now Draft ones too.
 * @returns what was applied, per address.
 */
export async function releaseRedirectChanges(
  tx: TransactionRunner,
  appliedBy: string,
  refs: readonly ReleaseChangeRef[],
  release: RedirectRelease,
  states: readonly RedirectChangeState[],
): Promise<ReleasedRedirect[]> {
  if (refs.length === 0) return [];
  const chosen = (
    (await tx.execute(sql`
      SELECT ${PENDING_COLUMNS} FROM pending_redirects p
      JOIN jsonb_to_recordset(${jsonbParam(refs)}) AS l(id uuid, revision bigint)
        ON l.id = p.id AND l.revision = p.revision
      WHERE p.state = ANY(${textArray([...states])})
      ORDER BY p.address
      FOR UPDATE OF p
    `)) as unknown as PendingDbRow[]
  ).map(pendingRowOf);
  if (chosen.length === 0) return [];
  const addresses = chosen.map((c) => c.address);
  const live = await liveRowsByAddress(tx, addresses, true);
  const entries: LogEntry[] = chosen.map((c) => {
    const before = live.get(c.address)?.[0] ?? null;
    return {
      address: c.address,
      before: before
        ? { fromPath: before.fromPath, toPath: before.toPath, statusCode: before.statusCode }
        : null,
      after:
        c.toPath === null || c.statusCode === null
          ? null
          : { fromPath: c.fromPath, toPath: c.toPath, statusCode: c.statusCode },
      origin: c.origin,
      changeActorId: c.actorId,
      changeChatSessionId: c.chatSessionId,
    };
  });
  await writeLog(
    tx,
    release.kind === "release" ? "release" : "go_live_now",
    release.kind === "release" ? release.runId : null,
    appliedBy,
    entries,
  );
  await tx.execute(sql`
    DELETE FROM redirects WHERE caelo_redirect_address(from_path) = ANY(${textArray(addresses)})
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
  return chosen.map((c) => ({
    address: c.address,
    fromPath: c.fromPath,
    toPath: c.toPath,
    statusCode: c.statusCode,
    origin: c.origin,
  }));
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
  const gone = (await tx.execute(sql`
    DELETE FROM redirects WHERE from_path = ANY(${textArray(spellings)})
    RETURNING caelo_redirect_address(from_path) AS address, from_path, to_path, status_code,
              created_by::text AS created_by
  `)) as unknown as {
    address: string;
    from_path: string;
    to_path: string;
    status_code: number;
    created_by: string;
  }[];
  await writeLog(
    tx,
    "take_over",
    runId,
    ctx.actorId,
    gone.map((r) => ({
      address: r.address,
      before: { fromPath: r.from_path, toPath: r.to_path, statusCode: r.status_code },
      after: null,
      origin: "page_move",
      changeActorId: ctx.actorId,
      changeChatSessionId: null,
    })),
  );
  return gone.length;
}

/** What {@link rollBackRedirectReleases} did. */
export interface RedirectRollback {
  /** Addresses whose live state is back to what the rolled-back releases replaced. */
  readonly restored: readonly string[];
  /** Addresses whose rolled-back change is Staged again. */
  readonly restaged: readonly string[];
  /** Addresses left as they are, with why. */
  readonly skipped: readonly { readonly address: string; readonly reason: string }[];
}

interface LogRow {
  id: string;
  address: string;
  before_from_path: string | null;
  before_to_path: string | null;
  before_status_code: number | null;
  after_from_path: string | null;
  after_to_path: string | null;
  after_status_code: number | null;
  origin: RedirectOrigin;
  change_actor_id: string;
  change_chat_session_id: string | null;
}

/**
 * Roll the live redirects back with a rollback to `restoreRunId`: every
 * release after that run's release (Publish live, production builds, their
 * take-overs; not Go live now, whose changes stay live) is undone per
 * address — the live state it replaced comes back, and its change is Staged
 * again, so it goes live with the next Publish live that ships it. An
 * address that changed since (a newer pending change, a Go live now, a
 * later release kept) is skipped and reported.
 */
export async function rollBackRedirectReleases(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  args: { readonly restoreRunId: string; readonly rollbackRunId: string },
): Promise<RedirectRollback> {
  const restoredRun = (await tx.execute(sql`
    SELECT finished_at FROM deploy_runs WHERE id = ${args.restoreRunId}::uuid
  `)) as unknown as { finished_at: string | Date | null }[];
  const since = restoredRun[0]?.finished_at;
  if (since === undefined || since === null) {
    throw new Error(
      `rollBackRedirectReleases: run ${args.restoreRunId} has no finish time, so the releases after it cannot be told`,
    );
  }
  const entries = (await tx.execute(sql`
    SELECT id::text AS id, address, before_from_path, before_to_path, before_status_code,
           after_from_path, after_to_path, after_status_code, origin,
           change_actor_id::text AS change_actor_id,
           change_chat_session_id::text AS change_chat_session_id
    FROM redirect_release_log
    WHERE rolled_back_at IS NULL AND kind <> 'go_live_now'
      AND applied_at > ${since instanceof Date ? since.toISOString() : String(since)}::timestamptz
    ORDER BY applied_at DESC, id DESC
  `)) as unknown as LogRow[];
  if (entries.length === 0) return { restored: [], restaged: [], skipped: [] };
  // Per address, newest first: the newest entry says what is live now, the
  // oldest what was live before the first rolled-back release.
  const byAddress = new Map<string, LogRow[]>();
  for (const e of entries) byAddress.set(e.address, [...(byAddress.get(e.address) ?? []), e]);
  const addresses = [...byAddress.keys()];
  const live = await liveRowsByAddress(tx, addresses, true);
  const pending = await pendingByAddress(tx, addresses, true);
  const restored: string[] = [];
  const restaged: string[] = [];
  const skipped: { address: string; reason: string }[] = [];
  const undone: string[] = [];
  for (const [address, group] of byAddress) {
    const newest = group[0];
    const oldest = group[group.length - 1];
    if (!newest || !oldest) continue;
    if (pending.has(address)) {
      skipped.push({ address, reason: "a newer change of this address is pending" });
      continue;
    }
    const rows = live.get(address) ?? [];
    const liveIsNewest =
      newest.after_to_path === null
        ? rows.length === 0
        : rows.length === 1 &&
          rows[0]?.toPath === newest.after_to_path &&
          rows[0]?.statusCode === newest.after_status_code;
    if (!liveIsNewest) {
      skipped.push({
        address,
        reason: "its live rule changed since that release (Go live now, or another release)",
      });
      continue;
    }
    await tx.execute(sql`
      DELETE FROM redirects WHERE caelo_redirect_address(from_path) = ${address}
    `);
    if (oldest.before_to_path !== null) {
      await tx.execute(sql`
        INSERT INTO redirects (from_path, to_path, status_code, created_by)
        VALUES (${oldest.before_from_path}, ${oldest.before_to_path}, ${oldest.before_status_code},
                ${ctx.actorId}::uuid)
      `);
    }
    restored.push(address);
    const netChange =
      oldest.before_to_path !== newest.after_to_path ||
      oldest.before_status_code !== newest.after_status_code;
    if (netChange) {
      await tx.execute(sql`
        INSERT INTO pending_redirects
          (address, from_path, to_path, status_code, state, origin, actor_id, chat_session_id)
        VALUES (${address}, ${newest.after_from_path ?? oldest.before_from_path ?? address},
                ${newest.after_to_path}, ${newest.after_status_code}, 'staged', ${newest.origin},
                ${newest.change_actor_id}::uuid, ${newest.change_chat_session_id}::uuid)
      `);
      restaged.push(address);
    }
    undone.push(...group.map((e) => e.id));
  }
  if (undone.length > 0) {
    await tx.execute(sql`
      UPDATE redirect_release_log
      SET rolled_back_at = clock_timestamp(), rolled_back_by_run_id = ${args.rollbackRunId}::uuid
      WHERE id = ANY(${uuidArray(undone)})
    `);
  }
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
