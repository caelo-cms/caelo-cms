// SPDX-License-Identifier: MPL-2.0
/** How many places the bar shows before the rest move behind "+N". */
export const VISIBLE_TOOLBAR_SLOTS = 3;
/**
 * Which slots the bar shows and which sit behind "+N": all of them up to
 * {@link VISIBLE_TOOLBAR_SLOTS}; beyond that one place fewer, so "+N"
 * itself takes the last place and the bar never grows past three.
 */
export function splitToolbarSlots(slots) {
    if (slots.length <= VISIBLE_TOOLBAR_SLOTS)
        return { shown: [...slots], more: [] };
    return {
        shown: slots.slice(0, VISIBLE_TOOLBAR_SLOTS - 1),
        more: slots.slice(VISIBLE_TOOLBAR_SLOTS - 1),
    };
}
/** A prompt's text for the shown page: `{page}` becomes its path. */
export function promptText(text, path) {
    return text.replaceAll("{page}", path);
}
