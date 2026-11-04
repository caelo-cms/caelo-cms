// SPDX-License-Identifier: MPL-2.0
/** Flatten a vocabulary into term choices, depth-first, children indented. */
export function termChoices(vocabulary) {
    const out = [];
    const walk = (items, depth) => {
        for (const it of items) {
            if (it.id) {
                const name = typeof it.values.name === "string" ? it.values.name : it.id;
                out.push({ ref: `caelo:term/${vocabulary.id}/${it.id}`, name, depth });
            }
            walk(it.children ?? [], depth + 1);
        }
    };
    walk(vocabulary.items, 1);
    return out;
}
