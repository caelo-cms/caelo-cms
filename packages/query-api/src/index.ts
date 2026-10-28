// SPDX-License-Identifier: MPL-2.0

export {
  type AdapterConfig,
  AdminDatabaseUnavailableError,
  DatabaseAdapter,
  DatabaseUnresponsiveError,
  POOL_IDLE_TIMEOUT_SECONDS,
} from "./adapter.js";
export { recordAudit, recordAuditFromCtx, SYSTEM_ACTOR_ID } from "./audit.js";
export { assertChatOpenForWrite } from "./chat-write-guard.js";
export {
  isRlsDenial,
  OperationAbortError,
  PG_INSUFFICIENT_PRIVILEGE,
  type QueryError,
} from "./errors.js";
export { allowAllRateLimiter, type ExecuteOptions, execute, type RateLimiter } from "./execute.js";
export {
  defineOperation,
  type OperationDefinition,
  type OperationHandler,
  type TransactionRunner,
} from "./operation.js";
export {
  afterCommit,
  type CommittedOperationListener,
  observeCommittedOperations,
  type PostCommitEffect,
} from "./post-commit.js";
export { OperationRegistry } from "./registry.js";
