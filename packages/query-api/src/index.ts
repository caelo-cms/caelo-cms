// SPDX-License-Identifier: MPL-2.0

/**
 * #1254 — the install's connection budget. It lives in `@caelo-cms/shared`
 * because the provisioning stacks (published, Node-run) compute it too; the
 * adapter here consumes the env it produces.
 */
export {
  ADMIN_POOL_FLOOR,
  ADMIN_PUBLIC_POOL_MAX,
  computePoolBudget,
  DB_POOL_MAX_ENV,
  DB_PUBLIC_POOL_MAX_ENV,
  GATEWAY_POOL_MAX,
  GENERATOR_POOL_MAX,
  LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE,
  type PoolBudget,
  type PoolBudgetInput,
  type PoolBudgetReserve,
  type PoolBudgetReserveName,
  poolBudgetEnv,
} from "@caelo-cms/shared";
export {
  type AdapterConfig,
  AdminDatabaseUnavailableError,
  DatabaseAdapter,
  type DatabaseTlsOptions,
  DatabaseUnresponsiveError,
  LISTEN_CONNECTIONS_PER_INSTANCE,
  type ListenCallbacks,
  type ListenHandle,
  type PluginSchemaProvisionOutcome,
  POOL_IDLE_TIMEOUT_SECONDS,
  type PublicDatabaseName,
  type TransactionOptions,
  thrownToQueryError,
} from "./adapter.js";
export { recordAudit, recordAuditFromCtx, SYSTEM_ACTOR_ID } from "./audit.js";
/** #1392 — one branch-visibility memory per HTTP request (the admin opens it). */
export { withBranchVisibilityScope } from "./branch-access.js";
export {
  beginConsumerRebuild,
  type ChangeBatch,
  checkJournalMark,
  claimConsumer,
  collectJournalGarbage,
  commitChanges,
  commitChangesIfCurrent,
  consumerClaimExpiresInMs,
  consumerCursorContinuous,
  consumerRebuildPending,
  currentJournalCursor,
  dropConsumers,
  finishConsumerRebuild,
  finishConsumerRebuildIfHeld,
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
  snapshotFollows,
  textArray,
  uuidArray,
} from "./change-journal.js";
export { assertChatOpenForWrite } from "./chat-write-guard.js";
export {
  classifyDatabaseTrouble,
  type DatabaseTrouble,
  type DatabaseTroubleKind,
  type DatabaseTroubleListener,
} from "./database-trouble.js";
export {
  type ErrorDetail,
  type ErrorPathSegment,
  errorDetailsOf,
  type FailureKind,
  failureKindOf,
  formatErrorDetail,
  formatErrorDetails,
  formatErrorPath,
  handlerErrorFromDetails,
  internalError,
  MAX_RENDERED_ERRORS,
  parseErrorPath,
  prefixErrorDetails,
  trimTrailingPunctuation,
  zodIssuesToErrorDetails,
} from "./error-details.js";
export {
  extractPgFields,
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
  describePgFailure,
  type PgFailureDescription,
  type PgFailureFields,
  rlsDenialMessage,
} from "./pg-failure.js";
export {
  joinHeldTransaction,
  LONG_TRANSACTION_ALLOWLIST,
  NestedPoolCheckoutError,
  POOL_ACQUIRE_TIMEOUT_MS,
  POOL_BUSY_RETRY_AFTER_MS,
  PoolAcquireTimeoutError,
  type PoolName,
} from "./pool-guard.js";
export {
  BUN_DEFAULT_POOL_MAX,
  type PoolHolding,
  type PoolPressure,
} from "./pool-pressure.js";
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
