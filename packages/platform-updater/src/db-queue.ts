// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job's {@link UpdateQueue}: the four job ops (ops.ts) through
 * the Query API, as a system actor. A failed op throws — the job turns that
 * into a failed request (or, for the claim, a failed run) with the message.
 */

import type { UpdateQueue } from "@caelo-cms/provisioning";
import {
  type DatabaseAdapter,
  execute,
  OperationRegistry,
  SYSTEM_ACTOR_ID,
} from "@caelo-cms/query-api";
import type { ExecutionContext, StoredUpdatePolicy } from "@caelo-cms/shared";
import { jobClaimOp, jobEventOp, jobFinishOp, jobRecordOp } from "./ops.js";

/** A registry holding exactly the job's ops. */
export function upgraderRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  registry.register(jobClaimOp);
  registry.register(jobEventOp);
  registry.register(jobRecordOp);
  registry.register(jobFinishOp);
  return registry;
}

/** The queue over `adapter` (connected as the platform_updater IAM user). */
export function createDbUpdateQueue(
  adapter: DatabaseAdapter,
  registry: OperationRegistry = upgraderRegistry(),
): UpdateQueue {
  let n = 0;
  const ctx = (): ExecutionContext => ({
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system",
    requestId: `upgrader-job-${Date.now()}-${n++}`,
  });
  const call = async <T>(op: string, input: unknown): Promise<T> => {
    const r = await execute(registry, adapter, ctx(), op, input);
    if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
    return r.value as T;
  };
  return {
    async claim(execution) {
      const r = await call<{
        claimed: {
          id: string;
          targetVersion: string;
          trigger: "manual" | "auto";
          policy: StoredUpdatePolicy;
        } | null;
      }>("platform_updates.job_claim", { execution });
      return r.claimed;
    },
    async event(requestId, phase, level, message) {
      await call("platform_updates.job_event", { requestId, phase, level, message });
    },
    async record(requestId, facts) {
      await call("platform_updates.job_record", { requestId, facts });
    },
    async finish(requestId, end) {
      await call("platform_updates.job_finish", {
        requestId,
        status: end.status,
        reason: end.reason,
        codes: [...end.codes],
        pauseAutoUpdates: end.pauseAutoUpdates,
      });
    },
  };
}
