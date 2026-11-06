// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy.get_run_origin` — where one deploy run's build can be read back,
 * for providers that publish to a hosting service whose files the admin
 * cannot list (gcp-firebase).
 *
 * #1088 / #1330 — `inspect_built_page` on a Firebase install reads a staged
 * run from its staging slot (`publish_summary.stagingLocation`, the private
 * staging bucket the staging gateway serves) and names the staging host.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const getDeployRunOriginOp = defineOperation({
  name: "deploy.get_run_origin",
  readScope: "request",
  // CLAUDE.md §11 — a read; the AI reaches it through inspect_built_page.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({
    runId: z.string(),
    env: z.string(),
    status: z.string(),
    /** #1330 — the staged run's slot in the staging bucket; null before it. */
    stagingLocation: z.string().nullable(),
    /** `https://<staging host>`, as operators know staging; null while no host is set. */
    stagingOrigin: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id, t.env, r.status,
             r.publish_summary->>'stagingLocation' AS staging_location,
             (SELECT 'https://' || s.staging_host FROM staging_access s
               WHERE s.id = 1 AND s.staging_host IS NOT NULL) AS staging_origin
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.id = ${input.runId}::uuid
    `)) as unknown as {
      id: string;
      env: string;
      status: string;
      staging_location: string | null;
      staging_origin: string | null;
    }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "deploy.get_run_origin",
        message: `deploy run ${input.runId} does not exist — omit runId to read the newest staged build`,
        refusal: true,
      });
    }
    return ok({
      runId: row.id,
      env: row.env,
      status: row.status,
      stagingLocation: row.staging_location,
      stagingOrigin: row.staging_origin,
    });
  },
});
