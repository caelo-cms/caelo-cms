// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.35 — shared helpers for `*.propose_*` operations.
 *
 * Two concerns:
 *  1. Deterministic payload hashing for DB-level dedup. The
 *     payload_hash + partial unique index makes "AI proposes the same
 *     thing twice" a hard reject at the DB layer, beyond the soft
 *     ## Pending proposals system-prompt block.
 *
 *  2. Resolving the chat_session_id from the propose handler's
 *     ExecutionContext. ctx.chatBranchId is set when the AI is calling
 *     inside a chat turn; we look the session up via chat_branches.
 */

import { sql } from "drizzle-orm";
import type { z } from "zod";

/**
 * Stable JSON stringification: object keys sorted, primitive values
 * preserved. SHA-256 of the resulting string. Designed so two
 * proposals with the same logical input produce the same hash even
 * if the AI's payload field-order differs.
 *
 * We hash the *input as it enters propose*, not as it lands in the
 * preview/payload columns, because preview is enriched server-side
 * (counts, slug lookups) and would never match between two propose
 * calls of the same intent.
 */
export async function hashProposalPayload(input: unknown): Promise<string> {
  const canonical = canonicalize(input);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Resolves the chat session id from a chat branch id. Returns null
 * when the AI is calling outside a chat (e.g. background workers,
 * MCP without a fresh session). Cached at the row level per chat
 * branch since the relationship doesn't change after creation.
 */
export async function resolveChatSessionId(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  chatBranchId: string | undefined,
): Promise<string | null> {
  if (!chatBranchId) return null;
  const rows = (await tx.execute(sql`
    SELECT chat_session_id::text AS chat_session_id
    FROM chat_branches WHERE id = ${chatBranchId}::uuid LIMIT 1
  `)) as unknown as Array<{ chat_session_id: string }>;
  return rows[0]?.chat_session_id ?? null;
}

/**
 * Maps a Postgres unique-violation on a `*_payload_hash_pending_uniq`
 * index into the propose op's standard "duplicate" error shape. Used
 * by every propose handler that catches the INSERT.
 *
 * Postgres surfaces "duplicate key value violates unique constraint
 * <table>_payload_hash_pending_uniq" — we match on the suffix so all
 * 11 per-domain indexes share one detection path.
 */
export function isDuplicatePendingError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { message?: string; code?: string };
  // Postgres SQLSTATE 23505 = unique_violation.
  if (e.code === "23505") return true;
  if (typeof e.message === "string" && e.message.includes("payload_hash_pending_uniq")) return true;
  return false;
}

/**
 * Type guard the propose helpers use to access ctx.chatBranchId
 * without touching the ExecutionContext type from query-api directly
 * (which lives in a sibling package).
 */
export interface ProposeCtx {
  readonly actorId: string;
  readonly requestId: string;
  readonly chatBranchId?: string;
}

/**
 * Common error type emitted when DB rejects a duplicate pending row.
 * Callers convert this to their op's HandlerError shape.
 */
export const DUPLICATE_PROPOSAL_MESSAGE =
  "Identical proposal already pending — see the `## Pending proposals` system-prompt block; tell the user to approve or reject the existing one rather than re-proposing.";

/**
 * Schema-level export so callers don't have to import zod directly
 * for the common `{ proposalId, preview }` output.
 */
export type ProposeOutputSchema<P> = z.ZodObject<{
  proposalId: z.ZodString;
  preview: z.ZodType<P>;
}>;
