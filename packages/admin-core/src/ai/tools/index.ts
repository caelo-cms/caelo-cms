// SPDX-License-Identifier: MPL-2.0

import { addModuleToPageTool } from "./add-module-to-page.js";
import { addModuleToTemplateTool } from "./add-module-to-template.js";
import { ToolRegistry } from "./dispatch.js";
import { editModuleTool } from "./edit-module.js";
import { siteMemoryProposeTool } from "./site-memory-propose.js";

/**
 * Registers every shipped tool against a fresh ToolRegistry. Tests can
 * spin up their own registry with a subset; production uses this one.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(editModuleTool);
  registry.register(siteMemoryProposeTool);
  registry.register(addModuleToPageTool);
  registry.register(addModuleToTemplateTool);
  return registry;
}

export { type ToolContext, ToolRegistry, type ToolResult } from "./dispatch.js";
