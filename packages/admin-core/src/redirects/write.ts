// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — the one writer of pending redirect changes (model.ts has the
 * model). Every redirects write but a release goes through
 * {@link writeRedirectChanges}: the `redirects.*` ops and their tools and
 * Settings form, the approved external rule, and every page write that
 * moves a URL (`applyPathMoveEffects`, a delete's dead-URL 301, an approved
 * URL migration, a revert, the `international-site` locale-root redirect
 * through `redirects.create`), and the chain collapse of a page move
 * retargets pending changes in place ({@link retargetPendingRedirects}).
 * None of them touches the live state.
 *
 * One pending change per address: a new change replaces the old one (the
 * outcome names it and the chat that made it, also across branches,
 * CLAUDE.md §2). A change that equals the live state leaves nothing
 * pending: renaming a page back drops the 301 its first rename staged. Each
 * stored change gets a new `revision`, so a Publish live confirmation that
 * listed the old revision does not apply the new one.
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { redirectAddress } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { jsonbParam } from "../sql-helpers.js";
import {
  liveRowsByAddress,
  type PendingRedirectRow,
  pendingByAddress,
  type RedirectChangeOwner,
  type RedirectChangeState,
  type RedirectOrigin,
} from "./model.js";

/** One change a writer asks for: a rule (`toPath` set) or a removal of the address's rule. */
export interface RedirectChangeInput {
  readonly fromPath: string;
  /** Null: remove the rule of the address. */
  readonly toPath: string | null;
  /** Null exactly when `toPath` is. */
  readonly statusCode: number | null;
}

/** A pending change a write replaced. */
export interface ReplacedRedirectChange {
  readonly toPath: string | null;
  readonly statusCode: number | null;
  readonly state: RedirectChangeState;
  readonly origin: RedirectOrigin;
  readonly chatSessionId: string | null;
  /** The title of the chat that made it, when it was a chat. */
  readonly chatTitle: string | null;
}

/** What writing one change did. */
export interface RedirectChangeOutcome {
  readonly address: string;
  readonly fromPath: string;
  /**
   * `pending`: the change is pending now. `unchanged`: it equals the live
   * state, so nothing is pending for the address (a pending change it
   * replaced is gone).
   */
  readonly outcome: "pending" | "unchanged";
  readonly changeId: string | null;
  /** The pending change's revision: what a later step binds to (Go live now after an approval). */
  readonly revision: number | null;
  readonly state: RedirectChangeState | null;
  /** The pending change this one replaced, when it held something else or another chat made it. */
  readonly replaced: ReplacedRedirectChange | null;
}

/** Options of {@link writeRedirectChanges}. */
export interface WriteRedirectChangesOptions {
  readonly origin: RedirectOrigin;
  /** Automatic changes are always Staged (the table refuses a Draft one). */
  readonly state: RedirectChangeState;
  readonly owner: RedirectChangeOwner;
  /**
   * The snapshot of the chat's page write that caused these changes (a
   * delete's 301): the Stage that merges that write settles them, also when
   * the chat only rode along with another chat's selection.
   */
  readonly causeSnapshotId?: string | null;
}

function sameRule(
  a: { toPath: string | null; statusCode: number | null },
  b: { toPath: string | null; statusCode: number | null },
): boolean {
  return a.toPath === b.toPath && a.statusCode === b.statusCode;
}

/**
 * Write `changes` as pending changes, in order (a later change of the same
 * address replaces an earlier one of the same call). Validation of targets
 * and paths is the caller's: this is the storage step.
 *
 * @returns one outcome per change, in order.
 */
