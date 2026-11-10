// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — redirects are draft state: the model every redirect reader and
 * writer shares (docs/dev/redirects-and-settings-sync.md).
 *
 * - The LIVE state is the `redirects` table: what the hosting provider
 *   serves. Only a release writes it (Publish live, an Owner's production
 *   build, Go live now, a rollback, the first-publish take-over;
 *   `release.ts`), so the provider sync, its revision triggers and the
 *   production readers keep their meaning.
 * - An address (a from path, both trailing-slash spellings together) has at
 *   most one PENDING change in `pending_redirects` (migration 0670): a
 *   create or change (`toPath` set) or a removal, Draft or Staged, manual or
 *   automatic. `write.ts` is its one writer.
 * - The STAGING view is the live state with the shared draft's Staged
 *   changes ({@link SHARED_DRAFT_PENDING}), minus the ones that wait for
 *   their target (`planRedirectRelease`, @caelo-cms/shared). The projection
 *   publishes its inputs and the staging gateway serves it.
 * - The PENDING view is the live state with every pending change of the
 *   shared draft, Draft ones too: what the site will serve once everything
 *   saved goes live. Authoring reads that ask "is there a rule on this
 *   path?" use it (`redirects.page_conflicts`, link canonicalisation).
 */

import { createHash } from "node:crypto";
import { type TransactionRunner, textArray } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  type PendingRedirectChange,
  type RedirectTableRow,
  redirectAddress,
} from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";

/** Why a pending change exists: a person's choice, or the write that caused it. */
export type RedirectOrigin =
  | "manual"
  | "page_move"
  | "page_delete"
  | "url_migration"
  | "revert"
  | "plugin";

/** Draft: served nowhere. Staged: served by staging, live with the next Publish live. */
export type RedirectChangeState = "draft" | "staged";

/**
 * When a manual save goes live: with the next Publish live (Staged, the
 * default) or later (Draft). "Now" is Go live now, a separate human step.
 */
export type RedirectGoLive = "next_publish" | "later";

/** The state a {@link RedirectGoLive} choice saves a change in. */
export function stateOfGoLive(goLive: RedirectGoLive): RedirectChangeState {
  return goLive === "later" ? "draft" : "staged";
}

/** Who a pending change belongs to: its author, the chat (for Undo) and the branch. */
export interface RedirectChangeOwner {
  readonly actorId: string;
  readonly chatSessionId: string | null;
  /** NULL or the shared draft: the staging view. An isolated branch: its Stage merge. */
  readonly chatBranchId: string | null;
}

/** A pending change as stored. */
export interface PendingRedirectRow {
  readonly id: string;
  readonly address: string;
  readonly fromPath: string;
  readonly toPath: string | null;
  readonly statusCode: number | null;
  readonly state: RedirectChangeState;
  readonly origin: RedirectOrigin;
  readonly revision: number;
  readonly actorId: string;
  readonly chatSessionId: string | null;
  readonly chatBranchId: string | null;
  /** True when the change is on an isolated branch (it joins at that branch's Stage merge). */
  readonly isolated: boolean;
  readonly updatedAt: string;
}

/**
 * SQL predicate over `pending_redirects p`: the change belongs to the shared
 * draft — main (written outside a chat) or the site's draft branch. An
 * isolated branch's changes (an experiment, a site migration) are not part
 * of the staging view until that branch's Stage merge moves them to main.
 */
export const SHARED_DRAFT_PENDING: SQL = sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = (SELECT branch_id FROM site_draft WHERE id = 1))`;

/** The columns {@link pendingRowOf} reads, from `pending_redirects p`. */
export const PENDING_COLUMNS: SQL = sql`
  p.id::text AS id, p.address, p.from_path, p.to_path, p.status_code, p.state, p.origin,
  p.revision::text AS revision, p.actor_id::text AS actor_id,
  p.chat_session_id::text AS chat_session_id, p.chat_branch_id::text AS chat_branch_id,
  NOT ${SHARED_DRAFT_PENDING} AS isolated, p.updated_at
