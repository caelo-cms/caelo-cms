// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin places in the live editor's top bar, as the server hands them
 * to the editor (`#lib/server/plugin-toolbar.ts` loads and validates them).
 */

import type { PluginEditorToolbarItem, PluginEditorToolbarState } from "@caelo-cms/plugin-sdk";

/** One plugin place in the editor's top bar. */
export interface EditorToolbarSlot {
  /** `<pluginSlug>/<itemId>`: unique across plugins. */
  readonly key: string;
  readonly pluginSlug: string;
  readonly title: string;
  readonly icon: PluginEditorToolbarItem["icon"];
  readonly prompts: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  /** The validated state, or null when `error` is set. */
  readonly state: PluginEditorToolbarState | null;
  /** Why the state could not be shown, phrased for the operator. */
  readonly error: string | null;
}

/** How many places the bar shows before the rest move behind "+N". */
export const VISIBLE_TOOLBAR_SLOTS = 3;

/**
 * Which slots the bar shows and which sit behind "+N": all of them up to
 * {@link VISIBLE_TOOLBAR_SLOTS}; beyond that one place fewer, so "+N"
 * itself takes the last place and the bar never grows past three.
 */
export function splitToolbarSlots<T>(slots: readonly T[]): { shown: T[]; more: T[] } {
  if (slots.length <= VISIBLE_TOOLBAR_SLOTS) return { shown: [...slots], more: [] };
  return {
    shown: slots.slice(0, VISIBLE_TOOLBAR_SLOTS - 1),
    more: slots.slice(VISIBLE_TOOLBAR_SLOTS - 1),
  };
}

/** A prompt's text for the shown page: `{page}` becomes its path. */
export function promptText(text: string, path: string): string {
  return text.replaceAll("{page}", path);
}
