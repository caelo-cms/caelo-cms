// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/platform-updater — the upgrader job's database side (epic
 * #696): its Query API ops and the queue that hands them to the
 * provisioning package's `runUpgraderJob`. The entry point is `main.ts`
 * (`caelo-ops upgrader` in the caelo-ops image).
 */

export { createDbUpdateQueue, upgraderRegistry } from "./db-queue.js";
export {
  jobClaimOp,
  jobEventOp,
  jobFinishOp,
  jobRecordOp,
  STALE_RUN_MINUTES,
} from "./ops.js";
