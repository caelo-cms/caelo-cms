// SPDX-License-Identifier: MPL-2.0

/**
 * The module HTML a tool call proposes, as `{ moduleId, html }` pairs —
 * what the chat's inline diff renders one card per.
 *
 * `update_modules_many` carries one pair per entry of `items`. The other
 * shapes are history: chats recorded before the tool merge hold
 * `edit_module` calls with a top-level `moduleId` + `html`, and
 * `update_modules_many` calls with the wrapper key `updates`. The server
 * still runs those through its alias table, so the transcript must keep
 * rendering them too.
 */

/** One module whose HTML a tool call replaces. */
export interface ModuleHtmlEdit {
  readonly moduleId: string;
  readonly html: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asEdit(v: unknown): ModuleHtmlEdit | null {
  if (!isRecord(v)) return null;
  const { moduleId, html } = v;
  return typeof moduleId === "string" && typeof html === "string" ? { moduleId, html } : null;
}

/**
 * The module HTML edits in a tool call's arguments; empty for a tool that
 * edits no module HTML, or an item without `html` (a CSS-only or rename
 * update has nothing to diff).
 *
 * @param toolName - the tool name the call was recorded under.
 * @param args - the call's arguments as recorded.
 */
export function moduleHtmlEdits(toolName: string, args: unknown): ModuleHtmlEdit[] {
  if (!isRecord(args)) return [];
  if (toolName === "update_modules_many") {
    const list = Array.isArray(args.items) ? args.items : args.updates;
    if (!Array.isArray(list)) return [];
    return list.map(asEdit).filter((e): e is ModuleHtmlEdit => e !== null);
  }
  if (toolName === "edit_module") {
    const edit = asEdit(args);
    return edit ? [edit] : [];
  }
  return [];
}
