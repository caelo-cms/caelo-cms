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

/** A module as the structure check needs it. */
export interface StructureModule {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  /** The template body, Mustache tags included. */
  readonly html: string;
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
  readonly classUse: ReadonlyMap<string, ClassUse>;
  /** Module id → the pages it is rendered on. */
  readonly placements: ReadonlyMap<string, ReadonlySet<string>>;
  /** Module id → its template's root shape (patterns only matter). */
  readonly templateShapes: ReadonlyMap<string, SubtreeShape>;
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

  const occurrences: PatternOccurrence[] = [];
  const siblingRepeats: SiblingRepeat[] = [];
  const classUse = new Map<string, ClassUse>();
  const placements = new Map<string, Set<string>>();
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
    for (const root of moduleRoots(roots)) {
      const id = root.moduleId as string;
      let onPages = placements.get(id);
      if (!onPages) {
        onPages = new Set();
        placements.set(id, onPages);
      }
      onPages.add(page.pageId);
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
  return { occurrences, siblingRepeats, classUse, placements, templateShapes };
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
