// SPDX-License-Identifier: MPL-2.0

import { isUntrustedToolResult } from "@caelo-cms/shared";

/** Which card renders a tool result in the chat. */
export type ToolCardKind =
  | "error"
  | "untrusted"
  | "propose"
  | "choices"
  | "design-variants"
  | "edit-module"
  | "edit-content"
  | "screenshot"
  | "bulk"
  | "find"
  | "generic";

const SCREENSHOT_TOOLS = new Set([
  "screenshot_page",
  "screenshot_external_page",
  "get_import_page_screenshot",
  "inspect_external_page",
]);

const BULK_TOOLS = new Set([
  "bulk_create_redirects",
  "bulk_delete_redirects",
  "bulk_optimize_seo",
  "delete_pages_many",
  "update_pages_many",
  "update_modules_many",
]);

const FIND_TOOLS = new Set(["find_media", "find_redirects"]);

/**
 * Pick the card for a tool result. The routing is by tool name, and a
 * plugin chooses its tools' names — so a plugin result (#635: possibly
 * visitor-written) is recognised by its content FIRST and always gets the
 * plain-text card, whatever its tool is called. Otherwise a plugin tool
 * named `propose_*` or `edit_content` would put visitor text through a
 * card that renders markdown or offers Approve buttons.
 */
export function toolCardKind(name: string, content: string, ok: boolean): ToolCardKind {
  if (!ok) return "error";
  if (isUntrustedToolResult(content)) return "untrusted";
  // Every propose-style tool emits "Queued proposal <uuid>: …" (v0.5.11);
  // the prefix check covers propose tools whose result predates that.
  if (name.startsWith("propose_") || /^Queued proposal [0-9a-f-]{36}:/.test(content)) {
    return "propose";
  }
  if (name === "offer_choices") return "choices";
  if (name === "present_design_variants") return "design-variants";
  // edit_module is retired (update_modules_many, a bulk tool, replaced
  // it); older chats still hold its results, so the card stays for them.
  if (name === "edit_module") return "edit-module";
  if (name === "edit_content") return "edit-content";
  if (SCREENSHOT_TOOLS.has(name)) return "screenshot";
  if (BULK_TOOLS.has(name)) return "bulk";
  if (FIND_TOOLS.has(name)) return "find";
  return "generic";
}
