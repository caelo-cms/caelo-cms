// SPDX-License-Identifier: MPL-2.0

/**
 * The Publish live review (`PublishLiveReview.svelte`): what the next
 * Publish live changes for visitors, read from `GET /api/deploy/publish-preview`
 * (deploy.publish_preview + redirects.release_plan). Pure helpers, so the
 * grouping and the wording are pinned by unit tests.
 *
 * The review shows numbers first and three examples per area; the full
 * lists open on request. Redirects that follow one pattern (48 blog posts
 * moved from /blog/2024/ to /news/) are one row with their count.
 */

import type { PublishPreview } from "@caelo-cms/admin-core";

/** A redirect change, as `redirects.release_plan` lists it. */
export interface PlannedRedirect {
  readonly id: string;
  readonly revision: number;
  readonly fromPath: string;
  readonly toPath: string | null;
  readonly origin: string;
  readonly reason?: "target" | "page";
}

/** `redirects.release_plan`: what the next Publish live does to the redirects. */
export interface RedirectPlan {
  readonly goingLive: readonly PlannedRedirect[];
  readonly waiting: readonly PlannedRedirect[];
  readonly draft: readonly PlannedRedirect[];
  readonly problem: string | null;
}

/** What the review reads when it opens. */
export interface PublishReviewData {
  readonly preview: PublishPreview;
  readonly redirects: RedirectPlan;
}

/** One redirect rule as text: `from → to`, or `from (removed)`. */
export function redirectRule(r: Pick<PlannedRedirect, "fromPath" | "toPath">): string {
  return r.toPath === null ? `${r.fromPath} (removed)` : `${r.fromPath} → ${r.toPath}`;
}

/** Redirects that follow one pattern, shown as one row. */
export interface RedirectGroup {
  /** `/blog/2024/… → /news/…`, or the rule itself for a group of one. */
  readonly label: string;
  readonly count: number;
}

/** `/a/b/c` → [`/a/b/`, `c`]; a trailing slash belongs to the leaf. */
function splitPath(path: string): [string, string] {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf("/");
  return [trimmed.slice(0, at + 1), trimmed.slice(at + 1)];
}

/**
 * Redirects grouped by pattern: the same page name moved from one folder
 * to another (`/blog/2024/x → /news/x`) is one group. Everything else is
 * a group of one. Largest groups first, then by address.
 */
export function groupRedirects(
  changes: readonly Pick<PlannedRedirect, "fromPath" | "toPath">[],
): RedirectGroup[] {
  const groups = new Map<string, { from: string; to: string; rules: string[] }>();
  for (const c of changes) {
    let key = `rule:${redirectRule(c)}`;
    let from = "";
    let to = "";
    if (c.toPath !== null && c.toPath.startsWith("/")) {
      const [fromDir, fromLeaf] = splitPath(c.fromPath);
      const [toDir, toLeaf] = splitPath(c.toPath);
      if (fromLeaf !== "" && fromLeaf === toLeaf && fromDir !== toDir) {
        key = `move:${fromDir}\u0000${toDir}`;
        from = fromDir;
        to = toDir;
      }
    }
    const g = groups.get(key) ?? { from, to, rules: [] };
    g.rules.push(redirectRule(c));
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      label: g.rules.length > 1 ? `${g.from}… → ${g.to}…` : (g.rules[0] ?? ""),
      count: g.rules.length,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** One page of the review's page list. */
export interface ReviewPage {
  readonly pageId: string;
  readonly title: string;
  readonly path: string | null;
  readonly change: "new" | "changed" | "removed";
}

/** Every listed page, new first, then changed, then removed. */
export function reviewPages(preview: PublishPreview): ReviewPage[] {
  return [
    ...preview.pages.new.items.map((p) => ({ ...p, change: "new" as const })),
    ...preview.pages.changed.items.map((p) => ({ ...p, change: "changed" as const })),
    ...preview.pages.removed.items.map((p) => ({ ...p, change: "removed" as const })),
  ];
}

/**
 * The three pages the review shows before "Show all": one of each kind
 * first, so the short list shows the mix, then filled up in list order.
 */
export function examplePages(pages: readonly ReviewPage[], count = 3): ReviewPage[] {
  const picked: ReviewPage[] = [];
  for (const kind of ["new", "changed", "removed"] as const) {
    const first = pages.find((p) => p.change === kind);
    if (first && picked.length < count) picked.push(first);
  }
  for (const p of pages) {
    if (picked.length >= count) break;
    if (!picked.includes(p)) picked.push(p);
  }
  // In list order, so "Show all" continues where the examples stop.
  return pages.filter((p) => picked.includes(p));
}

/** The pages tile's line: `3 new · 18 changed · 2 removed`, zero kinds left out. */
export function pageBreakdown(preview: PublishPreview): string {
  const parts = [
    [preview.pages.new.total, "new"],
    [preview.pages.changed.total, "changed"],
    [preview.pages.removed.total, "removed"],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return text.length > 0 ? text.join(" · ") : "none";
}

/** All pages the release changes, exact. */
export function pageTotal(preview: PublishPreview): number {
  return preview.pages.new.total + preview.pages.changed.total + preview.pages.removed.total;
}

/** Whether the release changes nothing a visitor sees: no page, part, setting or redirect. */
export function shipsNothingVisible(data: PublishReviewData): boolean {
  return (
    pageTotal(data.preview) === 0 &&
    data.preview.siteWide.length === 0 &&
    data.preview.settings.length === 0 &&
    data.redirects.goingLive.length === 0
  );
}

/**
 * The list the form posts back with Publish live: exactly the redirect
 * changes the review showed as going live (#1550).
 */
export function confirmedRedirects(plan: RedirectPlan): string {
  return JSON.stringify(plan.goingLive.map((c) => ({ id: c.id, revision: c.revision })));
}
