// SPDX-License-Identifier: MPL-2.0

import type { OperationRegistry } from "@caelo/query-api";
import { loginOp, logoutOp, resolveSessionOp } from "./ops/auth.js";
import { createRoleOp, deleteRoleOp, listRolesOp, updateRolePermissionsOp } from "./ops/roles.js";
import { createFirstOwnerOp, isSetupCompleteOp } from "./ops/users.js";

/**
 * Registers the full set of P2 admin operations into a shared registry.
 * The SvelteKit admin app calls this once on server startup; tests call it
 * inside their `beforeAll` so the integration suite runs against the same
 * operation definitions the app ships.
 */
export function registerAdminOps(registry: OperationRegistry): void {
  registry.register(createFirstOwnerOp);
  registry.register(isSetupCompleteOp);
  registry.register(loginOp);
  registry.register(logoutOp);
  registry.register(resolveSessionOp);
  registry.register(listRolesOp);
  registry.register(createRoleOp);
  registry.register(deleteRoleOp);
  registry.register(updateRolePermissionsOp);
}
