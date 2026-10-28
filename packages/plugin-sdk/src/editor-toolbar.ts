// SPDX-License-Identifier: MPL-2.0

/**
 * Editor toolbar items: the place a plugin claims in the live editor's top
 * bar, next to the page address.
 *
 * Like admin panels (`./admin-panels.ts`), an item is DATA, never UI code:
 * the admin renders every item with one generic button + popover, so a
 * shipped plugin and a runtime-installed one look and behave the same
 * (one plugin model, CLAUDE.md §2), the item exists only while its plugin
 * runs, and no plugin code ever runs in the operator's browser.
 *
 * The declaration is static and part of the artifact the Owner approves:
 * icon, title, the operation that answers the item's state, who may see
 * it, and the "ask the AI" prompts it offers. The state is dynamic: the
 * admin calls `operation` with `{ pageId }` for the page the editor shows,
 * as a read-only render invocation on the editor's chat branch (so the
 * draft is what it describes), and validates the answer against
 * {@link pluginEditorToolbarState}. Every value of the state is rendered as
 * text; a prompt is inserted into the chat composer and sent only by the
 * operator, so neither a declaration nor a state can make the AI act.
 *
 * @example
 *   editorToolbar: [{
 *     id: "languages", title: "Languages", icon: "globe",
 *     operation: "editor_languages", permission: "content.read",
 *     prompts: [{ label: "Translate this page", text: "Translate {page} into every missing language." }],
 *   }],
 *   operations: {
 *     editor_languages: async (ctx, { pageId }) => ({
 *       label: "EN", tone: "attention", summary: "German is out of date.",
 *       items: [
 *         { label: "English", detail: "Source", current: true },
 *         { label: "Deutsch", detail: "Out of date", tone: "attention", pageId: "…" },
 *       ],
 *     }),
 *   },
 */

import { z } from "zod";
import { pluginPanelIcon, pluginPanelPermission } from "./admin-panels.js";

/** Item ids: unique per plugin, they appear in test ids and keys. */
const itemId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "must be lowercase, dash-separated, at most 63 characters");

/** One "ask the AI" button of an item's popover. */
export const pluginEditorToolbarPrompt = z
  .object({
    /** Button text. */
    label: z.string().min(1).max(40),
    /**
     * What the button puts into the chat composer. `{page}` stands for the
     * shown page's path. The operator reads it and sends it, or edits it.
     */
    text: z.string().min(1).max(500),
  })
  .strict();

/** The static declaration of one toolbar item (manifest data). */
export const pluginEditorToolbarItem = z
  .object({
    id: itemId,
    /** Tooltip and popover heading. */
    title: z.string().min(1).max(60),
    icon: pluginPanelIcon,
    /**
     * An operation of the plugin, called with `{ pageId }` and answering a
     * {@link PluginEditorToolbarState}. Read-only: it runs as a render
     * invocation, which cannot write.
     */
    operation: z.string().min(1).max(120),
    /** Who sees the item: one permission of the admin's catalog. */
    permission: pluginPanelPermission,
    prompts: z.array(pluginEditorToolbarPrompt).max(3).optional(),
  })
  .strict();

export type PluginEditorToolbarItem = z.infer<typeof pluginEditorToolbarItem>;

/** How much an item asks for attention. `problem` marks something that blocks or breaks. */
export const editorToolbarTone = z.enum(["neutral", "attention", "problem"]);

export type EditorToolbarTone = z.infer<typeof editorToolbarTone>;

/** One line of an item's popover. */
export const pluginEditorToolbarEntry = z
  .object({
    label: z.string().min(1).max(80),
    detail: z.string().min(1).max(120).optional(),
    tone: editorToolbarTone.optional(),
    /** Marks the entry that describes the shown page itself. */
    current: z.boolean().optional(),
    /** Opens this page in the editor. Ignored unless the editor knows the page. */
    pageId: z.string().uuid().optional(),
  })
  .strict();

/**
 * What an item's operation answers for one page. `hidden: true` leaves the
 * item out for this page (it has nothing to say there); an item that has
 * something to say but cannot say it fails its operation instead, and the
 * editor shows that failure on the item.
 */
export const pluginEditorToolbarState = z
  .object({
    hidden: z.boolean().optional(),
    /** Short text next to the icon, such as a language code. */
    label: z.string().min(1).max(8).optional(),
    /** A number on the icon, such as open items. 0 shows nothing. */
    count: z.number().int().min(0).max(9999).optional(),
    tone: editorToolbarTone.optional(),
    /** One sentence: the tooltip and the popover's first line. */
    summary: z.string().min(1).max(200).optional(),
    items: z.array(pluginEditorToolbarEntry).max(20).optional(),
  })
  .strict();

export type PluginEditorToolbarState = z.infer<typeof pluginEditorToolbarState>;

/**
 * The cross-field checks of a plugin's toolbar items, run by the manifest
 * schema: unique ids, and every operation one of the plugin's `operations`.
 */
export function checkEditorToolbar(
  items: readonly PluginEditorToolbarItem[],
  operations: readonly string[],
  addIssue: (path: (string | number)[], message: string) => void,
): void {
  const declared = new Set(operations);
  const ids = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (ids.has(item.id)) addIssue([i, "id"], `toolbar item "${item.id}" is declared twice`);
    ids.add(item.id);
    if (!declared.has(item.operation)) {
      addIssue(
        [i, "operation"],
        `operation "${item.operation}" is not one of the plugin's operations`,
      );
    }
  }
}
