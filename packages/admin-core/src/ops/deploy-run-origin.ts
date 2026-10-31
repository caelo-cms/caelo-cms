// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy.get_run_origin` — where one deploy run's build can be read back
 * over HTTP, for providers that publish to a hosting service instead of a
 * bucket the admin reads (gcp-firebase: the run's preview channel).
 *
 * #1088 — `inspect_built_page` on a Firebase install needs the run's
 * preview channel origin (recorded in `publish_summary.previewUrl`) and the
 * staging host it was rendered for (`site_url`). `deploy.list_runs` does not
 * carry the preview origin on purpose: #650 keeps that URL internal, and
 * list_runs feeds operator surfaces. Callers of this op must not show
 * `previewUrl` to anyone; they name `siteUrl` instead.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const getDeployRunOriginOp = defineOperation({
  name: "deploy.get_run_origin",
  readScope: "request",
  // CLAUDE.md §11 — a read; the AI reaches it only through
  // inspect_built_page, which never prints the internal preview origin.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({
    runId: z.string(),
    env: z.string(),
    status: z.string(),
    /** Internal origin of the staged build (#650: never shown). */
    previewUrl: z.string().nullable(),
    /** The staging host the build was rendered for, as operators know it. */
    siteUrl: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id, t.env, r.status,
             r.publish_summary->>'previewUrl' AS preview_url, r.site_url
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.id = ${input.runId}::uuid
    `)) as unknown as {
      id: string;
      env: string;
      status: string;
      preview_url: string | null;
      site_url: string | null;
    }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "deploy.get_run_origin",
        message: `deploy run ${input.runId} does not exist — omit runId to read the newest staged build`,
      });
    }
    return ok({
      runId: row.id,
      env: row.env,
      status: row.status,
      previewUrl: row.preview_url,
      siteUrl: row.site_url,
    });
  },
});
