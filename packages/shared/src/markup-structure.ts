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
  /** The `href` attribute (links), as written. */
  readonly href: string | null;
  /**
   * The `data-caelo-list-item` the template engine stamps on a rendered
   * list entry (docs/lists.md §13): `<listId>/<itemId>` for a shared
   * list, `instance/…` / `local/…` for a module's local list.
   */
  readonly listItem: string | null;
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
          href: attribs.href ?? null,
          listItem: attribs["data-caelo-list-item"] ?? null,
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

/** Options of {@link stripMustache}. */
export interface StripMustacheOptions {
  /**
   * Keep the text of a section inside a tag (`class="a {{#s}}b{{/s}}"` →
   * `class="a b"`): every class the template CAN render. Default false:
   * such a section is dropped, leaving the classes it ALWAYS renders.
   */
  readonly keepOptionalAttributeText?: boolean;
  /**
   * Issue #1256 — keep every section between elements as a marker element
   * instead of dropping its tags: `{{#f}}…{{/f}}` becomes
   * `<caelo-section class="s:f">…</caelo-section>`, an inverted
   * `{{^f}}` the class `i:f`. The structure check reads from them which
   * links a template renders per list entry. Ignored with
   * `keepOptionalAttributeText` (in-tag sections must be dropped first).
   */
  readonly markSections?: boolean;
}

/** The marker element {@link stripMustache} `markSections` emits. */
export const SECTION_MARKER_TAG = "caelo-section";

/**
 * The empty element `markSections` leaves where a placeholder between
 * elements renders: a partial's nested module (`{{>teaser}}` →
 * `<caelo-partial class="p:teaser">`) or a value that may hold markup
 * (`{{body}}` → `class="v:body"`), so a reader knows which section the
 * rendered content sits in.
 */
export const PARTIAL_MARKER_TAG = "caelo-partial";

/**
 * What a placeholder inside a tag becomes with `markSections`
 * (`class="card card--{{type}}"` → `card--\u001f`): a class token holding
 * it matches any rendered token with the same text around it.
 */
export const PLACEHOLDER_MARK = "\u001f";

/**
 * Remove Mustache tags (`{{x}}`, `{{{x}}}`, `{{#s}}`, `{{/s}}`, `{{>p}}`)
 * from a module template so it parses as the markup it renders: a section
 * body between elements stays once (a list renders it per entry), a
 * placeholder becomes empty.
 *
 * A section INSIDE a tag (`<div class="split {{#reverse}}rev{{/reverse}}">`,
 * a boolean variant) is optional: the rendered element may or may not
 * carry its text. By default it is dropped, so the template node has only
 * the classes every render has (#1104). Keeping it made `rev` a required
 * class — every render without it looked like free markup — and a root
 * whose classes all sit in sections matched no render, so the module's
 * free markup went unchecked.
 */
export function stripMustache(template: string, opts: StripMustacheOptions = {}): string {
  const base = opts.keepOptionalAttributeText ? template : dropInTagSections(template);
  const marked =
    opts.markSections && !opts.keepOptionalAttributeText
      ? markSections(markTagPlaceholders(base))
      : base;
  return stripDelimited(stripDelimited(marked, 3), 2);
}

/**
 * Replace every placeholder inside a tag (`{{x}}`, `{{{x}}}`) with
 * {@link PLACEHOLDER_MARK}. One linear scan, tags tracked as in
 * {@link dropInTagSections}; placeholders between elements are left for
 * the strip.
 */
function markTagPlaceholders(text: string): string {
  let out = "";
  let i = 0;
  let inTag = false;
  let quote: string | null = null;
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      const end = text.indexOf("}}", i + 2);
      if (end < 0) break;
      const close = text.startsWith("}}}", end) ? end + 3 : end + 2;
      out += inTag ? PLACEHOLDER_MARK : text.slice(i, close);
      i = close;
      continue;
    }
    const ch = text[i] as string;
    if (inTag) {
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        inTag = false;
      }
    } else if (ch === "<" && /[a-zA-Z]/.test(text[i + 1] ?? "")) {
      inTag = true;
      quote = null;
    }
    out += ch;
    i++;
  }
  return out + text.slice(i);
}

/**
 * Turn the section tags left after {@link dropInTagSections} (all between
 * elements) into marker elements, and every partial and value placeholder
 * into an empty {@link PARTIAL_MARKER_TAG}. Whitespace around the sigil and the name
 * is allowed, as the template engine allows it (`{{ #guides }}`). `[^{}]*`
 * before the closer keeps the match linear.
 */
