// SPDX-License-Identifier: MPL-2.0

export {
  type AdapterConfig,
  AdminDatabaseUnavailableError,
  DatabaseAdapter,
  DatabaseUnresponsiveError,
  POOL_IDLE_TIMEOUT_SECONDS,
  type TransactionOptions,
  thrownToQueryError,
} from "./adapter.js";
export { recordAudit, recordAuditFromCtx, SYSTEM_ACTOR_ID } from "./audit.js";
export { assertChatOpenForWrite } from "./chat-write-guard.js";
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
  allowNestedCheckouts,
  LONG_TRANSACTION_ALLOWLIST,
  NESTED_CHECKOUT_ALLOWLIST,
  NestedPoolCheckoutError,
  POOL_ACQUIRE_TIMEOUT_MS,
  PoolAcquireTimeoutError,
} from "./pool-guard.js";
export {
  afterCommit,
  type CommittedOperationListener,
  observeCommittedOperations,
  type PostCommitEffect,
} from "./post-commit.js";
export { OperationRegistry } from "./registry.js";
