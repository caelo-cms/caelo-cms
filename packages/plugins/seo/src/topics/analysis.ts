// SPDX-License-Identifier: MPL-2.0

/**
 * Curated topic pages and internal links (#1759), the pure half: term use,
 * near-duplicate terms and link suggestions from the plugin's index of the
 * published site (page-index.ts).
 *
 * Maintainer decision (2026-11-26): a term never makes a page by itself.
 * The plugin only SUGGESTS a topic page once enough published pages carry
 * a term; the AI builds it as a normal page and names it the term's
 * overview page. Every suggestion names its reasons, so the AI and the
 * operator can judge it.
 */

import type { PageIndexRow } from "./page-index.js";

/** One term of a vocabulary as the tools read it. */
export interface TermInfo {
  readonly itemId: string;
  readonly name: string;
  /** The term's overview page as a path, or null: a term without one has no URL. */
  readonly topicPage: string | null;
  /** That page's id when the term links it as a page (the usual case), else null. */
  readonly topicPageId: string | null;
}

/** A term with its use on the published site. */
export interface TermUse extends TermInfo {
  /** Published, indexable pages carrying the term. */
  readonly pages: number;
  /** Enough pages and no topic page yet. */
  readonly suggestTopicPage: boolean;
}

/** Published pages per term of one vocabulary (indexable pages only). */
export function termCounts(rows: readonly PageIndexRow[], vocabulary: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.indexable) continue;
    for (const itemId of new Set(r.terms[vocabulary] ?? []))
      out.set(itemId, (out.get(itemId) ?? 0) + 1);
  }
  return out;
}

/** The use of every term of a vocabulary, most used first. */
export function termUse(
  terms: readonly TermInfo[],
  counts: ReadonlyMap<string, number>,
  threshold: number,
): TermUse[] {
  return terms
    .map((t) => {
      const pages = counts.get(t.itemId) ?? 0;
      return { ...t, pages, suggestTopicPage: t.topicPage === null && pages >= threshold };
    })
    .sort((a, b) => b.pages - a.pages || a.name.localeCompare(b.name));
}

/** A name reduced to what tells two spellings of one topic apart. */
export function termKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ");
}

/** Levenshtein distance, stopping once it passes `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] as number;
}

/** Terms that look like one topic spelt twice, with the merge the plugin proposes. */
export interface DuplicateGroup {
  readonly terms: readonly TermUse[];
  /** The term to keep: the one with a topic page, else the most used. */
  readonly into: TermUse;
  readonly reason: string;
}

/**
 * Near-duplicate terms: the same name once case, accents, hyphens and a
 * plural `s` are set aside ("SEO-Tool" / "SEO Tools"), or names of six
 * letters or more one edit apart ("Crawlling" / "Crawling").
 */
export function nearDuplicates(terms: readonly TermUse[]): DuplicateGroup[] {
  const groups: TermUse[][] = [];
  const reasons: string[] = [];
  const placed = new Set<string>();
  for (const [i, a] of terms.entries()) {
    if (placed.has(a.itemId)) continue;
    const group = [a];
    let reason = "";
    for (const b of terms.slice(i + 1)) {
      if (placed.has(b.itemId)) continue;
      const ka = termKey(a.name);
      const kb = termKey(b.name);
      if (ka === kb) reason ||= "the same name apart from case, accents, hyphens or a plural";
      else if (ka.length >= 6 && distance(ka, kb, 1) <= 1)
        reason ||= "the names are one letter apart";
      else continue;
      group.push(b);
      placed.add(b.itemId);
    }
    if (group.length > 1) {
      placed.add(a.itemId);
      groups.push(group);
      reasons.push(reason);
    }
  }
  return groups.map((g, i) => {
    const into = g.find((t) => t.topicPage !== null) ?? [...g].sort((x, y) => y.pages - x.pages)[0];
    return { terms: g, into: into as TermUse, reason: reasons[i] as string };
  });
}

/** How the link tools see the site's link graph. */
export interface LinkGraph {
  /** Pages linking to a page (from their content). */
  readonly inbound: ReadonlyMap<string, number>;
  /** Clicks from the home page; absent = not reachable through content links. */
  readonly depth: ReadonlyMap<string, number>;
}

/** Inbound links and click depth from the index (breadth-first from the home page). */
export function linkGraph(rows: readonly PageIndexRow[], homePageId: string | null): LinkGraph {
  const inbound = new Map<string, number>();
  const out = new Map<string, readonly string[]>();
  for (const r of rows) {
    out.set(r.page_id, r.links);
    for (const target of r.links) inbound.set(target, (inbound.get(target) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  if (homePageId !== null && out.has(homePageId)) {
    depth.set(homePageId, 0);
    let frontier = [homePageId];
    for (let d = 1; frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const target of out.get(id) ?? []) {
          if (depth.has(target) || !out.has(target)) continue;
          depth.set(target, d);
          next.push(target);
        }
      }
      frontier = next;
    }
  }
  return { inbound, depth };
}

/** One page worth a link from the page being written, and why. */
export interface LinkSuggestion {
  readonly pageId: string;
  readonly path: string;
  readonly title: string;
  readonly reasons: readonly string[];
}

/** Most suggestions one call returns. */
const MAX_SUGGESTIONS = 10;

/**
 * Pages the page could link to: they share its terms or its page type, the
 * page does not link to them yet; a page few others link to ranks higher.
 *
 * @param termName a term's name by vocabulary and item id, for the reasons.
 */
export function linkSuggestions(
  rows: readonly PageIndexRow[],
  page: PageIndexRow,
  graph: LinkGraph,
  termName: (vocabulary: string, itemId: string) => string | null,
): LinkSuggestion[] {
  const own = new Set(
    Object.entries(page.terms).flatMap(([v, ids]) => ids.map((id) => `${v}/${id}`)),
  );
  const linked = new Set(page.links);
  const scored: { s: LinkSuggestion; score: number }[] = [];
  for (const r of rows) {
    if (r.page_id === page.page_id || !r.indexable || linked.has(r.page_id)) continue;
    const shared = Object.entries(r.terms).flatMap(([v, ids]) =>
      ids.filter((id) => own.has(`${v}/${id}`)).map((id) => termName(v, id) ?? id),
    );
    const sameType = r.page_type !== "" && r.page_type === page.page_type;
    if (shared.length === 0 && !sameType) continue;
    const inbound = graph.inbound.get(r.page_id) ?? 0;
    const reasons: string[] = [];
    if (shared.length > 0) reasons.push(`shares the terms ${shared.join(", ")}`);
    if (sameType) reasons.push(`same page type (${r.page_type})`);
    if (inbound <= 1)
      reasons.push(inbound === 0 ? "no page links to it yet" : "only one page links to it");
    const score = shared.length * 2 + (sameType ? 1 : 0) + (inbound <= 1 ? 1 : 0);
    scored.push({ s: { pageId: r.page_id, path: r.path, title: r.title, reasons }, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path))
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.s);
}
