// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 4c — `platform_updates.agent_status` against real Postgres
 * (§6): the self-hosted update agent's heartbeat (migration 0270), read
 * with the database's clock, recent for five minutes, open to the AI.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "platform-update-agent-int",
};

/** Write the heartbeat as the agent would (minutesAgo before the database's now). */
async function beat(minutesAgo: number | null, problem: string | null = null): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM platform_update_agent`;
      if (minutesAgo !== null) {
        await tx`
          INSERT INTO platform_update_agent (id, agent_version, host, last_seen_at, problem)
          VALUES (1, '0.10.47', 'box-1', now() - make_interval(mins => ${minutesAgo}), ${problem})`;
      }
    });
  } finally {
    await sql.end();
  }
}

async function agentStatus(): Promise<PlatformUpdateAgentStatus | null> {
  const r = await execute(registry, adapter, AI, "platform_updates.agent_status", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { agent: PlatformUpdateAgentStatus | null }).agent;
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});
beforeEach(() => beat(null));
afterAll(async () => {
  await beat(null);
  await adapter.close();
});

describe("platform_updates.agent_status", () => {
  it("is null on an install whose agent never checked in", async () => {
    expect(await agentStatus()).toBeNull();
  });

  it("reports a recent check-in with the agent's own problem", async () => {
    await beat(1, "cosign is not installed on the server.");
    expect(await agentStatus()).toMatchObject({
      agentVersion: "0.10.47",
      host: "box-1",
      problem: "cosign is not installed on the server.",
      checkedInRecently: true,
    });
  });

  it("stops counting an agent that missed five polls", async () => {
    await beat(6);
    expect((await agentStatus())?.checkedInRecently).toBe(false);
  });
});
