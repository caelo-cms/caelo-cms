// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — structural fingerprints of HTML, for telling "this markup is
 * a reusable pattern that already exists elsewhere" from one-off content.
 *
 * Free HTML (a step chain, a comparison table, a timeline pasted into a
 * richtext value, or minted as a one-off module per page) is cheap to
 * write and expensive to keep: every copy is edited separately, the copies
 * drift, and the pattern's CSS has to live in the layout where it ships on
 * every page. The fix is to make the second copy a module. This file gives
 * the write-time guard and the core `structure` quality check one shared
 * notion of "the same markup":
 *
 * - A node's SIGNATURE is its tag plus sorted class tokens plus the
 *   signatures of its distinct children (first-occurrence order). Text,
 *   attribute values and repetition are ignored, so a 5-step chain and a
 *   7-step chain with different copy are the same pattern.
 * - A subtree QUALIFIES as a pattern when it is big enough to be a
 *   component (MIN_PATTERN_NODES distinct nodes over MIN_PATTERN_DEPTH
 *   levels) and carries at least one class. Prose converted from Markdown
 *   (`<ul><li><a>`, plain tables) has no classes and never qualifies; an
 *   authored component always has them.
 * - SIMILARITY is the Jaccard index over parent→child edges, for near
 *   matches that are not exact (a pattern with one extra element).
 *
 * The site importer's boilerplate walker (site-importer/boilerplate.ts)
 * stays separate on purpose: it streams byte ranges, hashes text into a
 * content signature, and its signatures are persisted and replayed
 * (#424), so its output must stay byte-stable.
 *
 * Every walk is bounded (MAX_NODES) so an adversarial body cannot blow it up.
 */

import { Parser } from "htmlparser2";

/** One element of parsed markup. Text is dropped; it never matters here. */
export interface MarkupNode {
  readonly tag: string;
  readonly classes: readonly string[];
  /** The `data-caelo-module-id` the composer stamps on every module root. */
  readonly moduleId: string | null;
  readonly children: MarkupNode[];
  readonly parent: MarkupNode | null;
}

/** Most elements one parse keeps; the rest of the document is ignored. */
export const MAX_NODES = 50_000;
/** A pattern has at least this many distinct nodes… */
export const MIN_PATTERN_NODES = 4;
/** …spread over at least this many levels (root, child, grandchild). */
export const MIN_PATTERN_DEPTH = 3;
/** Jaccard similarity at or above which two patterns are "near" matches. */
export const NEAR_MATCH_THRESHOLD = 0.8;

/** Elements whose inside is not markup structure (icons, raw text). */
const LEAF_TAGS = new Set(["svg", "math", "script", "style", "noscript", "iframe"]);

/** Parse markup into a forest of element nodes. */
export function parseMarkup(html: string): MarkupNode[] {
  const roots: MarkupNode[] = [];
  const stack: (MarkupNode | null)[] = [];
  let count = 0;
  let leafDepth = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (leafDepth > 0 || count >= MAX_NODES) {
          stack.push(null);
          if (leafDepth > 0) leafDepth++;
          return;
        }
        const tag = name.toLowerCase();
        const parent = findOpen(stack);
        const node: MarkupNode = {
          tag,
          classes: splitClasses(attribs.class),
          moduleId: attribs["data-caelo-module-id"] ?? null,
          children: [],
          parent,
        };
        count++;
        if (parent) parent.children.push(node);
        else roots.push(node);
        stack.push(node);
        if (LEAF_TAGS.has(tag)) leafDepth = 1;
      },
      onclosetag() {
        stack.pop();
        if (leafDepth > 0) leafDepth--;
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return roots;
}

function findOpen(stack: readonly (MarkupNode | null)[]): MarkupNode | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = stack[i];
    if (n) return n;
  }
  return null;
}

function splitClasses(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/\s+/).filter((c) => c.length > 0))].sort();
}

/**
 * Remove Mustache tags (`{{x}}`, `{{{x}}}`, `{{#s}}`, `{{/s}}`, `{{>p}}`)
 * from a module template so it parses as the markup it renders: a section
 * body stays once, a placeholder becomes empty.
 */
export function stripMustache(template: string): string {
  return stripDelimited(stripDelimited(template, 3), 2);
}

/**
 * Removes every `{`×n + non-`}` run + `}`×n span, leftmost first — the
 * same result as `replace(/\{{n}[^}]*\}{n}/g, "")`, in linear time. The
 * regex form backtracks quadratically on long `{{{{…` runs in module HTML
 * (CodeQL js/polynomial-redos); here, when the first `}` after an opener
 * does not start the closer, no opener before that `}` can match either
 * (they all hit the same `}`), so the scan resumes there.
 */
