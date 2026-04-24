// SPDX-License-Identifier: MPL-2.0

export { type AdapterConfig, DatabaseAdapter } from "./adapter.js";
export { isRlsDenial, PG_INSUFFICIENT_PRIVILEGE, type QueryError } from "./errors.js";
export { execute } from "./execute.js";
export {
  defineOperation,
  type OperationDefinition,
  type OperationHandler,
  type TransactionRunner,
} from "./operation.js";
export { OperationRegistry } from "./registry.js";
