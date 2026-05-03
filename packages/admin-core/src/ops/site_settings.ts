// SPDX-License-Identifier: MPL-2.0

/**
 * P9 — site_settings singleton (one row, id = 1). Currently holds
 * the Advanced URL Routing toggle: when false, the locale UI hides
 * 'subdomain' and 'domain' strategies + the locales linter rejects
 * propose-update-strategy attempts to those values. Most users never
 * leave the simple subdirectory default (UX-1).
 *
 * Owner-only writes (`actorScope: ["human","system"]`); reads open
 * to all kinds because the AI's chat-runner reads the toggle to know
 * whether to even mention subdomain/domain in tool descriptions.
 */

import { defineOperation } from "@caelo/query-api";
import { ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

const settingsRow = z.object({
  advancedUrlRouting: z.boolean(),
  updatedAt: z.string(),
});

export const getSiteSettingsOp = defineOperation({
  name: "site_settings.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ settings: settingsRow }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT advanced_url_routing, updated_at
      FROM site_settings WHERE id = 1 LIMIT 1
    `)) as unknown as { advanced_url_routing: boolean; updated_at: string | Date }[];
    const r = rows[0];
    if (!r) {
      // Singleton is seeded by the migration; absence is a hard error.
      return ok({
        settings: {
          advancedUrlRouting: false,
          updatedAt: new Date(0).toISOString(),
        },
      });
    }
    return ok({
      settings: {
        advancedUrlRouting: r.advanced_url_routing,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      },
    });
  },
});

export const setSiteSettingsOp = defineOperation({
  name: "site_settings.set",
  // Why human-only: Owner-only — flipping advanced URL routing exposes
  // subdomain/domain strategies to the AI tool surface site-wide.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      advancedUrlRouting: z.boolean(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE site_settings
      SET advanced_url_routing = ${input.advancedUrlRouting},
          updated_at = now(),
          updated_by = ${ctx.actorId}::uuid
      WHERE id = 1
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "site_settings.set",
      input,
      succeeded: true,
      resultSummary: `advanced_url_routing=${input.advancedUrlRouting}`,
    });
    return ok({});
  },
});
