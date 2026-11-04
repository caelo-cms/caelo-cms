// SPDX-License-Identifier: MPL-2.0
import { cleanValues } from "./field-form.js";
/** The properties + terms to send for `type`, given the page as stored. */
export function pageSettingsPayload(type, draft, stored) {
    const properties = cleanValues(type.properties, draft.properties);
    for (const k of Object.keys(stored.properties)) {
        if (!(k in properties))
            properties[k] = null;
    }
    const lists = new Set(type.vocabularies.map((v) => v.list));
    const terms = draft.terms.filter((t) => {
        const listId = /^caelo:term\/([0-9a-f-]{36})\//.exec(t)?.[1];
        return listId !== undefined && lists.has(listId);
    });
    return { properties, terms: [...new Set(terms)] };
}
