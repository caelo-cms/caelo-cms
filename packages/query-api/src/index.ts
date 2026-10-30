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
  DatabaseUnresponsiveError,
  POOL_IDLE_TIMEOUT_SECONDS,
  type TransactionOptions,
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
  joinHeldTransaction,
  LONG_TRANSACTION_ALLOWLIST,
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