function markSections(text: string): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (tag: string, raw: string) => {
    const body = raw.trim();
    const sigil = body[0];
    const name = body.slice(1).replace(/[\s"<>]/g, "");
    if (sigil === ">") return `<${PARTIAL_MARKER_TAG} class="p:${name}"></${PARTIAL_MARKER_TAG}>`;
    if (sigil !== "#" && sigil !== "^" && sigil !== "/") {
      const value = body.replace(/[\s"<>{}]/g, "");
      return value === ""
        ? tag
        : `<${PARTIAL_MARKER_TAG} class="v:${value}"></${PARTIAL_MARKER_TAG}>`;
    }
    if (sigil === "/") return `</${SECTION_MARKER_TAG}>`;
    return `<${SECTION_MARKER_TAG} class="${sigil === "#" ? "s" : "i"}:${name}">`;
  });
}

/**
 * Remove every `{{#s}}…{{/s}}` / `{{^s}}…{{/s}}` that opens inside a tag
 * (between `<name` and its `>`), body included. One linear scan; Mustache
 * tags are skipped whole, so a `>` in `{{>partial}}` never ends a tag.
 */
function dropInTagSections(text: string): string {
  let out = "";
  let i = 0;
  let inTag = false;
  let quote: string | null = null;
  // Names with no closer after some point have none after any later point
  // either: remembering them keeps the scan linear on unclosed openers.
  const unclosed = new Set<string>();
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      const end = text.indexOf("}}", i + 2);
      if (end < 0) break;
      const sigil = text[i + 2];
      if (inTag && (sigil === "#" || sigil === "^")) {
        const name = text.slice(i + 3, end).trim();
        const closer = `{{/${name}}}`;
        const close = unclosed.has(name) ? -1 : text.indexOf(closer, end + 2);
        if (close < 0) unclosed.add(name);
        if (name.length > 0 && close >= 0) {
          i = close + closer.length;
          continue;
        }
      }
      out += text.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    const ch = text[i] as string;
    if (inTag) {
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        inTag = false;
      }
    } else if (ch === "<" && /[a-zA-Z]/.test(text[i + 1] ?? "")) {
      inTag = true;
      quote = null;
    }
    out += ch;
    i++;
  }
  return out + text.slice(i);
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

/**
 * Copies of one pattern side by side at which free markup reads as a
 * hand-written list (#1068): three cards in a row are a list of items, two
 * may still be a deliberate pair (a before/after, a two-column split).
 */
export const MIN_SIBLING_REPEATS = 3;

/** A pattern repeated side by side in one piece of markup. */
export interface RepeatedSiblings {
  /** The first copy. */
  readonly node: MarkupNode;
  readonly shape: SubtreeShape;
  /** How many siblings share its signature. */
  readonly count: number;
}

/**
 * Patterns that repeat {@link MIN_SIBLING_REPEATS}+ times as siblings: the
 * same component written out once per item (83 tool cards in one richtext
 * value) instead of a list field rendering one module per item. Roots of
 * the forest that share a parent are siblings too (the free regions of one
 * rendered module). A repeated set is reported once and not searched
 * inside; anything else is searched all the way down. Nested module roots
 * are skipped: their own module owns them.
 */
export function repeatedSiblingPatterns(roots: readonly MarkupNode[]): RepeatedSiblings[] {
  const shapes = new Map<MarkupNode, SubtreeShape>();
  for (const r of roots) if (r.moduleId === null) shapeTree(r, shapes);
  const found: RepeatedSiblings[] = [];
  const visitSiblings = (siblings: readonly MarkupNode[]) => {
    const bySig = new Map<string, MarkupNode[]>();
    for (const n of siblings) {
      if (n.moduleId !== null) continue;
      const shape = shapes.get(n);
      if (!shape || !isPattern(shape)) continue;
      bySig.set(shape.signature, [...(bySig.get(shape.signature) ?? []), n]);
    }
    const reported = new Set<MarkupNode>();
    for (const copies of bySig.values()) {
      if (copies.length < MIN_SIBLING_REPEATS) continue;
      const first = copies[0] as MarkupNode;
      found.push({ node: first, shape: shapes.get(first) as SubtreeShape, count: copies.length });
      for (const c of copies) reported.add(c);
    }
    for (const n of siblings) {
      if (n.moduleId === null && !reported.has(n)) visitSiblings(n.children);
    }
  };
  const byParent = new Map<MarkupNode | null, MarkupNode[]>();
  for (const r of roots) byParent.set(r.parent, [...(byParent.get(r.parent) ?? []), r]);
  for (const group of byParent.values()) visitSiblings(group);
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
