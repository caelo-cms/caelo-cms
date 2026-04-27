// SPDX-License-Identifier: MPL-2.0

import { addModuleToLayoutTool } from "./add-module-to-layout.js";
import { addModuleToPageTool } from "./add-module-to-page.js";
import { addModuleToTemplateTool } from "./add-module-to-template.js";
import { changePageSlugTool } from "./change-page-slug.js";
import { createLayoutTool } from "./create-layout.js";
import { createPageTool } from "./create-page.js";
import { deletePageTool } from "./delete-page.js";
import { ToolRegistry } from "./dispatch.js";
import { editModuleTool } from "./edit-module.js";
import { removeModuleFromLayoutTool } from "./remove-module-from-layout.js";
import { removeModuleFromPageTool } from "./remove-module-from-page.js";
import { renamePageTool } from "./rename-page.js";
import { setPageTitleTool } from "./set-page-title.js";
import { setSiteDefaultsTool } from "./set-site-defaults.js";
import { setStructuredSetTool } from "./set-structured-set.js";
import { setTemplateLayoutTool } from "./set-template-layout.js";
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
  // P6.7.6 — layout layer.
  registry.register(addModuleToLayoutTool);
  registry.register(removeModuleFromLayoutTool);
  registry.register(setTemplateLayoutTool);
  registry.register(createLayoutTool);
  registry.register(setSiteDefaultsTool);
  return registry;
}

export { type ToolContext, ToolRegistry, type ToolResult } from "./dispatch.js";
