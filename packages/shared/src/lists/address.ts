// SPDX-License-Identifier: MPL-2.0

/**
 * Stable value addresses (epic #1107, `docs/lists.md` §9). Core has no
 * locale concept; a translation plugin keys its own storage by these
 * addresses and answers the `list-resolve` composition point with
 * overlays keyed the same way. Entry ids never change, so an address
 * survives moves, renames of loop names and reordering.
 */

/** One addressable stored value. */
export type ValueAddress =
  | {
      readonly kind: "list";
      readonly listId: string;
      readonly itemId: string;
      readonly field: string;
    }
  | {
      readonly kind: "instance";
      readonly contentInstanceId: string;
      readonly field: string;
      readonly itemId: string;
      readonly itemField: string;
    }
  | { readonly kind: "pageProp"; readonly pageId: string; readonly field: string }
  | {
      readonly kind: "listTypeField";
      readonly listTypeId: string;
      readonly node: string;
      readonly field: string;
    };

const SEG = "[a-z0-9_-]+";
const ADDRESS_RE = new RegExp(
  `^(?:list/(${SEG})/item/(${SEG})/(${SEG})` +
    `|instance/(${SEG})/(${SEG})/item/(${SEG})/(${SEG})` +
    `|page/(${SEG})/props/(${SEG})` +
    `|list_type/(${SEG})/node/(${SEG})/(${SEG}))$`,
);

/** Format an address as its canonical string. */
export function formatValueAddress(a: ValueAddress): string {
  switch (a.kind) {
    case "list":
      return `list/${a.listId}/item/${a.itemId}/${a.field}`;
    case "instance":
      return `instance/${a.contentInstanceId}/${a.field}/item/${a.itemId}/${a.itemField}`;
    case "pageProp":
      return `page/${a.pageId}/props/${a.field}`;
    case "listTypeField":
      return `list_type/${a.listTypeId}/node/${a.node}/${a.field}`;
  }
}

/** Parse an address string; null when it is not one. */
export function parseValueAddress(s: string): ValueAddress | null {
  const m = ADDRESS_RE.exec(s);
  if (!m) return null;
  if (m[1] && m[2] && m[3]) return { kind: "list", listId: m[1], itemId: m[2], field: m[3] };
  if (m[4] && m[5] && m[6] && m[7]) {
    return {
      kind: "instance",
      contentInstanceId: m[4],
      field: m[5],
      itemId: m[6],
      itemField: m[7],
    };
  }
  if (m[8] && m[9]) return { kind: "pageProp", pageId: m[8], field: m[9] };
  if (m[10] && m[11] && m[12]) {
    return { kind: "listTypeField", listTypeId: m[10], node: m[11], field: m[12] };
  }
  return null;
}