export async function writeRedirectChanges(
  tx: TransactionRunner,
  changes: readonly RedirectChangeInput[],
  opts: WriteRedirectChangesOptions,
): Promise<RedirectChangeOutcome[]> {
  if (opts.origin !== "manual" && opts.state !== "staged") {
    throw new Error(
      `writeRedirectChanges: an automatic change (${opts.origin}) goes live with its page change, so it is always Staged`,
    );
  }
  if (changes.length === 0) return [];
  const addresses = [...new Set(changes.map((c) => redirectAddress(c.fromPath)))];
  // The pending rows first, then the live ones, both locked: the order every
  // release takes them in (release.ts). A release in flight holds the
  // pending row, so this waits for its commit and then reads the live rules
  // it committed, never the ones it replaced (a removal saved against a
  // rule a release just removed would be a removal of nothing). A live
  // write without a pending row (the take-over, a rollback) waits for this.
  const pending = await pendingByAddress(tx, addresses, true);
  const live = await liveRowsByAddress(tx, addresses, true);
  const titles = await chatTitles(
    tx,
    [...pending.values()].map((p) => p.chatSessionId),
  );
  const outcomes: RedirectChangeOutcome[] = [];
  for (const c of changes) {
    const address = redirectAddress(c.fromPath);
    const rows = live.get(address) ?? [];
    const before = pending.get(address) ?? null;
    const replaced =
      before !== null && (!sameRule(before, c) || before.chatSessionId !== opts.owner.chatSessionId)
        ? replacedOf(before, titles)
        : null;
    const equalsLive =
      c.toPath === null ? rows.length === 0 : rows.length > 0 && rows.every((r) => sameRule(r, c));
    if (equalsLive) {
      if (before !== null) {
        await tx.execute(sql`DELETE FROM pending_redirects WHERE id = ${before.id}::uuid`);
        pending.delete(address);
      }
      outcomes.push({
        address,
        fromPath: c.fromPath,
        outcome: "unchanged",
        changeId: null,
        revision: null,
        state: null,
        replaced,
      });
      continue;
    }
    // A removal names the spelling the live rule has; a rule keeps the
    // caller's spelling.
    const fromPath = c.toPath === null ? (rows[0]?.fromPath ?? c.fromPath) : c.fromPath;
    const written = (await tx.execute(sql`
      INSERT INTO pending_redirects
        (address, from_path, to_path, status_code, state, origin, actor_id, chat_session_id,
         chat_branch_id, cause_snapshot_id)
      VALUES (${address}, ${fromPath}, ${c.toPath}, ${c.statusCode}, ${opts.state}, ${opts.origin},
              ${opts.owner.actorId}::uuid, ${opts.owner.chatSessionId}::uuid,
              ${opts.owner.chatBranchId}::uuid, ${opts.causeSnapshotId ?? null}::uuid)
      ON CONFLICT (address) DO UPDATE
        SET from_path = EXCLUDED.from_path, to_path = EXCLUDED.to_path,
            status_code = EXCLUDED.status_code, state = EXCLUDED.state, origin = EXCLUDED.origin,
            actor_id = EXCLUDED.actor_id, chat_session_id = EXCLUDED.chat_session_id,
            chat_branch_id = EXCLUDED.chat_branch_id,
            cause_snapshot_id = EXCLUDED.cause_snapshot_id,
            revision = pending_redirects.revision + 1, updated_at = now()
        WHERE (pending_redirects.from_path, pending_redirects.to_path, pending_redirects.status_code,
               pending_redirects.state, pending_redirects.origin, pending_redirects.chat_session_id,
               pending_redirects.chat_branch_id)
          IS DISTINCT FROM (EXCLUDED.from_path, EXCLUDED.to_path, EXCLUDED.status_code,
               EXCLUDED.state, EXCLUDED.origin, EXCLUDED.chat_session_id, EXCLUDED.chat_branch_id)
      RETURNING id::text AS id, revision::text AS revision
    `)) as unknown as { id: string; revision: string }[];
    // No row back: the same change was pending already (nothing to bump) —
    // read before, or inserted by a concurrent identical save after this
    // one's read found no row to lock: read that row back.
    let kept = written[0]
      ? { id: written[0].id, revision: Number(written[0].revision) }
      : before
        ? { id: before.id, revision: before.revision }
        : null;
    if (kept === null) {
      const same = (await tx.execute(sql`
        SELECT id::text AS id, revision::text AS revision FROM pending_redirects
        WHERE address = ${address} FOR UPDATE
      `)) as unknown as { id: string; revision: string }[];
      kept = same[0] ? { id: same[0].id, revision: Number(same[0].revision) } : null;
    }
    if (kept === null)
      throw new Error(`writeRedirectChanges: ${address} has no pending row after the write`);
    const changeId = kept.id;
    const revision = kept.revision;
    pending.set(address, {
      id: changeId,
      address,
      fromPath,
      toPath: c.toPath,
      statusCode: c.statusCode,
      state: opts.state,
      origin: opts.origin,
      revision,
      actorId: opts.owner.actorId,
      chatSessionId: opts.owner.chatSessionId,
      chatBranchId: opts.owner.chatBranchId,
      isolated: false,
      updatedAt: new Date().toISOString(),
    });
    outcomes.push({
      address,
      fromPath,
      outcome: "pending",
      changeId,
      revision,
      state: opts.state,
      replaced,
    });
  }
  return outcomes;
}

