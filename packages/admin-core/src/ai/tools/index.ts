// SPDX-License-Identifier: MPL-2.0

import { addModuleToPageTool } from "./add-module-to-page.js";
import { addModuleToTemplateTool } from "./add-module-to-template.js";
import { changePageSlugTool } from "./change-page-slug.js";
import { createPageTool } from "./create-page.js";
import { deletePageTool } from "./delete-page.js";
import { ToolRegistry } from "./dispatch.js";
import { editModuleTool } from "./edit-module.js";
import { removeModuleFromPageTool } from "./remove-module-from-page.js";
import { renamePageTool } from "./rename-page.js";
import { setPageTitleTool } from "./set-page-title.js";
import { setStructuredSetTool } from "./set-structured-set.js";
import { siteMemoryProposeTool } from "./site-memory-propose.js";
import { updateThemeTool } from "./update-theme.js";

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
  registry.register(createPageTool);
  registry.register(renamePageTool);
  registry.register(setPageTitleTool);
  registry.register(changePageSlugTool);
  registry.register(deletePageTool);
  registry.register(removeModuleFromPageTool);
  registry.register(setStructuredSetTool);
  registry.register(updateThemeTool);
  return registry;
}

export { type ToolContext, ToolRegistry, type ToolResult } from "./dispatch.js";
