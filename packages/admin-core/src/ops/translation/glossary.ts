// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — site_glossary CRUD. Read open to all in-scope actors so the
 * Mode 1 / Mode 2 prompt builders can inject the glossary without a
 * round-trip; writes Owner-only.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const glossaryRow = z.object({
  id: z.string(),
  sourceTerm: z.string(),
  locale: z.string(),
  translation: z.string(),
  context: z.string().nullable(),
  updatedAt: z.string(),
});

interface DbRow {
  id: string;
  source_term: string;
  locale: string;
  translation: string;
  context: string | null;
  updated_at: string | Date;
}

function rowToOut(r: DbRow): z.infer<typeof glossaryRow> {
  return {
    id: r.id,
    sourceTerm: r.source_term,
    locale: r.locale,
    translation: r.translation,
    context: r.context,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export const listGlossaryOp = defineOperation({
  name: "glossary.list",
  // Read open: prompt builder reads this on every translation call.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ locale: z.string().min(2).max(10).optional() }).strict(),
  output: z.object({ entries: z.array(glossaryRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      input.locale
        ? sql`
            SELECT id::text AS id, source_term, locale, translation, context, updated_at
            FROM site_glossary WHERE locale = ${input.locale}
            ORDER BY source_term ASC
          `
        : sql`
            SELECT id::text AS id, source_term, locale, translation, context, updated_at
            FROM site_glossary
            ORDER BY locale ASC, source_term ASC
          `,
    )) as unknown as DbRow[];
    return ok({ entries: rows.map(rowToOut) });
  },
});

export const setGlossaryEntryOp = defineOperation({
  name: "glossary.set",
  // Why human-only: terminology decisions are an Owner / editor call,
  // not an AI judgment — the glossary is the human anchor that keeps
  // AI translations consistent across pages.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      sourceTerm: z.string().min(1).max(200),
      locale: z.string().min(2).max(10),
      translation: z.string().min(1).max(500),
      context: z.string().max(500).nullable().optional(),
    })
    .strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO site_glossary (source_term, locale, translation, context, created_by)
      VALUES (${input.sourceTerm}, ${input.locale}, ${input.translation}, ${input.context ?? null}, ${ctx.actorId}::uuid)
      ON CONFLICT (source_term, locale) DO UPDATE
        SET translation = EXCLUDED.translation,
            context = EXCLUDED.context,
            updated_at = now()
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({ kind: "HandlerError", operation: "glossary.set", message: "no id returned" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "glossary.set",
      input,
      succeeded: true,
      entityId: id,
      resultSummary: `${input.sourceTerm}/${input.locale}`,
    });
    return ok({ id });
  },
});

export const deleteGlossaryEntryOp = defineOperation({
  name: "glossary.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ id: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM site_glossary WHERE id = ${input.id}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "glossary.delete",
      input,
      succeeded: true,
      entityId: input.id,
    });
    return ok({});
  },
});
