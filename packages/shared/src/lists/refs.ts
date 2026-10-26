// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo:list/<id>` — the reference a module `list` field with
 * `bind: "shared"` stores (epic #1107, `docs/lists.md` §7). Its own file
 * because the module field schema (`content.ts`) and the resolver both
 * need it, and the resolver imports far more than the schema should.
 */

/** `caelo:list/<id>` */
export const LIST_REF_RE = /^caelo:list\/([0-9a-f-]{36})$/;

/** Parse `caelo:list/<id>`; null when the string is not one. */
export function parseListRef(s: string): string | null {
  return LIST_REF_RE.exec(s)?.[1] ?? null;
}

/** Format a shared-list reference. */
export function formatListRef(listId: string): string {
  return `caelo:list/${listId}`;
}
