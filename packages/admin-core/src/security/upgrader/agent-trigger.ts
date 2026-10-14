// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's side of "Install update" on self-hosted installs (epic #696
 * Phase 4c). There is nothing to start: the update agent on the server
 * (`caelo-agent`, a systemd timer — packages/provisioning/src/agent/) polls
 * for requests every minute, so the request row the Owner just wrote IS the
 * trigger. What the admin can do is refuse to queue a request nobody would
 * pick up — the agent missing, silent, or reporting a problem that would
 * stop the install anyway — and say what to do on the server instead.
 *
 * The admin holds no credential for the server and no Docker access; the
 * agent holds no admin credential. They meet only in the database rows.
 */

import {
  CAELO_VERSION,
  type PlatformUpdateAgentStatus,
  provisioningCommand,
} from "@caelo-cms/shared";
import { type UpgraderTrigger, UpgraderTriggerError } from "./job-trigger.js";

/** The command that sets the agent up, run on the server next to `.caelo/`. */
export function agentInstallCommand(version: string = CAELO_VERSION): string {
  return provisioningCommand(version, ["agent", "install"]);
}

/** Why the agent cannot take a request now, or null when it can. */
export function agentUnavailable(
  agent: PlatformUpdateAgentStatus | null,
): { readonly error: string; readonly nextStep: string } | null {
  if (!agent) {
    return {
      error: "The update agent is not set up on this server.",
      nextStep: `On the server, in the folder that holds .caelo/, run \`${agentInstallCommand()}\` — or install the update with the upgrade command shown on Settings → Updates.`,
    };
  }
  if (!agent.checkedInRecently) {
    return {
      error: `The update agent on ${agent.host} has not checked in since ${agent.lastSeenAt}.`,
      nextStep: `On the server, \`${provisioningCommand(CAELO_VERSION, ["agent", "status"])}\` shows why; \`${agentInstallCommand()}\` sets it up again.`,
    };
  }
  if (agent.problem) {
    return {
      error: `The update agent on ${agent.host} cannot install updates: ${agent.problem}`,
      nextStep: "Fix this on the server; the agent checks again within a minute.",
    };
  }
  return null;
}

/**
 * The trigger for a self-hosted install: `start` only confirms the agent
 * will pick the request up (the label it returns names the agent);
 * `latest` has no run to report — the agent writes its own timeline, and
 * ends a run that died when it next polls.
 */
export function agentUpgraderTrigger(
  readAgent: () => Promise<PlatformUpdateAgentStatus | null>,
): UpgraderTrigger {
  return {
    async start() {
      const agent = await readAgent();
      const unavailable = agentUnavailable(agent);
      if (unavailable) throw new UpgraderTriggerError(unavailable.error, unavailable.nextStep);
      return `agent@${agent?.host ?? "server"}`.slice(0, 200);
    },
    async latest() {
      return null;
    },
  };
}
