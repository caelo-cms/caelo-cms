// SPDX-License-Identifier: MPL-2.0

/**
 * `platform_updates.agent_status` — the self-hosted update agent's last
 * check-in (epic #696 Phase 4c). On a self-hosted install "Install update"
 * is carried out by `caelo-agent`, a systemd timer on the server that polls
 * for requests (packages/provisioning/src/agent/); it rewrites one heartbeat
 * row on every poll (migration 0270). Settings → Updates offers the button
 * only while that row is recent, and shows the agent's own preflight problem
 * (no cosign, no Docker access) before the Owner clicks.
 *
 * Read-only and open to the AI like the rest of the update status (#696
 * decision 3: the AI informs, it never installs).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { agentCheckedInRecently, ok, type PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const agentStatusSchema = z.object({
  agentVersion: z.string(),
  host: z.string(),
  lastSeenAt: z.string(),
  problem: z.string().nullable(),
  checkedInRecently: z.boolean(),
});

export const platformUpdatesAgentStatusOp = defineOperation({
  name: "platform_updates.agent_status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ agent: agentStatusSchema.nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT agent_version, host, last_seen_at, problem, now() AS db_now
        FROM platform_update_agent WHERE id = 1
    `)) as unknown as {
      agent_version: string;
      host: string;
      last_seen_at: Date | string;
      problem: string | null;
      db_now: Date | string;
    }[];
    const row = rows[0];
    if (!row) return ok({ agent: null });
    // The database's clock, not the admin's: the agent wrote last_seen_at
    // with it.
    const agent: PlatformUpdateAgentStatus = {
      agentVersion: row.agent_version,
      host: row.host,
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      problem: row.problem,
      checkedInRecently: agentCheckedInRecently(row.last_seen_at, new Date(row.db_now)),
    };
    return ok({ agent });
  },
});
