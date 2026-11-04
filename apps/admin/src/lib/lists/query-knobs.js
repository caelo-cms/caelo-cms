// SPDX-License-Identifier: MPL-2.0
/** Operator-facing names of the knobs. */
export const KNOB_LABELS = {
    page_type: "Page type",
    terms: "Terms",
    terms_mode: "Match",
    parent: "Below page",
    exclude_current: "Leave out the page being shown",
    order: "Order",
    limit: "How many",
};
/** Fixed orders (property orders are `prop_desc:<name>` / `prop_asc:<name>`). */
export const ORDER_LABELS = {
    published_desc: "Newest first",
    published_asc: "Oldest first",
    title_asc: "Title A–Z",
};
/** The knobs an entry of this source may set. */
export function editableKnobs(source) {
    return source?.kind === "query" ? source.editable : [];
}
/** The query that runs for an entry: the type's defaults, then the entry's overrides. */
export function effectiveQuery(source, overrides) {
    const out = { ...source.defaults };
    for (const k of source.editable) {
        if (overrides && overrides[k] !== undefined)
            out[k] = overrides[k];
    }
    return out;
}
/**
 * Overrides with `knob` set to `value` — or removed when `value` is
 * undefined / equals the default, so an entry stores only what differs.
 * A knob that is not editable is never written.
 */
export function setKnob(source, overrides, knob, value) {
    const next = { ...(overrides ?? {}) };
    const isDefault = JSON.stringify(source.defaults[knob]) === JSON.stringify(value);
    if (!source.editable.includes(knob) || value === undefined || value === "" || isDefault) {
        delete next[knob];
    }
    else {
        next[knob] = value;
    }
    return next;
}
