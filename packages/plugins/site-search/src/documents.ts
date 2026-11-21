// SPDX-License-Identifier: MPL-2.0

/**
 * The site search's documents (issue #1651): one per page in `pages`, and
 * the words other pages link to it with in `anchors`.
 *
 * A page document carries its title, short title, description, breadcrumb,
 * its sections (heading, text and the anchor a result links to) from the
 * text that counts fully, the reduced text apart (weighted down at query
 * time), its path, page type and terms. An anchor document is one link
 * text to one target from one source: a page (`p:<id>`) or, for layout
 * chrome on every page, the module (`m:<id>`, counted once with the
 * module's placement count instead of once per page).
 */

import { type CollectionDocInput, type PageOutputFacts, placementKey } from "@caelo-cms/plugin-sdk";
import { type ModuleVerdict, textMayCount } from "./rules.js";

/** One section of a page: what a result links to. */
export interface Section {
  readonly anchor: string;
  readonly heading: string;
  readonly text: string;
}

/** Most characters of one section's text (the engine stores and snippets it). */
const MAX_SECTION_CHARS = 4_000;

/** Most sections per field of one page. */
const MAX_SECTIONS = 80;

/** Sections of the text runs that `keep` accepts, in page order. */
export function sectionsOf(
  facts: PageOutputFacts,
  keep: (t: PageOutputFacts["texts"][number]) => boolean,
): Section[] {
  const out: { anchor: string; heading: string[]; text: string[]; chars: number }[] = [];
  let current: (typeof out)[number] | null = null;
  for (const t of facts.texts) {
    if (!keep(t)) continue;
    const anchor = t.anchor ?? "";
    const startsSection =
      current === null ||
      current.anchor !== anchor ||
      (t.heading !== null && current.text.length > 0);
    if (startsSection) {
      if (out.length >= MAX_SECTIONS) break;
      current = { anchor, heading: [], text: [], chars: 0 };
      out.push(current);
    }
    const c = current as (typeof out)[number];
    if (t.heading !== null) c.heading.push(t.text);
    else if (c.chars < MAX_SECTION_CHARS) {
      c.text.push(t.text);
      c.chars += t.text.length + 1;
    }
  }
  return out
    .map((s) => ({
      anchor: s.anchor,
      heading: s.heading.join(" ").slice(0, 300),
      text: s.text.join(" ").slice(0, MAX_SECTION_CHARS),
    }))
    .filter((s) => s.heading !== "" || s.text !== "");
}

/** The page's document, given how each of its modules counts. */
export function pageDocument(
  facts: PageOutputFacts,
  verdicts: ReadonlyMap<string, ModuleVerdict>,
): CollectionDocInput {
  // Each text counts by its own placement's verdict: one design placed with
  // two content instances is two blocks with their own settings.
  const weighting = (t: {
    readonly moduleId: string | null;
    readonly contentInstanceId: string | null;
  }) =>
    t.moduleId === null
      ? "none"
      : (verdicts.get(placementKey(t.moduleId, t.contentInstanceId))?.weighting ?? "none");
  // A link's words describe its target (they count there as anchor text):
  // on the page that carries the link they count reduced.
  const sections = sectionsOf(
    facts,
    (t) => textMayCount(t) && !t.inLink && weighting(t) === "full",
  );
  const reduced = sectionsOf(
    facts,
    (t) => textMayCount(t) && (weighting(t) === "reduced" || (t.inLink && weighting(t) === "full")),
  );
  const terms = Object.entries(facts.terms).flatMap(([list, ids]) =>
    ids.map((id) => `${list}:${id}`),
  );
  return {
    id: facts.pageId,
    lang: facts.lang || "und",
    values: {
      title: facts.title,
      short_title: facts.shortTitle ?? "",
      description: facts.metaDescription ?? "",
      breadcrumb: facts.breadcrumb.join(" › "),
      sections,
      reduced,
      url: facts.path,
      page_type: facts.pageType ?? "",
      terms,
    },
  };
}

/** One link text to a page of the site. */
export interface AnchorDoc extends CollectionDocInput {
  readonly values: {
    readonly text: string;
    readonly target: string;
    readonly source: string;
    readonly sources: number;
  };
}

/**
 * A navigation block's state in the anchors collection: one document per
 * block, without text (it never matches a search), that carries the digest
 * of the block's link set. It shares the block's source, so every
 * replacement of the block's links rewrites it in the same change, and a
 * change discarded with a failed Stage takes it along: what the index holds
 * is always what the next Stage compares against (#1666).
 */
export interface BlockDoc extends CollectionDocInput {
  readonly values: {
    readonly text: "";
    readonly target: "";
    readonly source: string;
    readonly sources: 0;
    readonly block_digest: string;
  };
}

/** The id of a navigation block's state document (anchor ids are `a` + hex). */
export function blockDocId(moduleId: string): string {
  return `b:${moduleId}`;
}

/** A navigation block's state document for its link set's digest. */
export function blockDocument(moduleId: string, digest: string): BlockDoc {
  return {
    id: blockDocId(moduleId),
    lang: "und",
    values: { text: "", target: "", source: `m:${moduleId}`, sources: 0, block_digest: digest },
  };
}

/** Folds a link text for identity: case, spacing and punctuation at the ends. */
export function normalizeAnchorText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .slice(0, 200);
}

/** A short stable id (FNV-1a, 64 bits as hex) for an anchor document. */
export function anchorId(source: string, target: string, text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of `${source}\u0000${target}\u0000${text}`) {
    h ^= BigInt(ch.codePointAt(0) ?? 0);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `a${h.toString(16).padStart(16, "0")}`;
}

/** The anchor source of a link: its chrome module, or the page it sits on. */
export function anchorSource(link: PageOutputFacts["links"][number], pageId: string): string {
  return link.zone === "layout" && link.moduleId ? `m:${link.moduleId}` : `p:${pageId}`;
}

/**
 * The anchor documents of a page's links: every link to another page of
 * the site with words, chrome links only when they describe their targets.
 * `placementOf` gives a chrome module's placement count (its weight).
 */
export function anchorDocuments(
  facts: PageOutputFacts,
  opts: {
    readonly chromeLinks: boolean;
    readonly placementOf: (moduleId: string) => number;
  },
): AnchorDoc[] {
  const out = new Map<string, AnchorDoc>();
  for (const link of facts.links) {
    if (!link.targetPageId || link.pluginSlug !== null) continue;
    const text = normalizeAnchorText(link.text);
    if (text.length < 2) continue;
    const chrome = link.zone === "layout" && link.moduleId !== null;
    if (chrome && !opts.chromeLinks) continue;
    // A page's own link to itself says nothing about it. A navigation
    // block's is one of the block's links like the others: they are the
    // same on every page, so each page must yield the block's whole set,
    // or one page's delivery would drop the link to that page.
    if (!chrome && link.targetPageId === facts.pageId) continue;
    const source = anchorSource(link, facts.pageId);
    const id = anchorId(source, link.targetPageId, text);
    out.set(id, {
      id,
      lang: facts.lang || "und",
      values: {
        text: link.text.replace(/\s+/g, " ").trim().slice(0, 200),
        target: link.targetPageId,
        source,
        sources: chrome ? Math.max(1, opts.placementOf(link.moduleId as string)) : 1,
      },
    });
  }
  return [...out.values()];
}
