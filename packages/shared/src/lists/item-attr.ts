// SPDX-License-Identifier: MPL-2.0

/**
 * The `data-caelo-list-item` value the engine stamps on a rendered stored
 * list entry (epic #1107, `docs/lists.md` §13), parsed. Live Edit sends it
 * with a click-to-chat reference so the chip names the list entry, not the
 * whole module, and the AI edits that entry with the list tools (shared
 * list) or the content tools (a module's own list).
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAME = "[a-z][a-z0-9_]{0,63}";

/** Every form a `data-caelo-list-item` value takes. */
export const LIST_ITEM_ATTR_RE = new RegExp(
  `^(?:${UUID}/${UUID}|instance/${UUID}/${NAME}/${UUID}|local/${NAME}/${UUID})$`,
);

/** A parsed `data-caelo-list-item` value. */
export type ListItemAttr =
  /** An entry of a shared list. */
  | { readonly kind: "shared"; readonly listId: string; readonly itemId: string }
  /** An entry of a module's own list, stored in a content instance. */
  | {
      readonly kind: "instance";
      readonly contentInstanceId: string;
      readonly field: string;
      readonly itemId: string;
    }
  /** An entry of a module field's default list (site chrome without stored content). */
  | { readonly kind: "local"; readonly field: string; readonly itemId: string };

/** Parse a `data-caelo-list-item` value; null when it is not one. */
export function parseListItemAttr(value: string): ListItemAttr | null {
  if (!LIST_ITEM_ATTR_RE.test(value)) return null;
  const parts = value.split("/");
  if (parts[0] === "instance") {
    return {
      kind: "instance",
      contentInstanceId: parts[1] as string,
      field: parts[2] as string,
      itemId: parts[3] as string,
    };
  }
  if (parts[0] === "local") {
    return { kind: "local", field: parts[1] as string, itemId: parts[2] as string };
  }
  return { kind: "shared", listId: parts[0] as string, itemId: parts[1] as string };
}
