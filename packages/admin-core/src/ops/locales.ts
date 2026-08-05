// SPDX-License-Identifier: MPL-2.0

/**
 * Locale registry — READ surface only.
 *
 * Epic #380 Phase A (#382): the propose/execute management layer is
 * deleted; locale definitions become plugin-owned data on the new
 * foundation (#394). These two read ops survive until the page-identity
 * cut (#384) because pages still carry a `locale` column that the
 * editor's preview-path resolution and the AI's `list_locales` tool
 * need to interpret.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

// BCP-47-ish: lowercase letter pair, optional region. Loose; the
// browser still accepts it as a valid lang tag.
const localeCodeSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "BCP-47 like 'en' or 'de-AT'");

const urlStrategySchema = z.enum(["none", "subdirectory", "subdomain", "domain"]);

const localeRowSchema = z.object({
  code: z.string(),
  displayName: z.string(),
  urlStrategy: urlStrategySchema,
  urlHost: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

interface LocaleDbRow {
  code: string;
  display_name: string;
  url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
  url_host: string | null;
  is_default: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToOut(r: LocaleDbRow): z.infer<typeof localeRowSchema> {
  return {
    code: r.code,
    displayName: r.display_name,
    urlStrategy: r.url_strategy,
    urlHost: r.url_host,
    isDefault: r.is_default,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export const listLocalesOp = defineOperation({
  name: "locales.list",
  // CLAUDE.md §11: read surface open so the AI can plan multi-locale
  // edits without a human round-trip.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ locales: z.array(localeRowSchema) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT code, display_name, url_strategy, url_host, is_default,
             created_at, updated_at
      FROM locales
      ORDER BY is_default DESC, code ASC
    `)) as unknown as LocaleDbRow[];
    return ok({ locales: rows.map(rowToOut) });
  },
});

export const getLocaleOp = defineOperation({
  name: "locales.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ code: localeCodeSchema }).strict(),
  output: z.object({ locale: localeRowSchema.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT code, display_name, url_strategy, url_host, is_default,
             created_at, updated_at
      FROM locales WHERE code = ${input.code} LIMIT 1
    `)) as unknown as LocaleDbRow[];
    const r = rows[0];
    return ok({ locale: r ? rowToOut(r) : null });
  },
});
