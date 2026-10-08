// SPDX-License-Identifier: MPL-2.0

/**
 * P10A — per-user pinned defaults + per-chat manual engagement state.
 *
 *   skills.list_pin_defaults / skills.set_pin_defaults — user-level
 *     "always engage these in fresh chats." Per-user; no Owner gate
 *     because pinning is an editorial preference, not a security
 *     decision.
 *
 *   chat.set_engaged_skills — manual override list per chat session.
 *     Persisted on chat_sessions.engaged_skills as
 *     [{ skillId, slug, displayName, intent: 'engage' | 'disengage' }].
 *     Manual overrides win over pinned defaults + the auto-matcher.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { jsonbParam } from "../../sql-helpers.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/**
 * Whose pin defaults a call reads or writes. A human edits their own; the
 * AI edits those of the operator its chat acts for (the chat session's
 * creator) — pins are a per-user preference, and the AI actor is not a
 * user, so writing under its own id would fail the users FK and pin
 * nothing anyone sees. Outside a chat the AI has no operator to act for.
 * (No join to users/actors here: their RLS shows a row only to that actor;
 * the skill_pin_defaults → users foreign key still rejects a non-user.)
 */
async function pinOwner(
  tx: Tx,
  ctx: ExecutionContext,
  operation: string,
): Promise<{ ok: true; userId: string } | { ok: false; message: string }> {
  if (ctx.actorKind !== "ai") return { ok: true, userId: ctx.actorId };
  const rows = ctx.chatBranchId
    ? ((await tx.execute(sql`
        SELECT created_by::text AS user_id FROM chat_sessions
        WHERE chat_branch_id = ${ctx.chatBranchId}::uuid LIMIT 1
      `)) as unknown as { user_id: string }[])
    : [];
  const userId = rows[0]?.user_id;
  if (!userId) {
    return {
      ok: false,
      message: `${operation}: pinned skills belong to the person a chat acts for — call this from a chat session (caelo_open_session on the Power-MCP).`,
    };
  }
  return { ok: true, userId };
}

const pinDefaultRow = z.object({
  skillId: z.string(),
  slug: z.string(),
  displayName: z.string(),
});

export const listPinDefaultsOp = defineOperation({
  name: "skills.list_pin_defaults",
  // v0.2.19 — read-only per-user list. AI may want to surface "your
  // pinned skills are X, Y" in chat without bouncing through a
  // separate human round-trip.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Defaults to the calling user when omitted. */
      userId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({ pinDefaults: z.array(pinDefaultRow) }),
  handler: async (ctx, input, tx) => {
    let userId = input.userId;
    if (userId === undefined) {
      const owner = await pinOwner(tx, ctx, "skills.list_pin_defaults");
      if (!owner.ok) {
        return err({
          kind: "HandlerError",
          operation: "skills.list_pin_defaults",
          message: owner.message,
        });
      }
      userId = owner.userId;
    }
    const rows = (await tx.execute(sql`
      SELECT s.id::text AS skill_id, s.slug, s.display_name
      FROM skill_pin_defaults p
      JOIN skills s ON s.id = p.skill_id
      WHERE p.user_id = ${userId}::uuid AND s.status = 'active'
        AND plugin_skill_available(s.plugin_id, s.plugin_artifact_digest, s.plugin_owner_slug)
      ORDER BY s.slug ASC
    `)) as unknown as { skill_id: string; slug: string; display_name: string }[];
    return ok({
      pinDefaults: rows.map((r) => ({
        skillId: r.skill_id,
        slug: r.slug,
        displayName: r.display_name,
      })),
    });
  },
});

export const setPinDefaultsOp = defineOperation({
  name: "skills.set_pin_defaults",
  // v0.2.19 — per-user editorial preference; reverting is a one-call
  // re-pin, no blast radius beyond this user. AI-callable so the
  // operator can ask "always pin scoped-edit when I open a chat" and
  // the AI handles the persistence.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      skillIds: z.array(z.string().uuid()).max(50),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const owner = await pinOwner(tx, ctx, "skills.set_pin_defaults");
    if (!owner.ok) {
      return err({
        kind: "HandlerError",
        operation: "skills.set_pin_defaults",
        message: owner.message,
      });
    }
    await tx.execute(sql`
      DELETE FROM skill_pin_defaults WHERE user_id = ${owner.userId}::uuid
    `);
    for (const skillId of input.skillIds) {
      await tx.execute(sql`
        INSERT INTO skill_pin_defaults (user_id, skill_id)
        VALUES (${owner.userId}::uuid, ${skillId}::uuid)
        ON CONFLICT DO NOTHING
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "skills.set_pin_defaults",
      input,
      succeeded: true,
      entityId: owner.userId,
      resultSummary: `count=${input.skillIds.length}`,
    });
    return ok({});
  },
});

const manualOverride = z
  .object({
    skillId: z.string().uuid(),
    slug: z.string().min(1).max(120),
    displayName: z.string().min(1).max(200),
    intent: z.enum(["engage", "disengage"]),
  })
  .strict();

export const setEngagedSkillsOp = defineOperation({
  name: "chat.set_engaged_skills",
  // Why human-only: CLAUDE.md §2 — manual skill (dis)engagement is the operator's override and
  // always wins; the AI loads skills with load_skill instead.
  // Per-chat manual overrides. Owner / editor curates their chat;
  // AI doesn't override its own engagement set (CLAUDE.md §2 — manual
  // disengagement always wins).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      overrides: z.array(manualOverride),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const updated = (await tx.execute(sql`
      UPDATE chat_sessions
      SET engaged_skills = ${jsonbParam(input.overrides)}
      WHERE id = ${input.chatSessionId}::uuid AND archived_at IS NULL
      RETURNING id
    `)) as unknown as { id: string }[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "chat.set_engaged_skills",
        message: "chat session not found",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.set_engaged_skills",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `overrides=${input.overrides.length}`,
    });
    return ok({});
  },
});
