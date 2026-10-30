// SPDX-License-Identifier: MPL-2.0

/**
 * #1276 — duplicate guard for page types. `blog`, `blogs` and `blog-post`
 * next to each other split the site's content: a page query for one
 * misses the pages of the others. Same split as #820 (exact = block,
 * near = hint):
 *
 *   - normalised-equal slugs (case, `-`/`_`, a trailing plural `s`, the
 *     suffix words `page` / `post` / `article`) are the SAME kind of
 *     content — a create is refused unless the caller names the existing
 *     slug in `distinctFrom`;
 *   - a small edit distance between the normalised keys (`faq` / `fab`,
 *     `news` / `new`) is only a hint: those are usually different things.
 *
 * Pure — the ops pass in the types the caller sees.
 */

/** Suffix words that do not change what a page type is (`blog-post` = `blog`). */
const NEUTRAL_SUFFIXES = new Set(["page", "pages", "post", "posts", "article", "articles"]);

/** Words whose trailing `s` is not a plural (`news` is not many `new`). */
const NON_PLURAL_S = new Set(["news", "series", "species", "status", "analysis", "access"]);

/** The singular of one word (`categories` → `category`, `blogs` → `blog`). */
function singular(word: string): string {
  if (NON_PLURAL_S.has(word) || word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * The comparison key of a page type slug: two slugs with the same key name
 * the same kind of content.
 *
 * @example pageTypeSlugKey("Blog_Posts") === pageTypeSlugKey("blog") // "blog"
 */
export function pageTypeSlugKey(slug: string): string {
  const words = slug
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0);
  while (words.length > 1 && NEUTRAL_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  const last = words.pop() ?? "";
  return [...words, singular(last)].join("");
}

/** Levenshtein distance, capped: returns `cap + 1` once it is exceeded. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length] ?? cap + 1;
}

/** An existing page type as the guard compares it. */
export interface PageTypeForGuard {
  readonly slug: string;
  readonly purpose: string;
  readonly pageCount: number;
}

/** What the guard says about one new slug. */
export interface PageTypeGuardResult {
  /** Normalised-equal types the caller did not name in `distinctFrom`: refuse. */
  readonly duplicates: readonly PageTypeForGuard[];
  /** Near types (small edit distance): hint only. */
  readonly near: readonly PageTypeForGuard[];
}

/**
 * Compare a new page type slug against the types the caller sees (and the
 * other new types of the same batch). The slug itself is never its own
 * duplicate.
 */
export function guardPageTypeSlug(
  slug: string,
  others: readonly PageTypeForGuard[],
  distinctFrom: readonly string[] = [],
): PageTypeGuardResult {
  const key = pageTypeSlugKey(slug);
  const allowed = new Set(distinctFrom);
  const duplicates: PageTypeForGuard[] = [];
  const near: PageTypeForGuard[] = [];
  for (const o of others) {
    if (o.slug === slug) continue;
    const otherKey = pageTypeSlugKey(o.slug);
    if (otherKey === key) {
      if (!allowed.has(o.slug)) duplicates.push(o);
      continue;
    }
    const cap = Math.min(key.length, otherKey.length) <= 5 ? 1 : 2;
    if (editDistance(key, otherKey, cap) <= cap) near.push(o);
  }
  return { duplicates, near };
}

/** Purpose shortened for one line of an error or hint. */
export function shortPurpose(purpose: string, max = 80): string {
  const p = purpose.replace(/\s+/g, " ").trim();
  return p.length <= max ? p : `${p.slice(0, max - 1)}…`;
}

/** The refusal for a normalised-equal duplicate (AI-actionable, #1276). */
export function duplicatePageTypeMessage(slug: string, dup: PageTypeForGuard): string {
  return `page type "${slug}" is the same kind of content as "${dup.slug}" (purpose: ${shortPurpose(dup.purpose)}; ${dup.pageCount} page(s)) — use "${dup.slug}", or pass distinctFrom:["${dup.slug}"] when "${slug}" is really a different kind of page.`;
}

/** The hint for near types (never a refusal). */
export function nearPageTypeHint(slug: string, near: readonly PageTypeForGuard[]): string {
  return `page type "${slug}" is close to ${near.map((n) => `"${n.slug}" (${shortPurpose(n.purpose, 60)})`).join(", ")} — fine if it is a different kind of page; otherwise use the existing type.`;
}
