// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — the pure analysis behind the core `structure` check: read
 * the staged pages, attribute every element to the module template that
 * rendered it or to the free markup a field value injected, and collect
 * the patterns and class usage the rules judge (structure.ts).
 *
 * The staged HTML is the truth (it is what Publish live ships); the module
 * templates only say which parts of a module's output are the template's
 * own and which came in through a field value. Every module root carries
 * `data-caelo-module-id` (module-id-tag.ts tagModuleId) — page placements
 * via the composer, sub-modules in `module` / `module-list` fields via the
 * nested renderer (#1027) — so the walk needs no other mapping: each root,
 * nested ones included, is checked against its own template, and a parent
 * skips its nested roots.
 *
 * Link groups (epic #1107): per module root, the links it carries as its
 * own data — entries of its LOCAL lists (`data-caelo-list-item`
 * `instance/…` / `local/…`) and links hand-written in free markup. Links
 * of a SHARED list's entries (`<listId>/<itemId>`) are excluded: two
 * modules showing one shared list is the goal, not a copy. Links of
 * generated entries (queries, system sources) carry no stamp and sit in
 * the template's own markup, so they never count either.
 *
 * Listing links (#1256, structure-listing-links.ts): per OUTERMOST module
 * root, every internal link the page keeps by hand — the link groups'
 * links plus those of nested card modules and template-owned scalar
 * fields (`card1_href`) — resolved to site paths. A separate collection,
 * so `duplicate-navigation` keeps its meaning.
 */

import {
  freeRegions,
  type MarkupNode,
  moduleRoots,
  outermostPatterns,
  parseMarkup,
  patternLabel,
  repeatedSiblingPatterns,
  type SubtreeShape,
  shapeTree,
  stripMustache,
} from "@caelo-cms/shared";
import type { StagedPage } from "./check.js";
import {
  type ListingLinkGroup,
  listingLinkGroups,
  listingTemplates,
} from "./structure-listing-links.js";

/** A module as the structure check needs it. */
export interface StructureModule {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  /** The template body, Mustache tags included. */
  readonly html: string;
  /** The module's script (#1198: whose markup it drives, whether it builds content). */
  readonly js: string;
  /**
   * Names of its `list` and `module-list` fields (#1256): a section over
   * one of them renders entries, any other section is a condition.
   */
  readonly listFields: readonly string[];
  /** Names of all its declared fields (#1256): a section over none of them is generated. */
  readonly fieldNames: readonly string[];
}

/** A pattern found in free markup on one page. */
export interface PatternOccurrence {
  readonly pageId: string;
  readonly path: string;
  /** The module whose field value carried it. */
  readonly hostModuleId: string;
  readonly label: string;
  readonly shape: SubtreeShape;
}

/** A pattern written out side by side in one module's free markup (#1068). */
export interface SiblingRepeat {
  readonly pageId: string;
  readonly path: string;
  /** The module whose field value carried the copies. */
  readonly hostModuleId: string;
  readonly label: string;
  /** Copies side by side. */
  readonly count: number;
}

/** The links one module root carries as its own data on one page (epic #1107). */
export interface LinkGroup {
  readonly pageId: string;
  readonly path: string;
  readonly moduleId: string;
  /** Distinct hrefs as rendered, sorted. */
  readonly hrefs: readonly string[];
}

/** Fewer links than this are no navigation worth sharing (a CTA pair, a logo link). */
export const MIN_LINK_GROUP = 3;

/** Where a CSS class is used across the staged pages. */
export interface ClassUse {
  /** Modules whose TEMPLATE renders it. */
  readonly modules: Set<string>;
  /** Modules whose free markup (field values) carries it. */
  readonly freeIn: Set<string>;
  /** Used by the layout's own chrome, outside every module. */
  chrome: boolean;
}

export interface StructureAnalysis {
  readonly occurrences: readonly PatternOccurrence[];
  readonly siblingRepeats: readonly SiblingRepeat[];
  readonly linkGroups: readonly LinkGroup[];
  /** Hand-kept internal links per outermost module root (#1256). */
  readonly listingGroups: readonly ListingLinkGroup[];
  readonly classUse: ReadonlyMap<string, ClassUse>;
  /** Module id → the pages it is rendered on. */
  readonly placements: ReadonlyMap<string, ReadonlySet<string>>;
  /** Module id → its template's root shape (patterns only matter). */
  readonly templateShapes: ReadonlyMap<string, SubtreeShape>;
  /** Module id → the modules rendered inside its roots, at any depth (#1198). */
  readonly nested: ReadonlyMap<string, ReadonlySet<string>>;
}

interface ParsedModule {
  readonly module: StructureModule;
  readonly template: MarkupNode[];
}

/** Analyse every staged page against the module templates. */
export function analyseStructure(
  pages: readonly StagedPage[],
  modules: readonly StructureModule[],
): StructureAnalysis {
  const parsed = new Map<string, ParsedModule>();
  const templateShapes = new Map<string, SubtreeShape>();
  for (const m of modules) {
    const template = parseMarkup(stripMustache(m.html));
    parsed.set(m.id, { module: m, template });
    const root = template[0];
    const shape = root ? shapeTree(root).get(root) : undefined;
    if (shape) templateShapes.set(m.id, shape);
  }

  const listing = listingTemplates(modules);
  const listingGroups: ListingLinkGroup[] = [];
  const occurrences: PatternOccurrence[] = [];
  const siblingRepeats: SiblingRepeat[] = [];
  const linkGroups: LinkGroup[] = [];
  const classUse = new Map<string, ClassUse>();
  const placements = new Map<string, Set<string>>();
  const nested = new Map<string, Set<string>>();
  const use = (cls: string): ClassUse => {
    let u = classUse.get(cls);
    if (!u) {
      u = { modules: new Set(), freeIn: new Set(), chrome: false };
      classUse.set(cls, u);
    }
    return u;
  };

  for (const page of pages) {
    const roots = parseMarkup(page.html);
    markChrome(roots, (cls) => {
      use(cls).chrome = true;
    });
    listingGroups.push(...listingLinkGroups(page, roots, listing));
    for (const root of moduleRoots(roots)) {
      const id = root.moduleId as string;
      let onPages = placements.get(id);
      if (!onPages) {
        onPages = new Set();
        placements.set(id, onPages);
      }
      onPages.add(page.pageId);
      const inside = nested.get(id) ?? new Set<string>();
      nestedModuleIds(root, inside);
      nested.set(id, inside);
      const mod = parsed.get(id);
      if (!mod) continue;
      const free = freeRegions(root, mod.template);
      const freeSet = new Set(free ?? []);
      walkModule(root, freeSet, (cls, inFree) => {
        if (inFree) use(cls).freeIn.add(id);
        else use(cls).modules.add(id);
      });
      for (const p of outermostPatterns(free ?? [])) {
        occurrences.push({
          pageId: page.pageId,
          path: page.path,
          hostModuleId: id,
          label: patternLabel(p.node),
          shape: p.shape,
        });
      }
      const hrefs = ownLinks(root, freeSet);
      if (hrefs.length >= MIN_LINK_GROUP) {
        linkGroups.push({ pageId: page.pageId, path: page.path, moduleId: id, hrefs });
      }
      for (const r of repeatedSiblingPatterns(free ?? [])) {
        siblingRepeats.push({
          pageId: page.pageId,
          path: page.path,
          hostModuleId: id,
          label: patternLabel(r.node),
          count: r.count,
        });
      }
    }
  }
  return {
    occurrences,
    siblingRepeats,
    linkGroups,
    listingGroups,
    classUse,
    placements,
    templateShapes,
    nested,
  };
}

/** Adds the module ids of every root nested inside `root` (at any depth). */
function nestedModuleIds(root: MarkupNode, out: Set<string>): void {
  const walk = (n: MarkupNode) => {
    if (n !== root && n.moduleId !== null) out.add(n.moduleId);
    for (const c of n.children) walk(c);
  };
  walk(root);
}

// `<listId>/<itemId>` — a shared list's entry stamp.
const SHARED_ENTRY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;

/**
 * The hrefs a module root carries as its own data (see the file header):
 * links inside its local list entries or its free markup, not inside a
 * shared list's entry, nested module roots skipped.
 */
function ownLinks(root: MarkupNode, freeSet: ReadonlySet<MarkupNode>): string[] {
  const out = new Set<string>();
  const walk = (n: MarkupNode, local: boolean, free: boolean, shared: boolean) => {
    if (n !== root && n.moduleId !== null) return;
    const item = n.listItem;
    const inShared = shared || (item !== null && SHARED_ENTRY_RE.test(item));
    const inLocal =
      local || (item !== null && (item.startsWith("instance/") || item.startsWith("local/")));
    const inFree = free || freeSet.has(n);
    const href = n.href?.trim() ?? "";
    if (
      n.tag === "a" &&
      href.length > 0 &&
      !href.startsWith("#") &&
      !/^javascript:/i.test(href) &&
      !inShared &&
      (inLocal || inFree)
    ) {
      out.add(href);
    }
    for (const c of n.children) walk(c, inLocal, inFree, inShared);
  };
  walk(root, false, false, false);
  return [...out].sort();
}

/** Classes on elements outside every module root (the layout's own markup). */
function markChrome(roots: readonly MarkupNode[], mark: (cls: string) => void): void {
  const walk = (n: MarkupNode) => {
    if (n.moduleId !== null) return;
    for (const c of n.classes) mark(c);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
}

/** Classes inside one module root, split into template-owned and free. */
function walkModule(
  root: MarkupNode,
  freeSet: ReadonlySet<MarkupNode>,
  mark: (cls: string, inFree: boolean) => void,
): void {
  const walk = (n: MarkupNode, inFree: boolean) => {
    if (n !== root && n.moduleId !== null) return;
    const free = inFree || freeSet.has(n);
    for (const c of n.classes) mark(c, free);
    for (const c of n.children) walk(c, free);
  };
  walk(root, false);
}

/**
 * The class names a stylesheet's selectors reference. Comments, strings
 * and `url(…)` bodies are removed first so `url(a.png)` is no class.
 */
export function selectorClasses(css: string): Set<string> {
  const cleaned = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\([^)]*\)/gi, "")
    .replace(/"[^"]*"|'[^']*'/g, "");
  const out = new Set<string>();
  // Only selector text: within each `}`-delimited chunk, every segment
  // before the last `{` is a selector or an at-rule prelude (`@media …{
  // .a{`); the last one is declarations, where `1.5rem` must not count.
  for (const part of cleaned.split("}")) {
    const segments = part.split("{");
    for (const selector of segments.slice(0, -1)) {
      for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        if (m[1]) out.add(m[1]);
      }
    }
  }
  return out;
}
