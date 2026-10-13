// SPDX-License-Identifier: MPL-2.0

/**
 * One poll of the self-hosted host agent (#696 Phase 4c) — what the
 * `caelo-agent-<domain>` timer runs every minute:
 *
 *   1. preflight (Docker reachable, cosign present, a recorded release) and
 *      a heartbeat with the result, so Settings → Updates knows the agent is
 *      alive and what would stop an install before the Owner clicks;
 *   2. claim the oldest pending request (ending a run that died mid-way) —
 *      the admin only ever writes the request row;
 *   3. verify the target's signed release manifest (cosign, fixed registry
 *      and signer — nothing from the request but the version) and decide
 *      with the upgrader's own refusal matrix (upgrader-assess.ts): bad
 *      signature, downgrade, below minFromVersion, contract migrations or a
 *      policy refusal on an automatic run. Self-hosted has no separately
 *      converged infrastructure, so the infra-contract row never applies;
 *   4. only then run the TARGET release's own CLI (`bun x
 *      @caelo-cms/provisioning@<target> agent apply`, agent/apply.ts), which
 *      performs the same backup → pull → migrate → roll → health → rollback
 *      as a hand-run `upgrade` and narrates it into the request's timeline.
 *      The target's CLI renders the target's Compose file, so a release that
 *      changes the stack needs no extra step. No code of the target runs
 *      before its manifest verified and passed the checks above;
 *   5. if that process ended without recording an end state, end the
 *      request as failed with its output.
 *
 * The install's upgrade lock is held for the whole run, so a hand-run
 * `upgrade` and the agent never roll at the same time.
 */

import { PLATFORM_UPDATE_AGENT_POLL_SECONDS, type PlatformUpdateTrigger } from "@caelo-cms/shared";
import type { ReleaseManifest, ReleaseManifestResult } from "../release-manifest.js";
import type { SelfHostedRelease } from "../self-hosted-release.js";
import { assessUpgradeRequest } from "../upgrader-assess.js";
import type { UpdateEnd, UpdateEndStatus } from "../upgrader-job.js";
import { recordUpdateEnd } from "../upgrader-job.js";
import { eventReporter, type JobLog } from "../upgrader-reporter.js";
import type { AgentQueue } from "./queue.js";

/** What the target release's `agent apply` is told (argv of the child). */
export interface AgentApplyRequest {
  readonly requestId: string;
  readonly targetVersion: string;
  readonly trigger: PlatformUpdateTrigger;
  /** From the verified manifest: the images the target must resolve to. */
  readonly digests: { readonly admin: string; readonly gateway: string };
}

/** How the target's `agent apply` process ended. */
export interface AgentApplyOutcome {
  readonly exitCode: number;
  /** The tail of its output, for the timeline when it recorded nothing. */
  readonly output: string;
}

export interface AgentRunDeps {
  readonly queue: AgentQueue;
  /** This agent's own release (CAELO_VERSION). */
  readonly agentVersion: string;
  readonly host: string;
  /** Why an install would fail on this host now, or null. */
  readonly preflight: () => Promise<string | null>;
  /** `.caelo/release.json` (null when none is recorded; throws when malformed). */
  readonly readInstalled: () => SelfHostedRelease | null;
  /** fetchVerifiedReleaseManifest against the fixed registry. */
  readonly fetchManifest: (version: string) => Promise<ReleaseManifestResult>;
  /** Take the install's upgrade lock (agent/lock.ts); throws when held. */
  readonly lock: () => () => void;
  /** Run the target release's `agent apply` and wait for it. */
  readonly applyTarget: (request: AgentApplyRequest) => Promise<AgentApplyOutcome>;
  readonly now: () => Date;
  readonly log: JobLog;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * How often the agent keeps checking in while the target's CLI runs (an
   * update takes minutes; the admin would otherwise think the agent gone).
   * Default: every poll interval.
   */
  readonly heartbeatEveryMs?: number;
}

/** What one poll did. */
export interface AgentRunResult {
  readonly exitCode: number;
  readonly requestId: string | null;
  /** The end the agent itself recorded (null when the target's CLI did, or nothing ran). */
  readonly status: UpdateEndStatus | null;
}

