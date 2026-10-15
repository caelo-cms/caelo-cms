// SPDX-License-Identifier: MPL-2.0

/**
 * The marks `StateDot.svelte` renders (#779).
 *
 * Draft (edited, not in any build) → Preview (in the staged build) →
 * Live (in the production build) are site/build states, shown where the
 * build state is known (toolbar, dashboard). `published` is the page
 * status from `pages.status`: it means "included in the next Stage", not
 * "live", and is what the page list shows next to Draft.
 */
export type PublishState = "draft" | "preview" | "live" | "published";

/**
 * The page list's mark for a page status: exactly Draft or Published,
 * never Preview / Live (no per-page build state exists).
 *
 * @throws on a status other than `draft` / `published` — a new status
 *   needs its own mark, not a silent default (CLAUDE.md §2).
 */
export function pageStatusMark(status: string): "draft" | "published" {
  if (status === "draft" || status === "published") return status;
  throw new Error(`pageStatusMark: unknown page status '${status}' — add a mark for it`);
}
