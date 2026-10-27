// SPDX-License-Identifier: MPL-2.0

/**
 * #1003 — the start of a deploy run, committed on its own.
 *
 * deploy.trigger and deploy.promote build and publish inside one long
 * transaction. Their `deploy_runs` row used to be inserted in that
 * transaction too, so nobody saw a run while it ran: the deployments page
 * never showed a running build, and every progress write (one per page,
 * on its own connection) matched no row. This op inserts the row as
 * `running` in its own transaction, so it is visible at once and its
 * progress lands; the building transaction finishes the row.
 *
 * The caller holds the run's advisory lock (deploy-run-lock.ts) before
 * calling, so this op's sweep of runs that died mid-build never touches
 * a run that is still being built — on this instance or any other.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { deployRunIsOrphaned } from "../deploy/deploy-run-lock.js";
import { deployPluginProblem } from "../deploy/plugin-problems.js";
import { jsonbParam } from "../sql-helpers.js";

/** What a run that died mid-build says, and what to do about it. */
export const ORPHANED_RUN_MESSAGE =
  "This build stopped without finishing (the admin restarted or crashed while it ran), so nothing it built was published. Start it again.";

export const beginDeployRunOp = defineOperation({
  name: "deploy.begin_run",
  // Why human-only: internal step of deploy.trigger / deploy.promote, which
  // call it under the system actor; it carries no decision of its own.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      targetId: z.string().uuid(),
      /**
       * Who started the run (the trigger's actor, not the system actor this
       * op runs as). Not `.uuid()`: the system actor's id is not an RFC 4122
       * UUID; the `::uuid` cast checks the format.
       */
      actorId: z.string().min(1),
      /** The trigger's start on the DB clock, so the run's span covers its preparation. */
      startedAt: z.string().min(1),
      /** #553 — main's render fingerprint at the start of a staging build. */
      renderFingerprint: z.unknown().nullable(),
      /** #834 — the Caelo version rendering the build; null for a copy-promote. */
      caeloVersion: z.string().nullable(),
      /**
       * #1008 — the active plugins that did not run for this build (Publish
       * live refuses a Stage that has any); null for a dev build or a
       * Publish live run, which are not checked.
       */
      pluginProblems: z.array(deployPluginProblem).nullable(),
    })
    .strict(),
  output: z.object({ orphanedRunIds: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const running = (await tx.execute(sql`
      SELECT id::text AS id FROM deploy_runs WHERE status = 'running' AND id <> ${input.runId}::uuid
    `)) as unknown as { id: string }[];
    const orphanedRunIds: string[] = [];
    for (const { id } of running) {
      if (!(await deployRunIsOrphaned(tx, id))) continue;
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = clock_timestamp(), error_message = ${ORPHANED_RUN_MESSAGE}
        WHERE id = ${id}::uuid AND status = 'running'
      `);
      orphanedRunIds.push(id);
    }
    await tx.execute(sql`
      INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, render_fingerprint,
                               caelo_version, plugin_problems)
      VALUES (${input.runId}::uuid, ${input.targetId}::uuid, ${input.actorId}::uuid, 'running',
              ${input.startedAt}::timestamptz,
              ${input.renderFingerprint === null ? sql`NULL` : jsonbParam(input.renderFingerprint)},
              ${input.caeloVersion},
              ${input.pluginProblems === null ? sql`NULL` : jsonbParam(input.pluginProblems)})
    `);
    if (orphanedRunIds.length > 0) {
      console.error("[deploy] marked runs that stopped mid-build as failed", { orphanedRunIds });
    }
    return ok({ orphanedRunIds });
  },
});