/**
 * #1550 — a page move retargets the pending changes that point at a moved
 * page (the chain collapse of `applyPathMoveEffects`) in place: each keeps
 * its state, origin and owner, so a Draft stays a Draft that nobody
 * included, and a manual change stays one the operator can keep as a
 * draft. Each gets a new revision, like any other save.
 *
 * `pointedAt` is the target the move read: a change saved again since
 * (the same row, another target) no longer points at the moved page and
 * keeps its newer target.
 *
 * @returns how many changes were retargeted.
 */
export async function retargetPendingRedirects(
  tx: TransactionRunner,
  retargets: readonly {
    readonly id: string;
    readonly pointedAt: string;
    readonly toPath: string;
  }[],
): Promise<number> {
  if (retargets.length === 0) return 0;
  const moved = (await tx.execute(sql`
    UPDATE pending_redirects p
    SET to_path = r.to_path, revision = p.revision + 1, updated_at = now()
    FROM jsonb_to_recordset(${jsonbParam(
      retargets.map((r) => ({ id: r.id, pointed_at: r.pointedAt, to_path: r.toPath })),
    )}) AS r(id uuid, pointed_at text, to_path text)
    WHERE p.id = r.id AND p.to_path = r.pointed_at AND p.to_path IS DISTINCT FROM r.to_path
    RETURNING 1
  `)) as unknown as unknown[];
  return moved.length;
}

function replacedOf(
  row: PendingRedirectRow,
  titles: ReadonlyMap<string, string>,
): ReplacedRedirectChange {
  return {
    toPath: row.toPath,
    statusCode: row.statusCode,
    state: row.state,
    origin: row.origin,
    chatSessionId: row.chatSessionId,
    chatTitle: row.chatSessionId === null ? null : (titles.get(row.chatSessionId) ?? null),
  };
}

async function chatTitles(
  tx: TransactionRunner,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const known = [...new Set(ids.filter((id): id is string => id !== null))];
  if (known.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, title FROM chat_sessions WHERE id = ANY(${uuidArray(known)})
  `)) as unknown as { id: string; title: string }[];
  return new Map(rows.map((r) => [r.id, r.title]));
}

/**
 * One line naming what a write replaced, for a tool result or a form
 * message: the old change and the chat that made it.
 */
export function describeReplaced(o: RedirectChangeOutcome): string | null {
  const r = o.replaced;
  if (r === null) return null;
  const what = r.toPath === null ? "a removal" : `a change to ${r.toPath} (${r.statusCode})`;
  const by = r.chatTitle
    ? ` from chat "${r.chatTitle}"`
    : r.chatSessionId
      ? ` from chat ${r.chatSessionId}`
      : r.origin === "manual"
        ? ""
        : " (automatic)";
  return `${o.fromPath}: replaced ${what}${by} (${r.state === "draft" ? "Draft" : "Staged"})`;
}
