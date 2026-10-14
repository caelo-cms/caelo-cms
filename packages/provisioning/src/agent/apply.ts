// SPDX-License-Identifier: MPL-2.0

/**
 * `agent apply` — the target release's half of a self-hosted update (#696
 * Phase 4c). The polling agent (agent/run.ts) claimed the request, verified
 * the release's signed manifest and ran the refusal checks; it then starts
 * THIS release's CLI, which performs the upgrade exactly like a hand-run
 * `cms-provision upgrade` (self-hosted-upgrade.ts: verified digests, pg_dump
 * backup, pull, migrations with the new admin image, health-checked roll,
 * rollback) — narrated into the request's timeline — records how it ended,
 * and re-pins the agent's systemd service to this release.
 *
 * It is never started by hand: it acts on a request the parent already
 * claimed and holds the install's upgrade lock for.
 */

import type { PlatformUpdateTrigger } from "@caelo-cms/shared";
import type { SelfHostedUpgradeResult, UpgradeLog } from "../self-hosted-upgrade.js";
import { recordUpdateEnd, type UpdateEnd, type UpdateQueue } from "../upgrader-job.js";
import { eventReporter, type JobLog } from "../upgrader-reporter.js";

export interface AgentApplyDeps {
  readonly queue: UpdateQueue;
  readonly request: {
    readonly id: string;
    readonly targetVersion: string;
    readonly trigger: PlatformUpdateTrigger;
  };
  /** This CLI's own release; must be the target. */
  readonly agentVersion: string;
  /** upgradeSelfHosted for the target, with the manifest's digests. */
  readonly upgrade: (log: UpgradeLog) => Promise<SelfHostedUpgradeResult>;
  /** Re-pin the agent's service to this release (agent/systemd.ts). */
  readonly selfUpdate: () => Promise<{ ok: true } | { ok: false; error: string }>;
  readonly log: JobLog;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The request's end state for an upgrade result. */
export function endForResult(
  result: SelfHostedUpgradeResult,
  trigger: PlatformUpdateTrigger,
): UpdateEnd {
  if (result.ok) return { status: "succeeded", reason: null, codes: [], pauseAutoUpdates: false };
  const rolled = result.stage === "roll-admin" || result.stage === "roll-gateway";
  const status = rolled && result.previousRunning ? "rolled_back" : "failed";
  const lead =
    status === "rolled_back"
      ? "The new release did not pass its health check, so the previous release serves again."
      : result.previousRunning
        ? "Nothing was changed; the previous release keeps serving."
        : "The update stopped half-way and the previous release did not come back healthy — check `docker compose ps` on the server.";
  return {
    status,
    reason: `${lead}\n${result.error}`.slice(0, 4000),
    codes: [rolled && !result.previousRunning ? "rollback" : result.stage],
    pauseAutoUpdates: trigger === "auto",
  };
}

/** Run the upgrade for the claimed request. Never throws. */
export async function applyAgentUpdate(deps: AgentApplyDeps): Promise<{ exitCode: number }> {
  const { queue, request, log } = deps;
  const r = eventReporter(
    (phase, level, message) => queue.event(request.id, phase, level, message),
    log,
    request.id,
  );
  const finish = async (end: UpdateEnd): Promise<{ exitCode: number }> => {
    r.phase("finish");
    if (end.status === "succeeded") r.success(`Caelo ${request.targetVersion} is installed.`);
    else r.error(end.reason ?? end.status);
    await r.flush();
    const recorded = await recordUpdateEnd(queue, request.id, end, log, deps.sleep);
    return { exitCode: recorded && end.status === "succeeded" ? 0 : 1 };
  };

  if (deps.agentVersion !== request.targetVersion) {
    return finish({
      status: "failed",
      reason: `Nothing was changed: the installer of Caelo ${deps.agentVersion} was started for ${request.targetVersion}.`,
      codes: ["apply"],
      pauseAutoUpdates: request.trigger === "auto",
    });
  }
  let result: SelfHostedUpgradeResult;
  try {
    r.phase("start");
    r.info(`The Caelo ${request.targetVersion} installer took over.`);
    result = await deps.upgrade({
      step: (m) => {
        r.step(m);
      },
      info: (m) => r.info(m),
      warn: (m) => r.warn(m),
      error: (m) => r.error(m),
      phase: (p) => r.phase(p),
    });
  } catch (e) {
    return finish({
      status: "failed",
      reason: `The installer stopped unexpectedly: ${e instanceof Error ? e.message : String(e)}. Check \`docker compose ps\` on the server.`,
      codes: ["internal"],
      pauseAutoUpdates: request.trigger === "auto",
    });
  }
  if (result.ok) {
    if (result.status === "already-current") {
      r.info(`Caelo ${result.version} was already installed; the containers are healthy.`);
    }
    r.phase("self-update");
    const pinned = await deps.selfUpdate().catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (pinned.ok) r.info(`The update agent itself now runs ${request.targetVersion}.`);
    else {
      r.warn(
        `The update agent could not update itself (${pinned.error}); it keeps working with its current version.`,
      );
    }
  }
  return finish(endForResult(result, request.trigger));
}
