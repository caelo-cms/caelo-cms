// SPDX-License-Identifier: MPL-2.0

/**
 * The host agent's settings in `.caelo/config.json` (#696 Phase 4c): its
 * database password and the loopback port Postgres is published on for it.
 * Generated once and kept, so re-running `agent install`, `up` or `upgrade`
 * converges onto the same values.
 */

import { isAgentDbPort } from "../compose.js";
import { AGENT_DB_ROLE } from "../self-hosted-roles.js";
import type { AgentDbConnection } from "./queue.js";

/** `config.json` → `agent`. */
export interface AgentConfig {
  readonly dbPort: number;
  readonly dbPassword: string;
  /**
   * Set by `agent uninstall`: `init` / `upgrade` then leave the agent off
   * until `agent install` is run again.
   */
  readonly disabled?: boolean;
}

/** The first port tried for the agent's Postgres; the next free one is taken. */
export const AGENT_DB_PORT_DEFAULT = 15432;
const PORT_CANDIDATES = 50;

/** Whether nothing listens on `127.0.0.1:port` (a quick bind test). */
export function loopbackPortFree(port: number): boolean {
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent's settings: `existing` unchanged (a running install keeps its
 * port and password), else a fresh password and the first free port from
 * {@link AGENT_DB_PORT_DEFAULT} (or `requestedPort`).
 *
 * @throws when `requestedPort` is not usable or no candidate port is free
 */
export function agentConfigFor(
  existing: AgentConfig | undefined,
  opts: {
    readonly requestedPort?: number;
    readonly randomSecret: () => string;
    readonly portFree?: (port: number) => boolean;
  },
): AgentConfig {
  const free = opts.portFree ?? loopbackPortFree;
  if (existing && (opts.requestedPort === undefined || opts.requestedPort === existing.dbPort)) {
    const { disabled: _disabled, ...kept } = existing;
    return kept;
  }
  if (opts.requestedPort !== undefined) {
    if (!isAgentDbPort(opts.requestedPort)) {
      throw new Error(`--port ${opts.requestedPort} is not a TCP port between 1024 and 65535.`);
    }
    if (!free(opts.requestedPort)) {
      throw new Error(
        `Port ${opts.requestedPort} on 127.0.0.1 is in use; pick another with --port.`,
      );
    }
    return { dbPort: opts.requestedPort, dbPassword: existing?.dbPassword ?? opts.randomSecret() };
  }
  for (let port = AGENT_DB_PORT_DEFAULT; port < AGENT_DB_PORT_DEFAULT + PORT_CANDIDATES; port++) {
    if (free(port)) return { dbPort: port, dbPassword: opts.randomSecret() };
  }
  throw new Error(
    `No free port on 127.0.0.1 between ${AGENT_DB_PORT_DEFAULT} and ${AGENT_DB_PORT_DEFAULT + PORT_CANDIDATES - 1}; pass --port.`,
  );
}

/** The agent's database login. */
export function agentDbConnection(agent: AgentConfig): AgentDbConnection {
  return { user: AGENT_DB_ROLE, password: agent.dbPassword, port: agent.dbPort };
}
