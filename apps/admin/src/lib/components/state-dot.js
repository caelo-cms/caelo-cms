// SPDX-License-Identifier: MPL-2.0
/**
 * The page list's mark for a page status: exactly Draft or Published,
 * never Preview / Live (no per-page build state exists).
 *
 * @throws on a status other than `draft` / `published` — a new status
 *   needs its own mark, not a silent default (CLAUDE.md §2).
 */
export function pageStatusMark(status) {
    if (status === "draft" || status === "published")
        return status;
    throw new Error(`pageStatusMark: unknown page status '${status}' — add a mark for it`);
}
