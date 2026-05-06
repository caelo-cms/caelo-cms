// SPDX-License-Identifier: MPL-2.0

/**
 * Site AI memory ops + the AI proposal queue.
 *
 *   ai_memory.list      — read every slot (any in-scope actor; the
 *                         system prompt prepends it for everyone).
 *   ai_memory.set       — Owner-only direct write; emits an audit row
 *                         (no snapshot — memory isn't content).
 *   ai_memory.propose   — AI tool handler queues a proposal.
 *   ai_memory.review    — Owner accepts / rejects; on accept, replaces
 *                         the memory body via ai_memory.set semantics.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { aiMemoryReviewInput, aiMemorySetInput, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

// Mirror of the `site_ai_memory.slot` CHECK constraint (migration 0020
// added 'purpose'; this enum was stale at 5 entries until v0.2.15).
const SLOT_ENUM = z.enum([
  "purpose",
  "brand-voice",
  "tone",
  "banned-phrases",
  "instructions",
  "glossary",
]);

const memoryRowSchema = z.object({
  slot: SLOT_ENUM,
  body: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export const listAiMemoryOp = defineOperation({
  name: "ai_memory.list",
  // Read for any in-scope actor — the chat send_message op needs to read
  // memory to compose the system prompt, even when running as the AI actor.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ memory: z.array(memoryRowSchema) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT slot, body, updated_by::text AS updated_by, updated_at
      FROM site_ai_memory
      ORDER BY slot ASC
    `)) as unknown as {
      slot: "brand-voice" | "tone" | "banned-phrases" | "instructions" | "glossary";
      body: string;
      updated_by: string;
      updated_at: string | Date;
    }[];
    return ok({
      memory: rows.map((r) => ({
        slot: r.slot,
        body: r.body,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      })),
    });
  },
});

export const setAiMemoryOp = defineOperation({
  name: "ai_memory.set",
  // Owner-only writes — route layer enforces settings.write before the call.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: aiMemorySetInput,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    if (input.body.trim().length === 0) {
      // Empty body = clear the slot.
      await tx.execute(sql`DELETE FROM site_ai_memory WHERE slot = ${input.slot}`);
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "ai_memory.set",
        input,
        succeeded: true,
        resultSummary: `slot=${input.slot} cleared`,
      });
      return ok({});
    }
    await tx.execute(sql`
      INSERT INTO site_ai_memory (slot, body, updated_by, updated_at)
      VALUES (${input.slot}, ${input.body}, ${ctx.actorId}::uuid, now())
      ON CONFLICT (slot) DO UPDATE
        SET body = EXCLUDED.body,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_memory.set",
      input,
      succeeded: true,
      resultSummary: `slot=${input.slot} length=${input.body.length}`,
    });
    return ok({});
  },
});

export const proposeAiMemoryOp = defineOperation({
  name: "ai_memory.propose",
  // AI tool handler is the primary caller; humans can also propose via
  // some future surface.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      slot: SLOT_ENUM,
      body: z.string().min(1).max(4000),
      rationale: z.string().min(1).max(1000),
      chatSessionId: z.string().uuid().nullable().optional(),
    })
    .strict(),
  output: z.object({ proposalId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO site_memory_proposals (proposed_by, chat_session_id, slot, body, rationale)
      VALUES (
        ${ctx.actorId}::uuid,
        ${input.chatSessionId ?? null},
        ${input.slot},
        ${input.body},
        ${input.rationale}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const proposalId = rows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "ai_memory.propose",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_memory.propose",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `slot=${input.slot}`,
    });
    return ok({ proposalId });
  },
});

export const listMemoryProposalsOp = defineOperation({
  name: "ai_memory.list_proposals",
  // CLAUDE.md §11: AI checks its own pending proposals when planning
  // — avoids re-proposing the same memory the Owner is reviewing.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({
    status: z.enum(["pending", "accepted", "rejected", "all"]).default("pending"),
  }),
  output: z.object({
    proposals: z.array(
      z.object({
        id: z.string(),
        slot: SLOT_ENUM,
        body: z.string(),
        rationale: z.string(),
        status: z.enum(["pending", "accepted", "rejected"]),
        proposedBy: z.string(),
        chatSessionId: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const filter = input.status === "all" ? sql`` : sql`WHERE status = ${input.status}`;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slot, body, rationale, status,
             proposed_by::text AS proposed_by,
             chat_session_id::text AS chat_session_id,
             created_at
      FROM site_memory_proposals
      ${filter}
      ORDER BY created_at DESC
      LIMIT 200
    `)) as unknown as {
      id: string;
      slot: "brand-voice" | "tone" | "banned-phrases" | "instructions" | "glossary";
      body: string;
      rationale: string;
      status: "pending" | "accepted" | "rejected";
      proposed_by: string;
      chat_session_id: string | null;
      created_at: string | Date;
    }[];
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        slot: r.slot,
        body: r.body,
        rationale: r.rationale,
        status: r.status,
        proposedBy: r.proposed_by,
        chatSessionId: r.chat_session_id,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

export const reviewAiMemoryOp = defineOperation({
  name: "ai_memory.review",
  // Why human-only: Owner-only — accept/reject proposals; AI cannot review its own.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: aiMemoryReviewInput,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT slot, body, status FROM site_memory_proposals
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as {
      slot: "brand-voice" | "tone" | "banned-phrases" | "instructions" | "glossary";
      body: string;
      status: "pending" | "accepted" | "rejected";
    }[];
    const proposal = rows[0];
    if (!proposal) {
      return err({
        kind: "HandlerError",
        operation: "ai_memory.review",
        message: "proposal not found",
      });
    }
    if (proposal.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "ai_memory.review",
        message: `proposal already ${proposal.status}`,
      });
    }
    if (input.decision === "accept") {
      // Apply the proposal in the same tx so review + memory write are atomic.
      await tx.execute(sql`
        INSERT INTO site_ai_memory (slot, body, updated_by, updated_at)
        VALUES (${proposal.slot}, ${proposal.body}, ${ctx.actorId}::uuid, now())
        ON CONFLICT (slot) DO UPDATE
          SET body = EXCLUDED.body,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
      `);
    }
    await tx.execute(sql`
      UPDATE site_memory_proposals
      SET status = ${input.decision === "accept" ? "accepted" : "rejected"},
          reviewed_by = ${ctx.actorId}::uuid,
          reviewed_at = now()
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_memory.review",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `decision=${input.decision} slot=${proposal.slot}`,
    });
    return ok({});
  },
});
