// SPDX-License-Identifier: MPL-2.0

import type { OperationRegistry } from "@caelo/query-api";
import { loginOp, logoutOp, resolveSessionOp } from "./ops/auth.js";
import {
  createModuleOp,
  deleteModuleOp,
  getModuleOp,
  listModulesOp,
  updateModuleOp,
} from "./ops/content/modules.js";
import {
  createPageOp,
  deletePageOp,
  getPageOp,
  getPageWithModulesOp,
  listPagesOp,
  setPageModulesOp,
  updatePageOp,
} from "./ops/content/pages.js";
import { renderPagePreviewOp } from "./ops/content/preview.js";
import { setTemplateBlocksOp } from "./ops/content/template_blocks.js";
import {
  createTemplateOp,
  deleteTemplateOp,
  getTemplateOp,
  listTemplatesOp,
  updateTemplateOp,
} from "./ops/content/templates.js";
import { createRoleOp, deleteRoleOp, listRolesOp, updateRolePermissionsOp } from "./ops/roles.js";
import {
  createFirstOwnerOp,
  createUserOp,
  deleteUserOp,
  isSetupCompleteOp,
  listUsersOp,
  setUserRolesOp,
} from "./ops/users.js";

export function registerAdminOps(registry: OperationRegistry): void {
  registry.register(createFirstOwnerOp);
  registry.register(isSetupCompleteOp);
  registry.register(listUsersOp);
  registry.register(createUserOp);
  registry.register(setUserRolesOp);
  registry.register(deleteUserOp);
  registry.register(loginOp);
  registry.register(logoutOp);
  registry.register(resolveSessionOp);
  registry.register(listRolesOp);
  registry.register(createRoleOp);
  registry.register(deleteRoleOp);
  registry.register(updateRolePermissionsOp);
  // P3 content layer
  registry.register(listModulesOp);
  registry.register(getModuleOp);
  registry.register(createModuleOp);
  registry.register(updateModuleOp);
  registry.register(deleteModuleOp);
  registry.register(listTemplatesOp);
  registry.register(getTemplateOp);
  registry.register(createTemplateOp);
  registry.register(updateTemplateOp);
  registry.register(deleteTemplateOp);
  registry.register(setTemplateBlocksOp);
  registry.register(listPagesOp);
  registry.register(getPageOp);
  registry.register(getPageWithModulesOp);
  registry.register(createPageOp);
  registry.register(updatePageOp);
  registry.register(setPageModulesOp);
  registry.register(deletePageOp);
  registry.register(renderPagePreviewOp);
}