/** One poll. Never throws; see the file comment for the sequence. */
export async function runAgentOnce(deps: AgentRunDeps): Promise<AgentRunResult> {
  const { queue, log } = deps;
  const problem = await deps.preflight().catch((e: unknown) => `preflight failed: ${errorText(e)}`);
  try {
    await queue.heartbeat({ agentVersion: deps.agentVersion, host: deps.host, problem });
  } catch (e) {
    log({ severity: "ERROR", message: `could not check in with the database: ${errorText(e)}` });
    return { exitCode: 1, requestId: null, status: null };
  }

  let claimed: Awaited<ReturnType<AgentQueue["claim"]>>;
  try {
    claimed = await queue.claim(`agent@${deps.host}`.slice(0, 200));
  } catch (e) {
    log({ severity: "ERROR", message: `could not read update requests: ${errorText(e)}` });
    return { exitCode: 1, requestId: null, status: null };
  }
  if (!claimed) return { exitCode: 0, requestId: null, status: null };
  const request = claimed;
  const r = eventReporter(
    (phase, level, message) => queue.event(request.id, phase, level, message),
    log,
    request.id,
  );
  let release: (() => void) | null = null;
  const unlock = () => {
    try {
      release?.();
    } catch (e) {
      log({ severity: "WARNING", message: `could not release the upgrade lock: ${errorText(e)}` });
    }
    release = null;
  };
  const stopWith = async (
    status: UpdateEndStatus,
    codes: readonly string[],
    reason: string,
  ): Promise<AgentRunResult> => {
    r.phase("finish");
    r.error(reason);
    await r.flush();
    unlock();
    const end: UpdateEnd = {
      status,
      reason,
      codes,
      pauseAutoUpdates:
        request.trigger === "auto" && (status === "failed" || status === "rolled_back"),
    };
    const recorded = await recordUpdateEnd(queue, request.id, end, log, deps.sleep);
    const failed = status === "failed" || !recorded;
    return { exitCode: failed ? 1 : 0, requestId: request.id, status };
  };

  try {
    r.phase("start");
    r.info(
      `The update agent on ${deps.host} (Caelo ${deps.agentVersion}) picked up the request to install Caelo ${request.targetVersion}.`,
    );
    if (problem) {
      return await stopWith(
        "failed",
        ["preflight"],
        `Nothing was changed: ${problem} Fix this on the server, then try again.`,
      );
    }
    try {
      release = deps.lock();
    } catch (e) {
      return await stopWith(
        "failed",
        ["state-locked"],
        `Nothing was changed: ${errorText(e)} Try again when it has finished.`,
      );
    }

    r.phase("verify");
    let installed: SelfHostedRelease | null;
    try {
      installed = deps.readInstalled();
    } catch (e) {
      return await stopWith("failed", ["install-state"], `Nothing was changed: ${errorText(e)}`);
    }
    const manifest = await deps.fetchManifest(request.targetVersion);
    const decision = assessUpgradeRequest({
      request,
      manifest,
      installed: { version: installed?.version ?? null, infraContractVersion: null },
      policy: request.policy,
      now: deps.now(),
      manualPath: "server",
    });
    if (decision.manifest) {
      r.success(
        `Release information of ${decision.manifest.version} verified: signed by Caelo's release workflow.`,
      );
      await recordFacts(queue, request.id, decision.manifest);
    }
    r.phase("assess");
    if (decision.kind === "stop") {
      return await stopWith(decision.status, decision.codes, decision.reason);
    }
    for (const w of decision.warnings) r.warn(w);
    const m = decision.manifest;
    r.info(
      `${installed?.version} → ${m.version}: handing over to the Caelo ${m.version} installer on this server.`,
    );
    await r.flush();

    const beat = setInterval(
      () => {
        queue
          .heartbeat({ agentVersion: deps.agentVersion, host: deps.host, problem: null })
          .catch((e: unknown) => {
            log({ severity: "WARNING", message: `could not check in: ${errorText(e)}` });
          });
      },
      deps.heartbeatEveryMs ?? PLATFORM_UPDATE_AGENT_POLL_SECONDS * 1000,
    );
    let outcome: AgentApplyOutcome;
    try {
      outcome = await deps.applyTarget({
        requestId: request.id,
        targetVersion: m.version,
        trigger: request.trigger,
        digests: { admin: m.digests.admin, gateway: m.digests.gateway },
      });
    } finally {
      clearInterval(beat);
    }
    unlock();
    if (outcome.exitCode === 0) return { exitCode: 0, requestId: request.id, status: null };
    // The target's CLI ends the request itself; only if it could not (it
    // never started, or crashed) is the request still running here.
    const reason = `The Caelo ${m.version} installer stopped (exit ${outcome.exitCode}) before it recorded how the update ended. If the site misbehaves, check \`docker compose ps\` on the server.${outcome.output ? `\n${outcome.output}` : ""}`;
    const end: UpdateEnd = {
      status: "failed",
      reason: reason.slice(0, 4000),
      codes: ["apply"],
      pauseAutoUpdates: request.trigger === "auto",
    };
    let ended = false;
    try {
      ended = await queue.finish(request.id, end);
    } catch (e) {
      log({ severity: "ERROR", message: `could not end request ${request.id}: ${errorText(e)}` });
      return { exitCode: 1, requestId: request.id, status: null };
    }
    if (!ended) return { exitCode: 1, requestId: request.id, status: null };
    r.phase("finish");
    r.error(reason);
    await r.flush();
    return { exitCode: 1, requestId: request.id, status: "failed" };
  } catch (e) {
    return await stopWith(
      "failed",
      ["internal"],
      `The update agent stopped unexpectedly: ${errorText(e)}. If the site misbehaves, check \`docker compose ps\` on the server.`,
    );
  }
}

async function recordFacts(queue: AgentQueue, requestId: string, m: ReleaseManifest) {
  await queue.record(requestId, {
    manifestSecurity: m.security,
    contractMigrations: m.migrations.contract,
    adminDigest: m.digests.admin,
    gatewayDigest: m.digests.gateway,
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