`;

/** A row of {@link PENDING_COLUMNS}. */
export interface PendingDbRow {
  id: string;
  address: string;
  from_path: string;
  to_path: string | null;
  status_code: number | null;
  state: RedirectChangeState;
  origin: RedirectOrigin;
  revision: string | number;
  actor_id: string;
  chat_session_id: string | null;
  chat_branch_id: string | null;
  isolated: boolean;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

/** Map a {@link PendingDbRow}. */
export function pendingRowOf(r: PendingDbRow): PendingRedirectRow {
  return {
    id: r.id,
    address: r.address,
    fromPath: r.from_path,
    toPath: r.to_path,
    statusCode: r.status_code,
    state: r.state,
    origin: r.origin,
    revision: Number(r.revision),
    actorId: r.actor_id,
    chatSessionId: r.chat_session_id,
    chatBranchId: r.chat_branch_id,
    isolated: r.isolated,
    updatedAt: iso(r.updated_at),
  };
}

/** The planner's view of a pending change (@caelo-cms/shared `planRedirectRelease`). */
export function plannedChangeOf(r: PendingRedirectRow): PendingRedirectChange {
  return {
    id: r.id,
    address: r.address,
    fromPath: r.fromPath,
    toPath: r.toPath,
    statusCode: r.statusCode,
    automatic: r.origin !== "manual",
  };
}

/**
 * The owner of a write by `ctx`: its actor, its chat (a subagent's task
 * resolves to its parent chat, `caelo_chat_owner`) and its branch.
 */
export async function ownerOfContext(
  tx: TransactionRunner,
  ctx: ExecutionContext,
): Promise<RedirectChangeOwner> {
  let chatSessionId: string | null = null;
  if (ctx.chatTaskId) {
    const rows = (await tx.execute(sql`
      SELECT caelo_chat_owner(${ctx.chatTaskId}::uuid)::text AS chat_session_id
      FROM chat_sessions WHERE id = ${ctx.chatTaskId}::uuid
    `)) as unknown as { chat_session_id: string | null }[];
    chatSessionId = rows[0]?.chat_session_id ?? null;
  }
  return { actorId: ctx.actorId, chatSessionId, chatBranchId: ctx.chatBranchId ?? null };
}

/** Every live row, in from-path order (the table every serving layer reads). */
export async function loadLiveRedirectRows(tx: TransactionRunner): Promise<RedirectTableRow[]> {
  const rows = (await tx.execute(sql`
    SELECT from_path, to_path, status_code FROM redirects ORDER BY from_path
  `)) as unknown as { from_path: string; to_path: string; status_code: number }[];
  return rows.map((r) => ({ fromPath: r.from_path, toPath: r.to_path, statusCode: r.status_code }));
}

/**
 * A fingerprint of the live table: a release plan records the one it was
 * made against, and the release refuses to apply the plan when the table
 * changed since (the plan's chains may no longer hold).
 */
export function liveRedirectsFingerprint(rows: readonly RedirectTableRow[]): string {
  const lines = rows
    .map((r) => `${r.fromPath}\t${r.toPath}\t${r.statusCode}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The live rows of `addresses` (both spellings), by address. */
export async function liveRowsByAddress(
  tx: TransactionRunner,
  addresses: readonly string[],
  lock = false,
): Promise<Map<string, (RedirectTableRow & { readonly id: string })[]>> {
  const out = new Map<string, (RedirectTableRow & { readonly id: string })[]>();
  if (addresses.length === 0) return out;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, address, from_path, to_path, status_code
    FROM redirects WHERE address = ANY(${textArray([...addresses])})
    ORDER BY from_path
    ${lock ? sql`FOR UPDATE` : sql``}
  `)) as unknown as {
    id: string;
    address: string;
    from_path: string;
    to_path: string;
    status_code: number;
  }[];
  for (const r of rows) {
    const list = out.get(r.address) ?? [];
    list.push({ id: r.id, fromPath: r.from_path, toPath: r.to_path, statusCode: r.status_code });
    out.set(r.address, list);
  }
  return out;
}

/** The pending changes of `addresses`, by address (any branch: one per address). */
export async function pendingByAddress(
  tx: TransactionRunner,
  addresses: readonly string[],
  lock = false,
): Promise<Map<string, PendingRedirectRow>> {
  if (addresses.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT ${PENDING_COLUMNS} FROM pending_redirects p
    WHERE p.address = ANY(${textArray([...addresses])})
    ${lock ? sql`FOR UPDATE OF p` : sql``}
  `)) as unknown as PendingDbRow[];
  return new Map(rows.map((r) => [r.address, pendingRowOf(r)]));
}

/**
 * The shared draft's Staged changes: what the staging view shows and what
 * the next Publish live may apply (minus the ones that wait for a target).
 */
export async function loadStagedChanges(tx: TransactionRunner): Promise<PendingRedirectRow[]> {
  const rows = (await tx.execute(sql`
    SELECT ${PENDING_COLUMNS} FROM pending_redirects p
    WHERE p.state = 'staged' AND ${SHARED_DRAFT_PENDING}
    ORDER BY p.address
  `)) as unknown as PendingDbRow[];
  return rows.map(pendingRowOf);
}

/** The shared draft's Draft changes: served nowhere, held back by every Publish live. */
export async function loadDraftChanges(tx: TransactionRunner): Promise<PendingRedirectRow[]> {
  const rows = (await tx.execute(sql`
    SELECT ${PENDING_COLUMNS} FROM pending_redirects p
    WHERE p.state = 'draft' AND ${SHARED_DRAFT_PENDING}
    ORDER BY p.address
  `)) as unknown as PendingDbRow[];
  return rows.map(pendingRowOf);
}

/** The address of every spelling in `paths` (deduplicated, input order). */
export function addressesOf(paths: readonly string[]): string[] {
  return [...new Set(paths.map((p) => redirectAddress(p)))];
}
