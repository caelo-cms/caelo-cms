// SPDX-License-Identifier: MPL-2.0
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asEdit(v) {
    if (!isRecord(v))
        return null;
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
export function moduleHtmlEdits(toolName, args) {
    if (!isRecord(args))
        return [];
    if (toolName === "update_modules_many") {
        const list = Array.isArray(args.items) ? args.items : args.updates;
        if (!Array.isArray(list))
            return [];
        return list.map(asEdit).filter((e) => e !== null);
    }
    if (toolName === "edit_module") {
        const edit = asEdit(args);
        return edit ? [edit] : [];
    }
    return [];
}
