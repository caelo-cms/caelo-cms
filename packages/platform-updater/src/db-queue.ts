// SPDX-License-Identifier: MPL-2.0

/**
 * The update jobs' queues: the job ops (ops.ts) through the Query API, as a
 * system actor — {@link UpdateQueue} for the upgrader job (and the
 * self-hosted agent), {@link ConvergeQueue} for the converge job (#819). A
 * failed op throws — the job turns that into a failed request (or, for the
 * claim, a failed run) with the message.
 */

import type { AgentQueue, ConvergeQueue, UpdateQueue } from "@caelo-cms/provisioning";
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

/** The queue over `adapter` (connected as the platform_updater IAM user). */
export function createDbUpdateQueue(
  adapter: DatabaseAdapter,
  registry: OperationRegistry = upgraderRegistry(),
): UpdateQueue {
  return createDbAgentQueue(adapter, registry);
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
    async claimConverge(execution) {
      const r = await call<{ claimed: ClaimedRow | null }>("platform_updates.job_claim", {
        execution,
        route: "converge",
      });
      if (!r.claimed) return null;
      const { resume, execution: current, ...request } = r.claimed;
      return { request, resume, execution: current };
    },
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
