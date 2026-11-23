// SPDX-License-Identifier: MPL-2.0
/**
 * The self-hosted host agent's database queue (#696 Phase 4c), opened over
 * the agent's own login on the Postgres port the install publishes on
 * 127.0.0.1 only. The provisioning package's build bundles this file into
 * `dist/agent-db.js` (with the Query API it needs), because the published
 * CLI cannot depend on this private package; see provisioning's
 * src/agent/queue.ts.
 */
import type { AgentDbConnection, OpenedAgentQueue } from "@caelo-cms/provisioning";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { installNamesFromEnv } from "@caelo-cms/shared";
import { createDbAgentQueue } from "./db-queue.js";

/**
 * Open the agent's queue. Verifies the login is who it should be (the role
 * check of the Query API adapter) before anything is read. The databases
 * are the install's (#1689: its name map, today's names when unset).
 *
 * @example
 *   const { queue, close } = await openAgentQueue({ user: "caelo_agent", password, port: 15432 });
 */
export async function openAgentQueue(conn: AgentDbConnection): Promise<OpenedAgentQueue> {
  const base = `postgres://${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@127.0.0.1:${conn.port}`;
  const names = installNamesFromEnv();
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: `${base}/${names.databases.admin}`,
    publicDatabaseUrl: `${base}/${names.databases.public}`,
    names,
    expectedRoles: { admin: conn.user, public: [conn.user] },
    // One poll at a time; the role check needs a second connection.
    poolMax: 2,
  });
  try {
    await adapter.verifyRoles();
  } catch (e) {
    await adapter.close();
    throw e;
  }
  return { queue: createDbAgentQueue(adapter), close: () => adapter.close() };
}
