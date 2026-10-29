// SPDX-License-Identifier: MPL-2.0

/**
 * Paginated page lists (#1257, `docs/lists.md` §6 "Pagination"). An
 * overview page (a guides hub, a category landing page) lists every page
 * a query matches: its paginated `list` field shows `per_page` entries,
 * page 1 at the page's own URL and every further page at
 * `<page path>/page/<n>/`. The static generator and the editor preview
 * emit those follow-up pages; the module draws its own pager from the
 * `pagination` system source.
 *
 * Decisions (maintainer, #1257):
 *
 * - Follow-up URLs are path segments, not `?page=n`: a static host serves
 *   files, and a query string would serve page 1 for every page.
 *   `/page/1/` is never emitted — page 1 has exactly one URL.
 * - Follow-up pages are indexable and self-canonical by default (Google:
 *   do not canonicalise page 2… to page 1); `follow_ups: "noindex"` keeps
 *   them out of search (robots noindex, no sitemap entry) per overview.
 * - Page size defaults to the maximum ({@link LIST_QUERY_MAX_LIMIT}):
 *   static HTML costs nothing per entry, and fewer follow-up pages mean
 *   fewer thin pages.
 * - One paginated list per page: two would need two independent page
 *   numbers in one URL.
 */

import { z } from "zod";
import type { PageUrlStyle } from "../seo.js";
import { trimSlashes } from "../url.js";
import { LIST_QUERY_MAX_LIMIT } from "./list-type.js";

/** The URL segment in front of the page number: `/guides/page/2/`. */
export const PAGINATION_SEGMENT = "page";

/** Who may see follow-up pages in search. */
export const PAGINATION_FOLLOW_UPS = ["index", "noindex"] as const;
export type PaginationFollowUps = (typeof PAGINATION_FOLLOW_UPS)[number];

/**
 * Pagination settings — on a module `list` field (`paginate`, opts the
 * field in and sets the defaults) and in a placement's value
 * (`paginate`, overrides them for that overview).
 */
export const listPaginationSchema = z
  .object({
    /** Entries per page, 1..50; default 50. */
    per_page: z.number().int().min(1).max(LIST_QUERY_MAX_LIMIT).optional(),
    /** Follow-up pages indexable (default) or `noindex` and out of the sitemap. */
    follow_ups: z.enum(PAGINATION_FOLLOW_UPS).optional(),
  })
  .strict();
export type ListPaginationSettings = z.infer<typeof listPaginationSchema>;

/** The settings an overview renders with. */
export interface EffectivePagination {
  readonly perPage: number;
  readonly followUps: PaginationFollowUps;
}

/**
 * The placement value of a paginated field split into its pagination
 * overrides and the rest (query knobs / `terms`). The rest is what the
 * source reads; `paginate` never reaches the query parser.
 */
export function splitPaginationValue(value: unknown): {
  readonly paginate: unknown;
  readonly rest: unknown;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { paginate: undefined, rest: value };
  }
  const { paginate, ...rest } = value as Record<string, unknown>;
  return { paginate, rest: Object.keys(rest).length > 0 ? rest : undefined };
}

/**
 * Field settings with the placement's overrides applied; null when the
 * overrides are malformed (the render reports `list-malformed`).
 */
export function effectivePagination(
  field: ListPaginationSettings,
  overrides: unknown,
): EffectivePagination | null {
  const parsed = listPaginationSchema.safeParse(overrides ?? {});
  if (!parsed.success) return null;
  return {
    perPage: parsed.data.per_page ?? field.per_page ?? LIST_QUERY_MAX_LIMIT,
    followUps: parsed.data.follow_ups ?? field.follow_ups ?? "index",
  };
}

/** How many pages `total` entries need at `perPage` (at least one). */
export function pageCountOf(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}

/**
 * The public path of page `n` (≥ 2) of the overview at `path`:
 * `/guides` → `/guides/page/2`, `/` → `/page/2`. No trailing slash: the
 * target's URL style adds it (`pageHrefForStyle`, `pageOutputPath`).
 */
export function pagedPath(path: string, n: number): string {
  assertFollowUp(n);
  const trimmed = trimSlashes(path);
  return `${trimmed.length > 0 ? `/${trimmed}` : ""}/${PAGINATION_SEGMENT}/${n}`;
}

/**
 * The URL of page `n` (≥ 2) from the overview's own URL (absolute or a
 * path, as the link resolver or the public URL builder made it) in the
 * target's URL style. Query and fragment are dropped: they belong to
 * page 1's link, not to the page sequence.
 */
export function pagedUrl(url: string, n: number, style: PageUrlStyle): string {
  assertFollowUp(n);
  // Trailing slashes cut by index, not a regex: no backtracking on input.
  let base = url.split(/[?#]/, 1)[0] ?? url;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 47) end -= 1;
  base = base.slice(0, end);
  return `${base}/${PAGINATION_SEGMENT}/${n}${style === "directory" ? "/" : ""}`;
}

/**
 * Split a requested path into the overview's path and a follow-up page
 * number: `/guides/page/3/` → `{ basePath: "/guides", page: 3 }`. Null
 * when the path names no follow-up page (`/page/1` included — page 1 is
 * only served at the overview's own path).
 */
export function parsePagedPath(path: string): { basePath: string; page: number } | null {
  const m = /^(.*?)\/page\/([1-9][0-9]{0,5})\/?$/.exec(path);
  if (!m) return null;
  const page = Number(m[2]);
  if (page < 2) return null;
  const base = trimSlashes(m[1] ?? "");
  return { basePath: base.length === 0 ? "/" : `/${base}`, page };
}

/**
 * The page path a follow-up page of `overviewPath` would collide with:
 * `pagePath` is `<overview>/page` or below it. A page there would either
 * shadow a follow-up page or, in the no-extension URL style, need a file
 * and a directory of the same name.
 */
export function collidesWithFollowUps(overviewPath: string, pagePath: string): boolean {
  const prefix = pagedPrefix(overviewPath);
  const p = `/${trimSlashes(pagePath)}`;
  return p === prefix || p.startsWith(`${prefix}/`);
}

function pagedPrefix(path: string): string {
  const trimmed = trimSlashes(path);
  return `${trimmed.length > 0 ? `/${trimmed}` : ""}/${PAGINATION_SEGMENT}`;
}

function assertFollowUp(n: number): void {
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(`pagination: follow-up page numbers start at 2 (got ${n}).`);
  }
}
