// SPDX-License-Identifier: MPL-2.0

/**
 * The self-hosted host agent's database side (#696 Phase 4c): the same
 * {@link UpdateQueue} the Google Cloud upgrader job drives, plus the
 * heartbeat the admin reads to decide whether to offer "Install update".
 *
 * The queue is implemented in `@caelo-cms/platform-updater` (the job ops,
 * through the Query API — never raw SQL), which the published CLI cannot
 * depend on: it is private, and it depends on this package. So the build
 * bundles its `agent-db` entry into `dist/agent-db.js` (package.json
 * `build`), and {@link loadAgentQueueOpener} imports that file; a source
 * checkout imports the workspace package instead.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { UpdateQueue } from "../upgrader-job.js";

/** One check-in of the agent (`platform_update_agent`). */
export interface AgentHeartbeat {
  /** The Caelo release of the agent's own code. */
  readonly agentVersion: string;
  /** The host it runs on. */
  readonly host: string;
  /** Why an install would fail on this host right now; null when none. */
  readonly problem: string | null;
}

/** The upgrader's queue plus the agent's heartbeat. */
export interface AgentQueue extends UpdateQueue {
  heartbeat(beat: AgentHeartbeat): Promise<void>;
}

/** Where the agent's database login reaches Postgres (loopback only). */
export interface AgentDbConnection {
  readonly user: string;
  readonly password: string;
  readonly port: number;
}

/** An open queue and the pools behind it. */
export interface OpenedAgentQueue {
  readonly queue: AgentQueue;
  close(): Promise<void>;
}

/** Opens the queue over the agent's login (`@caelo-cms/platform-updater` agent-db). */
export type OpenAgentQueue = (conn: AgentDbConnection) => Promise<OpenedAgentQueue>;

/** The bundled queue next to the compiled CLI (`dist/agent-db.js`). */
export const BUNDLED_AGENT_DB = "../agent-db.js";

/**
 * The workspace package a source checkout loads instead. Held in a variable
 * so TypeScript does not resolve it: provisioning cannot declare a
 * dependency on the package that depends on it.
 */
const WORKSPACE_AGENT_DB = "@caelo-cms/platform-updater/agent-db";

/**
 * Load the function that opens the agent's queue: the bundle shipped in the
 * published package, else (a source checkout) the workspace package.
 *
 * @throws when neither is present — a build that skipped the bundle
 */
export async function loadAgentQueueOpener(): Promise<OpenAgentQueue> {
  const bundled = new URL(BUNDLED_AGENT_DB, import.meta.url);
  const specifier = existsSync(fileURLToPath(bundled)) ? bundled.href : WORKSPACE_AGENT_DB;
  let mod: { openAgentQueue?: OpenAgentQueue };
  try {
    mod = (await import(specifier)) as { openAgentQueue?: OpenAgentQueue };
  } catch (e) {
    throw new Error(
      `the update agent's database module is missing (${specifier}: ${e instanceof Error ? e.message : String(e)}). This @caelo-cms/provisioning build is incomplete — reinstall it.`,
    );
  }
  if (typeof mod.openAgentQueue !== "function") {
    throw new Error(
      `${specifier} does not export openAgentQueue — reinstall @caelo-cms/provisioning.`,
    );
  }
  return mod.openAgentQueue;
}
