// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — site_style_guide singleton-per-locale CRUD. Owner-edited
 * markdown describing tone / voice / formality for the target locale;
 * injected into Mode 1 / Mode 2 prompts.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const styleGuideRow = z.object({
  locale: z.string(),
  body: z.string(),
  updatedAt: z.string(),
});

export const listStyleGuidesOp = defineOperation({
  name: "style_guide.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ guides: z.array(styleGuideRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT locale, body, updated_at FROM site_style_guide ORDER BY locale ASC
    `)) as unknown as { locale: string; body: string; updated_at: string | Date }[];
    return ok({
      guides: rows.map((r) => ({
        locale: r.locale,
        body: r.body,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      })),
    });
  },
});

export const getStyleGuideOp = defineOperation({
  name: "style_guide.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ locale: z.string().min(2).max(10) }).strict(),
  output: z.object({ guide: styleGuideRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT locale, body, updated_at FROM site_style_guide WHERE locale = ${input.locale} LIMIT 1
    `)) as unknown as { locale: string; body: string; updated_at: string | Date }[];
    const r = rows[0];
    if (!r) return ok({ guide: null });
    return ok({
      guide: {
        locale: r.locale,
        body: r.body,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      },
    });
  },
});

export const setStyleGuideOp = defineOperation({
  name: "style_guide.set",
  // CMS_REQUIREMENTS §7.9: "AI can manage the site glossary and style
  // guide." Editor pushes a tone correction → AI offers to persist it
  // here so the next translation prompt picks it up. Audit captures
  // every write.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      locale: z.string().min(2).max(10),
      body: z.string().min(1).max(4000),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO site_style_guide (locale, body, updated_by)
      VALUES (${input.locale}, ${input.body}, ${ctx.actorId}::uuid)
      ON CONFLICT (locale) DO UPDATE
        SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "style_guide.set",
      input,
      succeeded: true,
      resultSummary: `locale=${input.locale} length=${input.body.length}`,
    });
    return ok({});
  },
});

export const deleteStyleGuideOp = defineOperation({
  name: "style_guide.delete",
  // §7.9 — AI can manage style guide; same audit guarantees as `set`.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ locale: z.string().min(2).max(10) }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM site_style_guide WHERE locale = ${input.locale}`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "style_guide.delete",
      input,
      succeeded: true,
    });
    return ok({});
  },
});
