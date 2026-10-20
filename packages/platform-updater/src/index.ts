// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/platform-updater — the upgrader job's database side (epic
 * #696): its Query API ops and the queue that hands them to the
 * provisioning package's `runUpgraderJob`. The entry point is `main.ts`
 * (`caelo-ops upgrader` in the caelo-ops image).
 */

export { openAgentQueue } from "./agent-db.js";
export {
  createDbAgentQueue,
  createDbConvergeQueue,
  createDbUpdateQueue,
  upgraderRegistry,
} from "./db-queue.js";
export {
  agentHeartbeatOp,
  jobClaimOp,
  jobEventOp,
  jobFinishOp,
  jobHandoverOp,
  jobRecordOp,
} from "./ops.js";
