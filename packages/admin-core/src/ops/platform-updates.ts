// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #696 Phase 0 — what this install runs and what the newest Caelo
 * release is, for Settings → Updates, the bell's release notice and the
 * AI's `get_caelo_version` tool.
 *
 * Read-only and open to the AI: the AI may *tell* the operator an update
 * exists and where to install it, never install one (CLAUDE.md §2, #696
 * maintainer decision 3). Installing happens outside the Query API today
 * (the Owner runs the provisioning CLI); the Phase 2 install ops will be
 * human-only.
 *
 * The newest release comes from `release_check_cache`, which the
 * release-check worker fills from GitHub once an hour — no network inside
 * this op's transaction (see release-check-worker.ts for why).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { CAELO_VERSION, err, isNewerVersion, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** Where the Owner installs updates. One constant so the bell, the op and the AI agree. */
export const UPDATES_PATH = "/settings/updates";

const platformUpdateStatus = z.object({
  /** The release this admin runs. */
  installedVersion: z.string(),
  /** The newest stable release, or null when the release check has not reached GitHub yet or its last attempt failed. */
  latestVersion: z.string().nullable(),
  upgradeAvailable: z.boolean(),
  releaseUrl: z.string().nullable(),
  /** The newest release's notes (GitHub Markdown, as published), or null. */
  releaseNotes: z.string().nullable(),
  publishedAt: z.string().nullable(),
  /** When the release check last ran; null when it has never run since the admin was installed. */
  checkedAt: z.string().nullable(),
  /** Admin path where the Owner installs updates. */
  updatesPath: z.literal(UPDATES_PATH),
});

/** Output of `platform_updates.status`. */
export type PlatformUpdateStatus = z.infer<typeof platformUpdateStatus>;

export const platformUpdateStatusOp = defineOperation({
  name: "platform_updates.status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: platformUpdateStatus,
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT latest_version,
             release_url,
             release_notes,
             to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
             -- The migration seeds the singleton with the epoch: "never checked".
             CASE WHEN fetched_at > 'epoch'::timestamptz
                  THEN to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             END AS checked_at
        FROM release_check_cache
       WHERE id = 1
    `)) as unknown as {
      latest_version: string | null;
      release_url: string | null;
      release_notes: string | null;
      published_at: string | null;
      checked_at: string | null;
    }[];
    const r = rows[0];
    if (!r) {
      // Migration 0053 seeds the row; without it the release check has
      // nowhere to write, which is a broken install, not "no update".
      return err({
        kind: "HandlerError",
        operation: "platform_updates.status",
        message:
          "release_check_cache has no row (id = 1); migration 0053 seeds it — re-run the database migrations.",
      });
    }
    return ok({
      installedVersion: CAELO_VERSION,
      latestVersion: r.latest_version,
      upgradeAvailable:
        r.latest_version !== null && isNewerVersion(r.latest_version, CAELO_VERSION),
      releaseUrl: r.release_url,
      releaseNotes: r.release_notes,
      publishedAt: r.published_at,
      checkedAt: r.checked_at,
      updatesPath: UPDATES_PATH,
    });
  },
});