function stripDelimited(text: string, n: number): string {
  const opener = "{".repeat(n);
  const closer = "}".repeat(n);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(opener, i);
    if (open < 0) break;
    const brace = text.indexOf("}", open + n);
    if (brace < 0) break;
    if (text.startsWith(closer, brace)) {
      out += text.slice(i, open);
      i = brace + n;
    } else {
      out += text.slice(i, brace);
      i = brace;
    }
  }
  return out + text.slice(i);
}

/** The node's key without its children: `div.card.card--wide`. */
export function nodeKey(n: Pick<MarkupNode, "tag" | "classes">): string {
  return n.classes.length === 0 ? n.tag : `${n.tag}.${n.classes.join(".")}`;
}

/** Structural facts about one subtree. */
export interface SubtreeShape {
  /** Repetition- and text-independent structural signature. */
  readonly signature: string;
  /** Distinct nodes after repetition collapse. */
  readonly nodeCount: number;
  /** Levels, the subtree root counting as 1. */
  readonly depth: number;
  /** Whether any node in it carries a class. */
  readonly hasClass: boolean;
  /** Parent→child edges, for near-match similarity. */
  readonly edges: ReadonlySet<string>;
}

/**
 * Compute the shapes of a subtree and all its descendants in one pass.
 * Nested module roots are opaque: their own module owns them.
 */
export function shapeTree(root: MarkupNode, out = new Map<MarkupNode, SubtreeShape>()) {
  const visit = (n: MarkupNode): SubtreeShape => {
    const seen = new Set<string>();
    const parts: string[] = [];
    let nodeCount = 1;
    let depth = 1;
    let hasClass = n.classes.length > 0;
    const edges = new Set<string>();
    const key = nodeKey(n);
    for (const c of n.children) {
      if (c.moduleId !== null) continue;
      const s = visit(c);
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      parts.push(s.signature);
      nodeCount += s.nodeCount;
      depth = Math.max(depth, s.depth + 1);
      hasClass ||= s.hasClass;
      edges.add(`${key}>${nodeKey(c)}`);
      for (const e of s.edges) edges.add(e);
    }
    const shape: SubtreeShape = {
      signature: parts.length === 0 ? key : `${key}(${parts.join(",")})`,
      nodeCount,
      depth,
      hasClass,
      edges,
    };
    out.set(n, shape);
    return shape;
  };
  visit(root);
  return out;
}

/** Whether a subtree is big and specific enough to count as a pattern. */
export function isPattern(shape: SubtreeShape): boolean {
  return shape.hasClass && shape.nodeCount >= MIN_PATTERN_NODES && shape.depth >= MIN_PATTERN_DEPTH;
}

