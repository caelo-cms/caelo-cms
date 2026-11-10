// SPDX-License-Identifier: MPL-2.0

/**
 * The baked thread: what `staticRender` writes into a comments region and
 * what crawlers read (#1169, #1511).
 *
 * The region holds plugin DATA only — the approved comments, each with its
 * author, its date in the page's language and its text. Interface copy
 * (the heading, the form's labels, "Show older comments") lives in the
 * module around the region, as `{{site_text.<key>}}`: the module is
 * rendered by the build in the page's language variant, while this region
 * is re-rendered by plugin-data builds (#1155) that never touch modules.
 * A text baked in here could therefore only be one language, which is
 * exactly what #1511 reported.
 *
 * Markup, shared with `runtime.ts` (which builds the same shape for
 * comments that arrive after the bake):
 *
 *   <div data-comment-thread [data-cursor="{json}" data-total="N"]>
 *     <article class="comment" data-comment-id="…">
 *       <header><span class="comment-author">…</span>
 *         <time datetime="ISO">5. November 2026</time></header>
 *       <div class="body">…</div>
 *     </article>…
 *   </div>
 *
 * `data-cursor` / `data-total` are present only on a thread longer than
 * the bake: the runtime reads the next page from that cursor.
 */

import { escapeHtml } from "@caelo-cms/plugin-component-kit";

/** One approved comment as the bake shows it. */
export interface BakedComment {
  /** The id the runtime dedupes by (the public row id). */
  readonly id: string;
  readonly authorName: string;
  readonly content: string;
  /** ISO instant. */
  readonly submittedAt: string;
}

/**
 * The options every comment date is formatted with, here and in the
 * browser runtime: the same style as a module's `{{f.formatted}}` date
 * (docs/lists.md), so a comment's date reads like the page's other dates.
 */
export const COMMENT_DATE_OPTIONS = { dateStyle: "long", timeZone: "UTC" } as const;

/**
 * A formatter for the page's language. A tag `Intl` does not accept is a
 * broken page language, not something to paper over with another one.
 */
export function commentDateFormat(lang: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(lang, COMMENT_DATE_OPTIONS);
  } catch (e) {
    throw new Error(
      `comments: the page language "${lang}" is not one Intl can format dates in (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/** One comment's article. Every visitor-written value is escaped. */
export function commentArticle(c: BakedComment, day: Intl.DateTimeFormat): string {
  const at = new Date(c.submittedAt);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`comments: comment ${c.id} has no valid date (${c.submittedAt})`);
  }
  const iso = at.toISOString();
  return (
    `<article class="comment" data-comment-id="${escapeHtml(c.id)}">` +
    `<header><span class="comment-author">${escapeHtml(c.authorName)}</span> ` +
    `<time datetime="${iso}">${escapeHtml(day.format(at))}</time></header>` +
    `<div class="body">${escapeHtml(c.content)}</div>` +
    `</article>`
  );
}

/** The baked thread of one page: its newest comments and, when there are more, where the rest starts. */
export function threadHtml(args: {
  readonly comments: ReadonlyArray<BakedComment>;
  readonly lang: string;
  /** The next page's position (`list_approved`'s `before`), or null on a complete thread. */
  readonly nextCursor: unknown;
  /** Every approved comment of the page; read only when `nextCursor` is set. */
  readonly total: number | null;
}): string {
  const day = commentDateFormat(args.lang);
  const articles = args.comments.map((c) => commentArticle(c, day)).join("");
  if (args.nextCursor === null) return `<div data-comment-thread>${articles}</div>`;
  if (args.total === null) {
    throw new Error("comments: a thread longer than its bake needs its comment count");
  }
  const cursor = escapeHtml(JSON.stringify(args.nextCursor));
  return `<div data-comment-thread data-cursor="${cursor}" data-total="${args.total}">${articles}</div>`;
}
