// SPDX-License-Identifier: MPL-2.0

/**
 * The update jobs' queues: the job ops (ops.ts) through the Query API, as a
 * system actor — {@link UpgraderQueue} for the upgrader job (#1029),
 * {@link ConvergeQueue} for the converge job (#819), {@link AgentQueue} for
 * the self-hosted agent. A
 * failed op throws — the job turns that into a failed request (or, for the
 * claim, a failed run) with the message.
 */

import type { AgentQueue, ConvergeQueue, JobClaim, UpgraderQueue } from "@caelo-cms/provisioning";
import {
  type DatabaseAdapter,
  execute,
  OperationRegistry,
  SYSTEM_ACTOR_ID,
} from "@caelo-cms/query-api";
import type { AutoUpdateBasis, ExecutionContext, StoredUpdatePolicy } from "@caelo-cms/shared";
import {
  agentHeartbeatOp,
  jobClaimOp,
  jobEventOp,
  jobFinishOp,
  jobHandoverOp,
  jobRecordOp,
} from "./ops.js";

/** A registry holding exactly the job's ops. */
export function upgraderRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  registry.register(jobClaimOp);
  registry.register(jobEventOp);
  registry.register(jobRecordOp);
  registry.register(jobFinishOp);
  registry.register(jobHandoverOp);
  registry.register(agentHeartbeatOp);
  return registry;
}

/**
 * The upgrader job's queue over `adapter` (connected as the platform_updater
 * IAM user): claims `app_roll` requests, or the one still running to
 * continue it (#1029); events, facts and the end as the agent's.
 */
export function createDbUpdateQueue(
  adapter: DatabaseAdapter,
  registry: OperationRegistry = upgraderRegistry(),
): UpgraderQueue {
  const { claimConverge: _converge, ...shared } = createDbConvergeQueue(adapter, registry);
  const claim = adoptingClaim(adapter, registry, "app_roll");
  return { ...shared, claimUpgrade: claim };
}

/** The claimed request as `platform_updates.job_claim` returns it. */
interface ClaimedRow {
  id: string;
  targetVersion: string;
  trigger: "manual" | "auto";
  autoBasis: AutoUpdateBasis | null;
  policy: StoredUpdatePolicy;
  resume: boolean;
  execution: string | null;
}

/** A Query API caller for the job ops, as a system actor. */
function opCaller(adapter: DatabaseAdapter, registry: OperationRegistry) {
  let n = 0;
  const ctx = (): ExecutionContext => ({
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system",
    requestId: `upgrader-job-${Date.now()}-${n++}`,
  });
  return async <T>(op: string, input: unknown): Promise<T> => {
    const r = await execute(registry, adapter, ctx(), op, input);
    if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
    return r.value as T;
  };
}

/** A job's claim that returns its route's running request instead of a new one. */
function adoptingClaim(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
  route: "app_roll" | "converge",
): (execution: string | null) => Promise<JobClaim | null> {
  const call = opCaller(adapter, registry);
  return async (execution) => {
    const r = await call<{ claimed: ClaimedRow | null }>("platform_updates.job_claim", {
      execution,
      route,
      adopt: true,
    });
    if (!r.claimed) return null;
    const { resume, execution: current, ...request } = r.claimed;
    return { request, resume, execution: current };
  };
}

/**
 * The converge job's queue (#819): claims `converge` requests (or the one
 * still running, to continue it) and hands a running request over to the
 * execution that continues it; events, facts and the end as the upgrader's.
 */
export function createDbConvergeQueue(
  adapter: DatabaseAdapter,
  registry: OperationRegistry = upgraderRegistry(),
): ConvergeQueue {
  const call = opCaller(adapter, registry);
  const {
    claim: _appRollClaim,
    heartbeat: _heartbeat,
    ...shared
  } = createDbAgentQueue(adapter, registry);
  return {
    ...shared,
    claimConverge: adoptingClaim(adapter, registry, "converge"),
    async handover(requestId, from, to) {
      const r = await call<{ handedOver: boolean }>("platform_updates.job_handover", {
        requestId,
        from,
        to,
      });
      return r.handedOver;
    },
  };
}

/**
 * The self-hosted host agent's queue (#696 Phase 4c): the job's queue plus
 * the heartbeat, over `adapter` connected as `caelo_agent` (a member of
 * platform_updater).
 */
export function createDbAgentQueue(
  adapter: DatabaseAdapter,
  registry: OperationRegistry = upgraderRegistry(),
): AgentQueue {
  const call = opCaller(adapter, registry);
  return {
    async claim(execution) {
      const r = await call<{ claimed: ClaimedRow | null }>("platform_updates.job_claim", {
        execution,
        route: "app_roll",
      });
      if (!r.claimed) return null;
      const { resume: _resume, execution: _execution, ...request } = r.claimed;
      return request;
    },
    async event(requestId, phase, level, message) {
      await call("platform_updates.job_event", { requestId, phase, level, message });
    },
    async record(requestId, facts) {
      await call("platform_updates.job_record", { requestId, facts });
    },
    async finish(requestId, end) {
      const r = await call<{ finished: boolean }>("platform_updates.job_finish", {
        requestId,
        status: end.status,
        reason: end.reason,
        codes: [...end.codes],
        pauseAutoUpdates: end.pauseAutoUpdates,
      });
      return r.finished;
    },
    async heartbeat(beat) {
      await call("platform_updates.agent_heartbeat", {
        agentVersion: beat.agentVersion,
        host: beat.host,
        problem: beat.problem,
      });
    },
  };
}
