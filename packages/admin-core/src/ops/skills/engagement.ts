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
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { jsonbParam } from "../../sql-helpers.js";

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
    const userId = input.userId ?? ctx.actorId;
    const rows = (await tx.execute(sql`
      SELECT s.id::text AS skill_id, s.slug, s.display_name
      FROM skill_pin_defaults p
      JOIN skills s ON s.id = p.skill_id
      WHERE p.user_id = ${userId}::uuid AND s.status = 'active'
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
    await tx.execute(sql`
      DELETE FROM skill_pin_defaults WHERE user_id = ${ctx.actorId}::uuid
    `);
    for (const skillId of input.skillIds) {
      await tx.execute(sql`
        INSERT INTO skill_pin_defaults (user_id, skill_id)
        VALUES (${ctx.actorId}::uuid, ${skillId}::uuid)
        ON CONFLICT DO NOTHING
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "skills.set_pin_defaults",
      input,
      succeeded: true,
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
