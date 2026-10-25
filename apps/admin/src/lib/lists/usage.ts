// SPDX-License-Identifier: MPL-2.0

/**
 * "Used in" for a shared list, in the operator's words (epic #1107,
 * CLAUDE.md §1A): which sections show it and on which pages, or — for a
 * vocabulary — how many pages carry its terms. Never module slugs or
 * placement jargon.
 */

/** The usage `lists.list` / `lists.get` report for one list. */
export interface ListUsageInput {
  modules: readonly { displayName: string }[];
  placementCount: number;
  samplePages: readonly { path: string; title: string }[];
  taggedPageCount: number;
}

/** One line: "Header navigation on 12 pages (/, /about, …)" or "Not used yet". */
export function usageSummary(usage: ListUsageInput): string {
  const parts: string[] = [];
  if (usage.modules.length > 0) {
    const names = [...new Set(usage.modules.map((m) => m.displayName))];
    const shown = names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "");
    const pages =
      usage.placementCount > 0
        ? ` on ${usage.placementCount} page${usage.placementCount === 1 ? "" : "s"}`
        : "";
    parts.push(`${shown}${pages}`);
  }
  if (usage.taggedPageCount > 0) {
    parts.push(`${usage.taggedPageCount} page${usage.taggedPageCount === 1 ? "" : "s"} tagged`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Not used yet";
}
