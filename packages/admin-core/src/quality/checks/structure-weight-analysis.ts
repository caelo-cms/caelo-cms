// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1371 — the pure measurements behind the page-weight rules
 * (structure-weight.ts, structure-css.ts): how many elements each part of
 * a staged page builds, which classes it renders, and how often one list's
 * entries are rendered on it.
 *
 * Element counts follow the browser, not the pattern parser: the shared
 * `parseMarkup` treats an inline `<svg>` as one leaf (its inside is no
 * markup pattern), but every `<path>` of it is an element the first layout
 * builds, so this pass reads the page with htmlparser2 itself and counts
 * them. The contents of a `<template>` are not in the DOM until a script
 * clones them (a consent-withheld module), so they are not counted — their
 * classes still count as rendered, because the module shows them once the
 * visitor agrees.
 *
 * Parts: each OUTERMOST module root (`data-caelo-module-id`; its nested
 * sub-modules count toward it, because the frame module brings them on
 * every page), each plugin output outside modules (`data-caelo-plugin`,
 * a consent banner), and the layout / template markup around them.
 */

import type { MarkupNode } from "@caelo-cms/shared";
import { Parser } from "htmlparser2";

/** Part key of the layout and template markup outside modules and plugin output. */
export const LAYOUT_PART = "layout";

/** One part's weight on one page. */
export interface PartWeight {
  /** Elements the part builds, inline SVG children included. */
  elements: number;
  /** Of those, elements inside inline `<svg>` (the svg element included). */
  svg: number;
}

/** What one staged page weighs. */
export interface PageWeight {
  readonly pageId: string;
  readonly path: string;
  /** `module:<id>`, `plugin:<slug>` or {@link LAYOUT_PART} → its weight. */
  readonly parts: ReadonlyMap<string, PartWeight>;
}

/**
 * Measure one page's body (the whole document when it has no `<body>`).
 * `classes` is every class an element of the page carries, template
 * contents included; callers fold it and drop it, so a 50k-page audit
 * never holds every page's class set at once (epic #1003).
 */
export function measurePage(
  pageId: string,
  path: string,
  html: string,
): { weight: PageWeight; classes: Set<string> } {
  const parts = new Map<string, PartWeight>();
  const classes = new Set<string>();
  const hasBody = /<body[\s>]/i.test(html);
  // One frame per open element: the part it belongs to and whether it is
  // inside an svg / a template. A void element opens and closes at once.
  const stack: { part: string; svg: boolean; template: boolean }[] = [];
  let inBody = !hasBody;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        const parent = stack[stack.length - 1];
        if (tag === "body") inBody = true;
        for (const c of (attribs.class ?? "").split(/\s+/)) if (c.length > 0) classes.add(c);
        let part = parent?.part ?? LAYOUT_PART;
        if (part === LAYOUT_PART) {
          const moduleId = attribs["data-caelo-module-id"];
          const plugin = attribs["data-caelo-plugin"];
          if (moduleId) part = `module:${moduleId}`;
          else if (plugin) part = `plugin:${plugin}`;
        }
        const template = (parent?.template ?? false) || tag === "template";
        const svg = (parent?.svg ?? false) || tag === "svg";
        const counted = inBody && tag !== "body" && !(parent?.template ?? false);
        if (counted) {
          const w = parts.get(part) ?? { elements: 0, svg: 0 };
          w.elements++;
          if (svg) w.svg++;
          parts.set(part, w);
        }
        stack.push({ part, svg, template });
      },
      onclosetag(name) {
        stack.pop();
        if (name.toLowerCase() === "body") inBody = false;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  return { weight: { pageId, path, parts }, classes };
}

/** How often one list was rendered on one page. */
export interface ListRender {
  readonly pageId: string;
  readonly path: string;
  /**
   * The list: `shared:<listId>` for a shared list, `local:<moduleId>:<field>`
   * for a module's local list (default or instance value).
   */
  readonly list: string;
  /** Renders on the page: the per-module counts summed. */
  readonly renders: number;
  /** Module id → its renders of the list on the page (see {@link repeatedListRenders}). */
  readonly byModule: ReadonlyMap<string, number>;
  /** Module id → the most renders of the list inside ONE of its roots (a desktop + mobile copy = 2). */
  readonly inOneRoot: ReadonlyMap<string, number>;
}