/** Jaccard similarity of two shapes' edge sets, 0…1. */
export function shapeSimilarity(a: SubtreeShape, b: SubtreeShape): number {
  if (a.signature === b.signature) return 1;
  let shared = 0;
  for (const e of a.edges) if (b.edges.has(e)) shared++;
  const union = a.edges.size + b.edges.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** A qualifying pattern found in a piece of markup. */
export interface FoundPattern {
  readonly node: MarkupNode;
  readonly shape: SubtreeShape;
}

/**
 * The outermost qualifying patterns in a forest: a pattern inside a bigger
 * pattern is part of it and not reported on its own.
 */
export function outermostPatterns(roots: readonly MarkupNode[]): FoundPattern[] {
  const found: FoundPattern[] = [];
  const walk = (n: MarkupNode, shapes: Map<MarkupNode, SubtreeShape>) => {
    const shape = shapes.get(n);
    if (shape && isPattern(shape)) {
      found.push({ node: n, shape });
      return;
    }
    for (const c of n.children) if (c.moduleId === null) walk(c, shapes);
  };
  for (const r of roots) walk(r, shapeTree(r));
  return found;
}

/** The shape of a whole module template (its first element), or null. */
export function templateShape(templateHtml: string): SubtreeShape | null {
  const root = parseMarkup(stripMustache(templateHtml))[0];
  return root ? (shapeTree(root).get(root) ?? null) : null;
}

/**
 * The parts of a rendered module that did NOT come from its template: the
 * markup field values injected (richtext, text). The rendered tree is
 * walked in step with the template tree; a rendered child that no template
 * child can account for (same tag, template's classes all present) starts
 * a free region. List sections still match, because every iteration of a
 * section renders the same template child. Nested module roots
 * (`data-caelo-module-id`) are skipped: their own template accounts for
 * them.
 *
 * Several template children can account for one rendered child — a
 * classless `<div>` accounts for any `<div>` — so the walk picks the best
 * one ({@link pickTemplateChild}), not the first: taking the first paired
 * a classless left column with the classed right column and reported the
 * right column's template markup as free (#1027).
 *
 * @returns the free region roots, or null when the rendered root does not
 * match the template root at all (a module the composer renders from
 * other data, such as a navigation menu) — nothing can be attributed then.
 */
export function freeRegions(
  rendered: MarkupNode,
  templateRoots: readonly MarkupNode[],
): MarkupNode[] | null {
  const tRoot = templateRoots[0];
  if (!tRoot || !accounts(tRoot, rendered)) return null;
  return [...attribute(rendered, tRoot, new Map()).free];
}

/** How one rendered subtree attributes against one template subtree. */
interface Attribution {
  /** The free region roots below the rendered node. */
  readonly free: readonly MarkupNode[];
  /** Elements inside those regions: the cost the best match minimises. */
  readonly freeNodes: number;
}

type AttributionMemo = Map<MarkupNode, Map<MarkupNode, Attribution>>;

/**
 * Attribute the children of `r`, rendered from template node `t`.
 * Memoised per (rendered, template) pair, because the best-match choice
 * evaluates a rendered child against every candidate that accounts for
 * it; each pair is computed once, so the walk stays polynomial.
 */
function attribute(r: MarkupNode, t: MarkupNode, memo: AttributionMemo): Attribution {
  let byTemplate = memo.get(r);
  const hit = byTemplate?.get(t);
  if (hit) return hit;
  const free: MarkupNode[] = [];
  let freeNodes = 0;
  // Template index of the previous rendered child's match: siblings
  // render in template order (a section repeats one child in place).
  let cursor = 0;
  for (const c of r.children) {
    if (c.moduleId !== null) continue;
    const match = pickTemplateChild(c, t.children, cursor, memo);
    if (match) {
      cursor = match.index;
      for (const f of match.attribution.free) free.push(f);
      freeNodes += match.attribution.freeNodes;
    } else {
      free.push(c);
      freeNodes += countNodes(c);
    }
  }
  const out: Attribution = { free, freeNodes };
  if (!byTemplate) {
    byTemplate = new Map();
    memo.set(r, byTemplate);
  }
  byTemplate.set(t, out);
  return out;
}

/**
 * The template child that rendered `c`, among those that account for it:
 *   1. the exact class set wins over a subset (`div.chat.rv` over `div.rv`),
 *   2. then the most classes in common, so a classless template child
 *      wins only when no classed one accounts for `c`,
 *   3. then the one whose subtree leaves the fewest elements unaccounted,
 *   4. then sibling order: at or after the previous match, nearest first.
 */
function pickTemplateChild(
  c: MarkupNode,
  candidates: readonly MarkupNode[],
  cursor: number,
  memo: AttributionMemo,
): { readonly index: number; readonly attribution: Attribution } | null {
  let best: {
    readonly index: number;
    readonly attribution: Attribution;
    readonly rank: readonly number[];
  } | null = null;
  for (const [index, tc] of candidates.entries()) {
    if (!accounts(tc, c)) continue;
    const attribution = attribute(c, tc, memo);
    const rank = [
      tc.classes.length === c.classes.length ? 1 : 0,
      tc.classes.length,
      -attribution.freeNodes,
      index >= cursor ? 1 : 0,
      -Math.abs(index - cursor),
    ];
    if (!best || outranks(rank, best.rank)) best = { index, attribution, rank };
  }
  return best;
}

function outranks(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Elements in a subtree, nested module roots excluded (they are not free). */
function countNodes(n: MarkupNode): number {
  let count = 1;
  for (const c of n.children) if (c.moduleId === null) count += countNodes(c);
  return count;
}

function accounts(template: MarkupNode, rendered: MarkupNode): boolean {
  return (
    template.tag === rendered.tag && template.classes.every((k) => rendered.classes.includes(k))
  );
}

/** Every module root (`data-caelo-module-id`) in a forest, nested ones included. */
export function moduleRoots(roots: readonly MarkupNode[]): MarkupNode[] {
  const out: MarkupNode[] = [];
  const walk = (n: MarkupNode) => {
    if (n.moduleId !== null) out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** A short operator-readable name for a pattern: its root key, e.g. `div.chain`. */
export function patternLabel(p: Pick<MarkupNode, "tag" | "classes">): string {
  return nodeKey(p);
}
