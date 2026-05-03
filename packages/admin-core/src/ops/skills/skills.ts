// SPDX-License-Identifier: MPL-2.0

/**
 * P10A — skills CRUD. Owner-curated rows; AI-curated proposals land
 * in `skill_proposals` (separate file). Reads open to all in-scope
 * actors so the chat-runner can fetch active skills per turn without
 * a permission round-trip.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, skillAutoEngagementHints } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const skillRow = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  body: z.string(),
  allowlistedTools: z.array(z.string()),
  hints: skillAutoEngagementHints,
  status: z.enum(["awaiting_activation", "active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

interface SkillDb {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  body: string;
  allowlisted_tools: unknown;
  auto_engagement_hints: unknown;
  status: "awaiting_activation" | "active" | "archived";
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToOut(r: SkillDb): z.infer<typeof skillRow> {
  const hintsRaw =
    typeof r.auto_engagement_hints === "string"
      ? JSON.parse(r.auto_engagement_hints)
      : ((r.auto_engagement_hints as Record<string, unknown> | null) ?? {});
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    body: r.body,
    allowlistedTools: Array.isArray(r.allowlisted_tools)
      ? (r.allowlisted_tools as string[])
      : typeof r.allowlisted_tools === "string"
        ? (JSON.parse(r.allowlisted_tools) as string[])
        : [],
    hints: skillAutoEngagementHints.parse({
      keywords: (hintsRaw as { keywords?: unknown }).keywords ?? [],
      chipTrigger: (hintsRaw as { chipTrigger?: unknown }).chipTrigger ?? false,
      alwaysOn: (hintsRaw as { alwaysOn?: unknown }).alwaysOn ?? false,
    }),
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export const listSkillsOp = defineOperation({
  name: "skills.list",
  // CLAUDE.md §11: open read so the chat-runner matcher can fetch
  // every active skill per turn without a permission round-trip.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      status: z.enum(["awaiting_activation", "active", "archived", "any"]).default("active"),
    })
    .strict(),
  output: z.object({ skills: z.array(skillRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      input.status === "any"
        ? sql`
            SELECT id::text AS id, slug, display_name, description, body,
                   allowlisted_tools, auto_engagement_hints, status,
                   created_at, updated_at
            FROM skills
            ORDER BY status ASC, slug ASC
          `
        : sql`
            SELECT id::text AS id, slug, display_name, description, body,
                   allowlisted_tools, auto_engagement_hints, status,
                   created_at, updated_at
            FROM skills
            WHERE status = ${input.status}
            ORDER BY slug ASC
          `,
    )) as unknown as SkillDb[];
    return ok({ skills: rows.map(rowToOut) });
  },
});

export const getSkillOp = defineOperation({
  name: "skills.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: z.object({ skill: skillRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, description, body,
             allowlisted_tools, auto_engagement_hints, status,
             created_at, updated_at
      FROM skills WHERE slug = ${input.slug} LIMIT 1
    `)) as unknown as SkillDb[];
    const r = rows[0];
    return ok({ skill: r ? rowToOut(r) : null });
  },
});

const setSkillInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9-]+$/, "lowercase letters/digits/hyphens"),
    displayName: z.string().min(1).max(200),
    description: z.string().max(1000).default(""),
    body: z.string().min(1).max(20000),
    allowlistedTools: z.array(z.string().min(1).max(120)).default([]),
    hints: skillAutoEngagementHints.default({
      keywords: [],
      chipTrigger: false,
      alwaysOn: false,
    }),
    status: z.enum(["awaiting_activation", "active", "archived"]).default("active"),
  })
  .strict();

export const setSkillOp = defineOperation({
  name: "skills.set",
  // Why human-only: skill bodies enter the AI's system prompt; an AI
  // editing its own instructions without Owner approval is the prompt-
  // injection foothold this gate prevents. AI uses `skills.propose`
  // which queues for Owner review (CLAUDE.md §2 invariant).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: setSkillInput,
  output: z.object({ skillId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO skills (slug, display_name, description, body,
                          allowlisted_tools, auto_engagement_hints,
                          status, decided_by, decided_at)
      VALUES (
        ${input.slug}, ${input.displayName}, ${input.description}, ${input.body},
        ${JSON.stringify(input.allowlistedTools)}::jsonb,
        ${JSON.stringify(input.hints)}::jsonb,
        ${input.status},
        ${ctx.actorId}::uuid, now()
      )
      ON CONFLICT (slug) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        body = EXCLUDED.body,
        allowlisted_tools = EXCLUDED.allowlisted_tools,
        auto_engagement_hints = EXCLUDED.auto_engagement_hints,
        status = EXCLUDED.status,
        decided_by = EXCLUDED.decided_by,
        decided_at = now(),
        updated_at = now()
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const skillId = rows[0]?.id;
    if (!skillId) {
      return err({ kind: "HandlerError", operation: "skills.set", message: "no id" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "skills.set",
      input,
      succeeded: true,
      entityId: skillId,
      resultSummary: `slug=${input.slug} status=${input.status}`,
    });
    return ok({ skillId });
  },
});

export const archiveSkillOp = defineOperation({
  name: "skills.archive",
  // Why human-only: archiving a skill removes it from the matcher
  // permanently. Owner intent only.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE skills SET status = 'archived', updated_at = now(),
        decided_by = ${ctx.actorId}::uuid, decided_at = now()
      WHERE slug = ${input.slug}
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "skills.archive",
      input,
      succeeded: true,
      resultSummary: `slug=${input.slug}`,
    });
    return ok({});
  },
});