// `<listId>/<itemId>` — a shared list's entry stamp (docs/lists.md §13).
const SHARED_STAMP_RE = /^([0-9a-f-]{36})\/[0-9a-f-]{36}$/i;

/**
 * The list a stamp belongs to, or null for an unknown form. Local stamps
 * are `local/<field>/<itemId>` and `instance/<contentInstanceId>/<field>/<itemId>`.
 */
function stampList(stamp: string, moduleId: string): string | null {
  const shared = SHARED_STAMP_RE.exec(stamp);
  if (shared) return `shared:${shared[1]}`;
  const parts = stamp.split("/");
  if (parts[0] === "local" && parts.length === 3) return `local:${moduleId}:${parts[1]}`;
  if (parts[0] === "instance" && parts.length === 4) return `local:${moduleId}:${parts[2]}`;
  return null;
}

/**
 * Lists rendered more than once on one page (`roots` = the parsed page).
 *
 * Per module root (nested roots are their own), a list's render count is
 * the highest count of any one entry stamp in it: a mega menu's child
 * entries appear once per render like its top entries, so the maximum is
 * the number of copies, whatever the list's depth.
 *
 * Per module, OUTERMOST roots add up (a module placed twice on a page
 * writes the list twice), while NESTED roots of one module count with
 * their highest: one card module repeated as ten entries of a module-list
 * is one design shown ten times, not one list copied ten times (and local
 * default entries share their stamps across those cards). Only lists
 * rendered twice or more are returned.
 */
export function repeatedListRenders(
  pageId: string,
  path: string,
  roots: readonly MarkupNode[],
): ListRender[] {
  // list → module → renders summed over outermost roots / highest over nested roots / highest in one root.
  const outer = new Map<string, Map<string, number>>();
  const nested = new Map<string, Map<string, number>>();
  const single = new Map<string, Map<string, number>>();
  const bump = (
    target: Map<string, Map<string, number>>,
    list: string,
    moduleId: string,
    count: number,
    combine: (a: number, b: number) => number,
  ) => {
    const byModule = target.get(list) ?? new Map<string, number>();
    byModule.set(moduleId, combine(byModule.get(moduleId) ?? 0, count));
    target.set(list, byModule);
  };
  const visitRoot = (root: MarkupNode, isNested: boolean) => {
    const moduleId = root.moduleId as string;
    const counts = new Map<string, number>();
    const walk = (n: MarkupNode) => {
      if (n !== root && n.moduleId !== null) {
        visitRoot(n, true);
        return;
      }
      if (n.listItem !== null) counts.set(n.listItem, (counts.get(n.listItem) ?? 0) + 1);
      for (const c of n.children) walk(c);
    };
    walk(root);
    const inRoot = new Map<string, number>();
    for (const [stamp, count] of counts) {
      const list = stampList(stamp, moduleId);
      if (list !== null) inRoot.set(list, Math.max(inRoot.get(list) ?? 0, count));
    }
    for (const [list, count] of inRoot) {
      if (isNested) bump(nested, list, moduleId, count, Math.max);
      else bump(outer, list, moduleId, count, (a, b) => a + b);
      bump(single, list, moduleId, count, Math.max);
    }
  };
  const findRoots = (n: MarkupNode) => {
    if (n.moduleId !== null) visitRoot(n, false);
    else for (const c of n.children) findRoots(c);
  };
  for (const r of roots) findRoots(r);
  const out: ListRender[] = [];
  for (const [list, inOneRoot] of single) {
    const byModule = new Map<string, number>();
    for (const id of inOneRoot.keys())
      byModule.set(id, (outer.get(list)?.get(id) ?? 0) + (nested.get(list)?.get(id) ?? 0));
    const renders = [...byModule.values()].reduce((a, b) => a + b, 0);
    if (renders >= 2) out.push({ pageId, path, list, renders, byModule, inOneRoot });
  }
  return out;
}
