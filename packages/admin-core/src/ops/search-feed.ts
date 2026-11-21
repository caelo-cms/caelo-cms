// SPDX-License-Identifier: MPL-2.0

/**
 * `search_feed.plan_plugin_data` — which live pages a plugin-data build
 * changes for search engines (docs/dev/search-engine-feed.md): the re-baked
 * pages whose plugin content differs from the live record, with what their
 * feed entry needs. Read while the build holds the live-release lease, so
 * the record cannot move before `deploy.finish_plugin_data_run` appends the
 * same pages.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { pluginDataChanges } from "../search-feed/live-versions.js";

const digestShape = z
  .object({
    pageId: z.string().uuid(),
    pluginFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

export const planPluginDataSearchFeedOp = defineOperation({
  name: "search_feed.plan_plugin_data",
  readScope: "request",
  // Why system-only: a step of deploy.build_plugin_data (system actor).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ digests: z.array(digestShape).max(2000) }).strict(),
  output: z.object({
    changes: z.array(
      z.object({ pageId: z.string(), url: z.string(), firstPublishedAt: z.string() }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const changes = await pluginDataChanges(tx, input.digests);
    if (changes.length === 0) return ok({ changes: [] });
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, first_published_at FROM pages
      WHERE id IN (
        SELECT jsonb_array_elements_text((${JSON.stringify(changes.map((c) => c.pageId))}::text)::jsonb)::uuid
      )
    `)) as unknown as { id: string; first_published_at: string | Date | null }[];
    const published = new Map(rows.map((r) => [r.id, r.first_published_at]));
    const out: { pageId: string; url: string; firstPublishedAt: string }[] = [];
    for (const c of changes) {
      const at = published.get(c.pageId);
      // A page the live record holds went live with a Publish live, which
      // stamped its first publication: none means the two disagree.
      if (at === null || at === undefined) {
        return err({
          kind: "HandlerError",
          operation: "search_feed.plan_plugin_data",
          message: `page ${c.pageId} is live in the record but has no first publication; the next Publish live records it`,
        });
      }
      out.push({
        pageId: c.pageId,
        url: c.url,
        firstPublishedAt: (at instanceof Date ? at : new Date(at)).toISOString(),
      });
    }
    return ok({ changes: out });
  },
});
