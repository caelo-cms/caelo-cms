// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1256 — the links a page keeps BY HAND, per outermost module root:
 * the input of `structure/manual-page-listing` (structure-listing.ts).
 *
 * An overview page built as cards is caught only if every way of writing
 * the cards counts, and the right way never does:
 *
 * - counted: entries of a LOCAL list (`data-caelo-list-item`
 *   `instance/…` / `local/…`), links in free markup (field values), links
 *   in template-owned scalar fields (`<a href="{{card1_href}}">`), and all
 *   of these inside nested modules — a `module-list` of card modules is
 *   one listing of the module that holds it;
 * - never counted: entries of a SHARED list (`<listId>/<itemId>`: menus),
 *   entries a source generates (a page query, `children`, `term_pages`, a
 *   source node's `items`, a plugin source such as a language switcher)
 *   and the page's own term loops (`page.…`).
 *
 * Stored entries carry the stamp, generated ones do not, and a scalar link
 * carries none either. What tells a scalar link from a generated entry is
 * the template: a link inside a section over a `list` / `module-list`
 * field renders per entry; a link inside a section over no declared field
 * (a plugin source, `page.…`) or an entry's reserved `items` loop is
 * generated; a link outside any section, or inside a condition over a
 * declared field, is the template's own. So each rendered
 * node is matched to the template node that rendered it — the template
 * parsed with its sections kept as marker elements (`stripMustache`
 * `markSections`). When a rendered node could come from a list section or
 * from a scalar spot, the list section wins: an unstamped link then does
 * not count, so a source binding is never mistaken for hand-kept cards.
 */

import { type MarkupNode, parseMarkup, SECTION_MARKER_TAG, stripMustache } from "@caelo-cms/shared";
import type { StagedPage } from "./check.js";
import type { StructureModule } from "./structure-analysis.js";

/** The hand-kept internal links of one outermost module root on one page. */
export interface ListingLinkGroup {
  readonly pageId: string;
  readonly moduleId: string;
  /**
   * Distinct http(s) targets, resolved against the page URL, without
   * query or fragment, sorted. Which hosts are the site is decided by the
   * rule (the staged origin AND the public domains, structure-listing.ts).
   */
  readonly targets: readonly string[];
}

/** Fewer hand-kept links than this are never a listing (a CTA pair). */
export const MIN_LISTING_LINKS = 3;

/** Where a template node sits: the template's own, a stored entry, generated. */
type Kind = "scalar" | "list" | "generated";

/** The nearest list entry stamp above a rendered node. */
type Entry = "none" | "own" | "shared";

/** A module's declared field names: all of them, and its list-like ones. */
interface FieldNames {
  readonly all: ReadonlySet<string>;
  readonly list: ReadonlySet<string>;
}

interface ListingTemplate {
  readonly root: MarkupNode;
  readonly rootKind: Kind;
  readonly fields: FieldNames;
}

// `<listId>/<itemId>` — a shared list's entry stamp.
const SHARED_ENTRY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;

/** Parse every module template once, sections kept as markers. */
export function listingTemplates(
  modules: readonly StructureModule[],
): ReadonlyMap<string, ListingTemplate> {
  const out = new Map<string, ListingTemplate>();
  for (const m of modules) {
    const fields = { all: new Set(m.fieldNames), list: new Set(m.listFields) };
    const forest = parseMarkup(stripMustache(m.html, { markSections: true }));
    const first = flatten(forest, "scalar", fields, false)[0];
    if (first) out.set(m.id, { root: first.node, rootKind: first.kind, fields });
  }
  return out;
}

/**
 * The listing link groups of one staged page: one per outermost module
 * root with at least {@link MIN_LISTING_LINKS} same-site targets.
 */
export function listingLinkGroups(
  page: StagedPage,
  roots: readonly MarkupNode[],
  templates: ReadonlyMap<string, ListingTemplate>,
): ListingLinkGroup[] {
  let base: URL;
  try {
    base = documentBase(page.url, roots);
  } catch {
    return [];
  }
  const out: ListingLinkGroup[] = [];
  const walk = (n: MarkupNode) => {
    if (n.moduleId !== null) {
      const hrefs = new Set<string>();
      collectModule(n, templates, hrefs);
      const targets = new Set<string>();
      for (const href of hrefs) {
        const key = absoluteTarget(href, base);
        if (key !== null) targets.add(key);
      }
      if (targets.size >= MIN_LISTING_LINKS) {
        out.push({ pageId: page.pageId, moduleId: n.moduleId, targets: [...targets].sort() });
      }
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/**
 * The URL relative links resolve against: the first `<base href>`, resolved
 * against the page URL (as a browser does), else the page URL. Throws when
 * the page URL itself does not parse.
 */
function documentBase(pageUrl: string, roots: readonly MarkupNode[]): URL {
  const page = new URL(pageUrl);
  const find = (n: MarkupNode): string | null => {
    if (n.tag === "base" && n.href !== null) return n.href;
    for (const c of n.children) {
      const found = find(c);
      if (found !== null) return found;
    }
    return null;
  };
  for (const r of roots) {
    const href = find(r);
    if (href === null) continue;
    try {
      return new URL(href, page);
    } catch {
      return page;
    }
  }
  return page;
}

/** The http(s) URL a link leads to without query or fragment, or null (fragment only, other scheme). */
function absoluteTarget(href: string, base: URL): string | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
}

/** Adds the hand-kept hrefs of one module root (nested modules included). */
function collectModule(
  root: MarkupNode,
  templates: ReadonlyMap<string, ListingTemplate>,
  out: Set<string>,
): void {
  const tpl = root.moduleId === null ? undefined : templates.get(root.moduleId);
  // A root its template does not render (a module the composer fills from
  // other data) cannot be attributed: nothing in it counts.
  if (!tpl || !accounts(tpl.root, root)) return;
  const visit = (r: MarkupNode, t: MarkupNode | null, kind: Kind, entryAbove: Entry) => {
    const entry = entryOf(r, entryAbove);
    if (r.tag === "a" && r.href !== null && counts(kind, entry)) out.add(r.href);
    for (const c of r.children) {
      if (c.moduleId !== null) {
        // A nested module (module / module-list field) is stored content,
        // part of this listing — unless a shared or generated entry renders it.
        if (kind !== "generated" && entryOf(c, entry) !== "shared") {
          collectModule(c, templates, out);
        }
        continue;
      }
      if (t === null) {
        visit(c, null, kind, entry);
        continue;
      }
      const match = pickTemplateChild(c, flatten(t.children, kind, tpl.fields, false));
      // A module-level list iterated inside an entry starts its own
      // entries: they never borrow the enclosing entry's stamp.
      visit(c, match?.node ?? null, match?.kind ?? kind, match?.reset ? "none" : entry);
    }
  };
  visit(root, tpl.root, tpl.rootKind, "none");
}

/** Shared entries and generated links never count; list links only in a stored entry. */
function counts(kind: Kind, entry: Entry): boolean {
  if (entry === "shared" || kind === "generated") return false;
  return kind === "scalar" || entry === "own";
}

function entryOf(n: MarkupNode, above: Entry): Entry {
  const stamp = n.listItem;
  if (stamp === null || above === "shared") return above;
  if (SHARED_ENTRY_RE.test(stamp)) return "shared";
  if (stamp.startsWith("instance/") || stamp.startsWith("local/")) return "own";
  return above;
}

interface Candidate {
  readonly node: MarkupNode;
  readonly kind: Kind;
  /** Rendered inside a new iteration nested in an entry (see {@link sectionKind}). */
  readonly reset: boolean;
}

/**
 * Template children with section markers dissolved: each element carries
 * the kind of the innermost section around it.
 */
function flatten(
  nodes: readonly MarkupNode[],
  kind: Kind,
  fields: FieldNames,
  reset: boolean,
): Candidate[] {
  const out: Candidate[] = [];
  for (const n of nodes) {
    if (n.tag !== SECTION_MARKER_TAG) {
      out.push({ node: n, kind, reset });
      continue;
    }
    const inner = sectionKind(n, kind, fields);
    out.push(...flatten(n.children, inner.kind, fields, reset || inner.boundary));
  }
  return out;
}

/**
 * The kind inside a section marker (`s:<name>` iterates or tests, `i:<name>`
 * is inverted), and whether it starts a new iteration inside an entry.
 *
 * At module scope a section names a declared field — a `list` /
 * `module-list` field iterates stored or bound entries, any other field is
 * a condition — or a value the engine provides: `page.terms.…` iterates
 * the page's terms (generated); other `page.…`, `site_text.…` and the
 * `is_` / `has_` / `count_` flags are conditions. Any other name is a
 * plugin source (`{{#language_links}}`): generated.
 *
 * Inside an entry, `items` is a source node's generated entries (a reserved
 * name, never an entry field). A module-level list field iterated inside an
 * entry is a new iteration (`boundary`): its entries carry their own stamp
 * or none, never the enclosing entry's.
 */
function sectionKind(
  marker: MarkupNode,
  outer: Kind,
  fields: FieldNames,
): { readonly kind: Kind; readonly boundary: boolean } {
  const cls = marker.classes[0] ?? "";
  const same = { kind: outer, boundary: false };
  if (!cls.startsWith("s:") || outer === "generated") return same;
  const name = cls.slice(2);
  if (name.startsWith("page.terms")) return { kind: "generated", boundary: false };
  if (isCondition(name)) return same;
  if (outer === "scalar") {
    if (fields.list.has(name)) return { kind: "list", boundary: false };
    return fields.all.has(name) ? same : { kind: "generated", boundary: false };
  }
  if (name === "items") return { kind: "generated", boundary: false };
  return fields.list.has(name) ? { kind: "list", boundary: true } : same;
}

/** Engine-provided values that only test truthiness (never iterate entries). */
function isCondition(name: string): boolean {
  return name.startsWith("page.") || name.startsWith("site_text.") || /^(is|has|count)_/.test(name);
}

/**
 * The template node that rendered `c`: the exact class set first, then the
 * most classes in common, then the per-entry kinds (see the file header),
 * then template order.
 */
function pickTemplateChild(c: MarkupNode, candidates: readonly Candidate[]): Candidate | null {
  const weight = { generated: 2, list: 1, scalar: 0 } as const;
  let best: { readonly cand: Candidate; readonly rank: readonly number[] } | null = null;
  for (const cand of candidates) {
    if (!accounts(cand.node, c)) continue;
    const rank = [
      cand.node.classes.length === c.classes.length ? 1 : 0,
      cand.node.classes.length,
      weight[cand.kind],
    ];
    if (!best || outranks(rank, best.rank)) best = { cand, rank };
  }
  return best?.cand ?? null;
}

function outranks(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function accounts(template: MarkupNode, rendered: MarkupNode): boolean {
  return (
    template.tag === rendered.tag && template.classes.every((k) => rendered.classes.includes(k))
  );
}
