// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #628 — the cross-instance half of "one turn at a time per chat".
 *
 *   chat.acquire_turn_lease — claim the chat's turn lease (free, expired, or
 *                             already ours) or report who holds it.
 *   chat.renew_turn_lease   — heartbeat: push the holder's expiry forward.
 *   chat.release_turn_lease — the turn ended: delete the holder's lease.
 *
 * The runner (`ai/chat-runner/turn-serializer.ts`) drives these; no AI tool
 * wraps them. Every expiry comparison uses the database clock (`now()`), so
 * instances with skewed wall clocks still agree on whether a lease lapsed.
 * See migration 0247 for why a lease row and not a session advisory lock.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const holderInput = z
  .object({
    chatSessionId: z.string().uuid(),
    /** Random per-turn id minted by the runner. */
    holderId: z.string().min(1).max(200),
  })
  .strict();

const ttlInput = holderInput
  .extend({
    /** Lease lifetime from now (database clock). The runner renews well inside it. */
    ttlMs: z.number().int().min(1).max(3_600_000),
  })
  .strict();

const toIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

export const acquireChatTurnLeaseOp = defineOperation({
  name: "chat.acquire_turn_lease",
  // Runner plumbing driven under the turn's own context (operator, MCP, or a
  // subagent's); the AI has no tool for it.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: ttlInput,
  output: z.object({
    acquired: z.boolean(),
    /** Set when acquired by taking over a lapsed lease (its holder crashed or stalled). */
    tookOverExpiredHolderId: z.string().nullable(),
    /** Set when refused: the live holder's lease. */
    heldBy: z
      .object({ holderId: z.string(), acquiredAt: z.string(), expiresAt: z.string() })
      .nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const session = (await tx.execute(sql`
      SELECT 1 AS present FROM chat_sessions WHERE id = ${input.chatSessionId}::uuid
    `)) as unknown as { present: number }[];
    if (session.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "chat.acquire_turn_lease",
        message: `Chat ${input.chatSessionId} does not exist (deleted?). Open the chat list and start or pick another chat.`,
      });
    }
    // Lock the current lease row (if any) so two claimants serialize here
    // and the takeover report below describes what was actually replaced.
    const current = (await tx.execute(sql`
      SELECT holder_id, acquired_at, expires_at, expires_at <= now() AS expired
      FROM chat_turn_leases
      WHERE chat_session_id = ${input.chatSessionId}::uuid
      FOR UPDATE
    `)) as unknown as {
      holder_id: string;
      acquired_at: string | Date;
      expires_at: string | Date;
      expired: boolean;
    }[];
    const existing = current[0];
    if (existing && !existing.expired && existing.holder_id !== input.holderId) {
      return ok({
        acquired: false,
        tookOverExpiredHolderId: null,
        heldBy: {
          holderId: existing.holder_id,
          acquiredAt: toIso(existing.acquired_at),
          expiresAt: toIso(existing.expires_at),
        },
      });
    }
    // Free, lapsed, or already ours. The WHERE on the conflict branch repeats
    // the check, so a claimant that inserted concurrently (no row to lock
    // above) still never replaces a live foreign lease.
    const claimed = (await tx.execute(sql`
      INSERT INTO chat_turn_leases (chat_session_id, holder_id, acquired_at, renewed_at, expires_at)
      VALUES (${input.chatSessionId}::uuid, ${input.holderId}, now(), now(),
              now() + ${input.ttlMs}::int * interval '1 millisecond')
      ON CONFLICT (chat_session_id) DO UPDATE
        SET holder_id = EXCLUDED.holder_id,
            acquired_at = CASE WHEN chat_turn_leases.holder_id = EXCLUDED.holder_id
                               THEN chat_turn_leases.acquired_at ELSE now() END,
            renewed_at = now(),
            expires_at = EXCLUDED.expires_at
        WHERE chat_turn_leases.expires_at <= now()
           OR chat_turn_leases.holder_id = EXCLUDED.holder_id
      RETURNING holder_id
    `)) as unknown as { holder_id: string }[];
    if (claimed.length === 0) {
      const holder = (await tx.execute(sql`
        SELECT holder_id, acquired_at, expires_at FROM chat_turn_leases
        WHERE chat_session_id = ${input.chatSessionId}::uuid
      `)) as unknown as {
        holder_id: string;
        acquired_at: string | Date;
        expires_at: string | Date;
      }[];
      const h = holder[0];
      return ok({
        acquired: false,
        tookOverExpiredHolderId: null,
        heldBy: h
          ? {
              holderId: h.holder_id,
              acquiredAt: toIso(h.acquired_at),
              expiresAt: toIso(h.expires_at),
            }
          : null,
      });
    }
    const tookOver =
      existing?.expired && existing.holder_id !== input.holderId ? existing.holder_id : null;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.acquire_turn_lease",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: tookOver ? `took over lapsed lease of ${tookOver}` : "acquired",
    });
    return ok({ acquired: true, tookOverExpiredHolderId: tookOver, heldBy: null });
  },
});

export const renewChatTurnLeaseOp = defineOperation({
  name: "chat.renew_turn_lease",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: ttlInput,
  output: z.object({
    /** False when the lease is no longer this holder's (it lapsed and was taken over). */
    held: z.boolean(),
  }),
  // No audit row: a heartbeat only moves an expiry forward every few
  // seconds; acquire, takeover and release are the audited transitions.
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE chat_turn_leases
      SET renewed_at = now(), expires_at = now() + ${input.ttlMs}::int * interval '1 millisecond'
      WHERE chat_session_id = ${input.chatSessionId}::uuid AND holder_id = ${input.holderId}
      RETURNING 1 AS renewed
    `)) as unknown as { renewed: number }[];
    return ok({ held: rows.length > 0 });
  },
});

export const releaseChatTurnLeaseOp = defineOperation({
  name: "chat.release_turn_lease",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: holderInput,
  output: z.object({
    /** False when there was nothing of this holder's to release (lapsed and taken over). */
    released: z.boolean(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM chat_turn_leases
      WHERE chat_session_id = ${input.chatSessionId}::uuid AND holder_id = ${input.holderId}
      RETURNING 1 AS released
    `)) as unknown as { released: number }[];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.release_turn_lease",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: rows.length > 0 ? "released" : "not held",
    });
    return ok({ released: rows.length > 0 });
  },
});
