// SPDX-License-Identifier: MPL-2.0

export {
  type AdapterConfig,
  AdminDatabaseUnavailableError,
  DatabaseAdapter,
  DatabaseUnresponsiveError,
  LISTEN_CONNECTIONS_PER_INSTANCE,
  type ListenCallbacks,
  type ListenHandle,
  POOL_IDLE_TIMEOUT_SECONDS,
  type TransactionOptions,
} from "./adapter.js";
export { recordAudit, recordAuditFromCtx, SYSTEM_ACTOR_ID } from "./audit.js";
export {
  beginConsumerRebuild,
  type ChangeBatch,
  checkJournalMark,
  claimConsumer,
  collectJournalGarbage,
  commitChanges,
  consumerClaimExpiresInMs,
  consumerCursorContinuous,
  consumerRebuildPending,
  currentJournalCursor,
  dropConsumers,
  finishConsumerRebuild,
  JOURNAL_RETENTION_MS,
  JOURNAL_STALLED_CONSUMER_MS,
  type JournalChange,
  type JournalCheck,
  type JournalFilter,
  type JournalMark,
  pollChanges,
  readChanges,
  registerConsumer,
  releaseConsumer,
  textArray,
  uuidArray,
} from "./change-journal.js";
export { assertChatOpenForWrite } from "./chat-write-guard.js";
export {
  isRlsDenial,
  OperationAbortError,
  PG_INSUFFICIENT_PRIVILEGE,
  type QueryError,
} from "./errors.js";
export { allowAllRateLimiter, type ExecuteOptions, execute, type RateLimiter } from "./execute.js";
export {
  type AnyOperationDefinition,
  defineOperation,
  defineReadOperation,
  defineStepwiseOperation,
  isReadOperation,
  type OperationDefinition,
  type OperationHandler,
  type OperationReadScope,
  type OperationSteps,
  type ReadOperationDefinition,
  type ReadOperationHandler,
  type ReadScope,
  type StepwiseOperationHandler,
  type TransactionRunner,
} from "./operation.js";
export {
  allowNestedCheckouts,
  LONG_TRANSACTION_ALLOWLIST,
  NESTED_CHECKOUT_ALLOWLIST,
  NestedPoolCheckoutError,
  POOL_ACQUIRE_TIMEOUT_MS,
  PoolAcquireTimeoutError,
} from "./pool-guard.js";
export {
  afterCommit,
  type CommitNotice,
  type CommitNoticeSource,
  type CommittedOperationListener,
  observeCommittedOperations,
  type PostCommitEffect,
  setCommitNotice,
} from "./post-commit.js";
export { OperationRegistry } from "./registry.js";
