// SPDX-License-Identifier: MPL-2.0

/**
 * issue #248 (WS2) — repeated-subtree boilerplate detection across pages.
 *
 * A block that appears on many crawled pages — a CTA banner, a newsletter
 * signup, a breadcrumb zone, an author bio — is BOILERPLATE, not per-page
 * content. Copying it into every rebuilt page is exactly the Elementor-
 * bloat mistake WS2 exists to avoid. The rebuild should mint it ONCE as a
 * shared module at the right level and reference it everywhere.
 *
 * "AI decides, code executes" (epic #149): the CODE finds the repeats
 * deterministically (normalized-subtree hashing across pages, no model in
 * the loop); the AI reads the candidates and rebuilds them as one shared
 * module at the suggested level.
 *
 * The placement levels follow the operator's ruling on issue #248:
 *   - site-wide boilerplate      → LAYOUT block (chrome the whole site shows)
 *   - per-page-type boilerplate  → TEMPLATE block (every blog post's breadcrumb)
 *   - recurring content block     → shared content_instance (same CTA on 12 pages)
 *   - semi-dynamic (breadcrumbs)  → TEMPLATE block whose values fill per page
 *
 * All scans are linear with bounded per-frame caps (issue #113 ReDoS +
 * memory discipline) — an adversarial page cannot blow the walker up.
 */

import { Parser } from "htmlparser2";

export interface BoilerplatePageInput {
  readonly pageId: string;
  readonly url?: string;
  readonly html: string;
  /**
   * The page's structural cluster (issue #194). When supplied, placement
   * can tell "same block on every page" (→ layout) apart from "same block
   * on every page OF ONE TYPE" (→ template).
   */
  readonly clusterKey?: string;
}

export type BoilerplatePlacement = "layout" | "template" | "content_instance";

export interface BoilerplateCandidate {
  /** The grouping signature (structure, or structure+content for constant blocks). */
  readonly signature: string;
  /**
   * `content` — the block's text is identical on every member (a fixed CTA).
   * `structure` — the structure repeats but text varies per page (a breadcrumb).
   */
  readonly kind: "content" | "structure";
  /** Outermost tag of the repeated subtree. */
  readonly tag: string;
  readonly pageCount: number;
  readonly memberPageIds: readonly string[];
  readonly memberUrls: readonly string[];
  readonly clusterKeys: readonly string[];
  readonly contentVaries: boolean;
  /** Short preview of the block's text (empty for text-less media blocks). */
  readonly sampleText: string;
  readonly suggestedPlacement: BoilerplatePlacement;
  readonly placementReason: string;
}

export interface BoilerplateReport {
  readonly candidates: readonly BoilerplateCandidate[];
  readonly pagesAnalyzed: number;
}

export interface DetectBoilerplateOptions {
  /** A subtree must appear on at least this many DISTINCT pages. Default 3. */
  readonly minPages?: number;
  /** Ignore subtrees whose visible text is shorter than this (and carry no link/img). Default 20. */
  readonly minTextLength?: number;
  /** Cap on returned candidates (largest first). Default 40. */
  readonly maxCandidates?: number;
}

/** Block-container tags a repeated subtree can be rooted at. */
const BLOCK_TAGS = new Set([
  "div",
  "section",
  "nav",
  "aside",
  "footer",
  "header",
  "article",
  "figure",
  "form",
  "ul",
  "ol",
  "dl",
  "table",
]);

// The walker touches only the currently-OPEN block frames on each parse
// event (never the whole tag stack), and that set is hard-capped at
// MAX_ACTIVE_FRAMES — so every event is O(MAX_ACTIVE_FRAMES) and the walk
// is O(n) overall, even on deep or hostile nesting. STRUCT_CAP bounds
// per-frame memory the same way.
const MAX_ACTIVE_FRAMES = 8; // deepest block nesting we record concurrently
const STRUCT_CAP = 400; // per-frame structural-token cap; over → skip (page-sized)
const MIN_ELEMENTS = 2; // a lone <div> is not a "block"
const MAX_ELEMENTS = 160; // over → too big to be a reusable block

/** djb2 — the same tiny stable hash page-signature.ts uses. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function normalizeText(raw: string): string {
  return raw
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface Frame {
  tag: string;
  structure: string[];
  textParts: string[];
  elementCount: number;
  hasLinkOrImg: boolean;
  overflow: boolean;
  start: number;
}

interface SubtreeRecord {
  pageId: string;
  url: string;
  clusterKey: string;
  tag: string;
  structuralSig: string;
  text: string;
  contentSig: string;
  elementCount: number;
  /** Byte range of this subtree within its page — used for containment dedup. */
  start: number;
  end: number;
}

/** Walk one page, emitting a record per qualifying block subtree. */
function collectSubtrees(page: BoilerplatePageInput, minTextLength: number): SubtreeRecord[] {
  const stack: Array<{ name: string; frame: Frame | null }> = [];
  // The open block frames only (never non-block entries), capped at
  // MAX_ACTIVE_FRAMES — every per-event loop runs over THIS list, so the
  // walker stays O(n) instead of O(n * stack-depth).
  const activeFrames: Frame[] = [];
  const records: SubtreeRecord[] = [];
  const url = page.url ?? "";
  const clusterKey = page.clusterKey ?? "";

  const appendToActive = (token: string): void => {
    for (const f of activeFrames) {
      if (f.overflow) continue;
      if (f.structure.length >= STRUCT_CAP) {
        f.overflow = true;
        continue;
      }
      f.structure.push(token);
    }
  };

  const finalizeFrame = (f: Frame, end: number): void => {
    if (f.overflow) return;
    if (f.elementCount < MIN_ELEMENTS || f.elementCount > MAX_ELEMENTS) return;
    const text = normalizeText(f.textParts.join(" "));
    if (!f.hasLinkOrImg && text.length < minTextLength) return;
    const structuralSig = `${f.tag}:${hash(f.structure.join(">"))}`;
    records.push({
      pageId: page.pageId,
      url,
      clusterKey,
      tag: f.tag,
      structuralSig,
      text,
      contentSig: `${structuralSig}#${hash(text)}`,
      elementCount: f.elementCount,
      start: f.start,
      end,
    });
  };

  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        const startFrame = BLOCK_TAGS.has(tag) && activeFrames.length < MAX_ACTIVE_FRAMES;
        const frame: Frame | null = startFrame
          ? {
              tag,
              structure: [],
              textParts: [],
              elementCount: 0,
              hasLinkOrImg: false,
              overflow: false,
              start: parser.startIndex,
            }
          : null;
        stack.push({ name: tag, frame });
        if (frame) activeFrames.push(frame);
        // Count this element (its own root tag included) for every active frame.
        appendToActive(tag);
        const isLinkOrImg = tag === "a" || tag === "img";
        for (const f of activeFrames) {
          f.elementCount += 1;
          if (isLinkOrImg) f.hasLinkOrImg = true;
        }
      },
      ontext(t) {
        if (t.trim().length === 0) return;
        appendToActive("#");
        for (const f of activeFrames) {
          if (!f.overflow) f.textParts.push(t);
        }
      },
      onclosetag(name) {
        // Crawled HTML is routinely malformed (stray or unclosed tags),
        // so never pop blindly: find the matching open frame and unwind
        // to it, finalizing the implicitly-closed frames in between. A
        // stray close with no matching open is ignored. This keeps the
        // stack, activeFrames, and byte ranges in sync on any input.
        if (stack.length === 0) return;
        const tag = name.toLowerCase();
        let idx = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]?.name === tag) {
            idx = i;
            break;
          }
        }
        if (idx === -1) return;
        const end = parser.endIndex + 1;
        while (stack.length > idx) {
          const entry = stack.pop();
          if (entry?.frame) {
            activeFrames.pop();
            finalizeFrame(entry.frame, end);
          }
        }
      },
    },
    { lowerCaseTags: true },
  );
  parser.write(page.html);
  parser.end();
  return records;
}

interface GroupAccumulator {
  tag: string;
  structuralSig: string;
  records: SubtreeRecord[];
  pageIds: Set<string>;
}

function groupBy(
  records: readonly SubtreeRecord[],
  key: (r: SubtreeRecord) => string,
): Map<string, GroupAccumulator> {
  const groups = new Map<string, GroupAccumulator>();
  for (const r of records) {
    const k = key(r);
    let g = groups.get(k);
    if (!g) {
      g = { tag: r.tag, structuralSig: r.structuralSig, records: [], pageIds: new Set() };
      groups.set(k, g);
    }
    g.records.push(r);
    g.pageIds.add(r.pageId);
  }
  return groups;
}

interface PlacementContext {
  pagesAnalyzed: number;
  clusterSizes: Map<string, number>;
  clustersKnown: boolean;
}

function decidePlacement(
  candidate: {
    pageCount: number;
    clusterKeys: string[];
    contentVaries: boolean;
  },
  ctx: PlacementContext,
): { placement: BoilerplatePlacement; reason: string } {
  const singleCluster =
    ctx.clustersKnown && candidate.clusterKeys.length === 1 && candidate.clusterKeys[0] !== "";
  const spansPageTypes = ctx.clustersKnown && candidate.clusterKeys.length >= 2;

  if (candidate.contentVaries) {
    // Same structure, per-page text → a template block whose values fill
    // per page (breadcrumbs, author bio). This is what templates are for.
    return {
      placement: "template",
      reason: singleCluster
        ? `same structure on ${candidate.pageCount} pages of type "${candidate.clusterKeys[0]}", text varies per page — template block whose values fill per page`
        : `same structure across ${candidate.pageCount} pages with per-page values — bind once at template level`,
    };
  }

  // "Site-wide" is about spanning page TYPES, not raw page count: a fixed
  // block that shows regardless of page type is chrome (→ layout); a fixed
  // block confined to one page type is a template pattern; a fixed block on
  // an arbitrary subset is a recurring content instance. When clusters are
  // unknown, fall back to the page fraction.
  if (spansPageTypes) {
    return {
      placement: "layout",
      reason: `identical block across ${candidate.clusterKeys.length} page types on ${candidate.pageCount} pages — site-wide chrome, bind once at the layout`,
    };
  }

  if (singleCluster) {
    const clusterSize = ctx.clusterSizes.get(candidate.clusterKeys[0] ?? "") ?? 0;
    if (clusterSize > 0 && candidate.pageCount >= clusterSize) {
      return {
        placement: "template",
        reason: `identical block on every page of type "${candidate.clusterKeys[0]}" — template block with a shared synced module`,
      };
    }
    return {
      placement: "content_instance",
      reason: `identical block on ${candidate.pageCount} of ${clusterSize} pages of type "${candidate.clusterKeys[0]}" — one shared synced content instance referenced from each`,
    };
  }

  if (
    !ctx.clustersKnown &&
    candidate.pageCount >= Math.max(3, Math.ceil(ctx.pagesAnalyzed * 0.8))
  ) {
    return {
      placement: "layout",
      reason: `identical block on ${candidate.pageCount}/${ctx.pagesAnalyzed} pages — site-wide chrome, bind once at the layout`,
    };
  }

  return {
    placement: "content_instance",
    reason: `identical block repeated on ${candidate.pageCount} pages — one shared synced content instance referenced from each`,
  };
}

/**
 * Detect repeated content subtrees across the crawled pages of a
 * cluster/site. Runs two groupings over every page's block subtrees:
 *
 *   1. by content signature (structure + text) — catches fixed blocks
 *      like a CTA banner whose copy is identical everywhere;
 *   2. by structural signature over the members NOT already explained by
 *      a fixed block — catches semi-dynamic zones (breadcrumbs) whose
 *      structure repeats while the text differs per page.
 *
 * Each candidate carries its member pages and a suggested placement level.
 */
export function detectBoilerplate(
  pages: readonly BoilerplatePageInput[],
  opts: DetectBoilerplateOptions = {},
): BoilerplateReport {
  const minPages = Math.max(2, opts.minPages ?? 3);
  const minTextLength = opts.minTextLength ?? 20;
  const maxCandidates = opts.maxCandidates ?? 40;

  const pagesAnalyzed = pages.length;
  const clusterSizes = new Map<string, number>();
  let clustersKnown = false;
  for (const p of pages) {
    if (p.clusterKey !== undefined && p.clusterKey !== "") {
      clustersKnown = true;
      clusterSizes.set(p.clusterKey, (clusterSizes.get(p.clusterKey) ?? 0) + 1);
    }
  }
  const ctx: PlacementContext = { pagesAnalyzed, clusterSizes, clustersKnown };

  const allRecords: SubtreeRecord[] = [];
  for (const p of pages) allRecords.push(...collectSubtrees(p, minTextLength));

  const raw: RawCandidate[] = [];
  const claimedContentSigs = new Set<string>();

  // Pass 1 — fixed content blocks (identical structure AND text).
  for (const [contentSig, g] of groupBy(allRecords, (r) => r.contentSig)) {
    if (g.pageIds.size < minPages) continue;
    claimedContentSigs.add(contentSig);
    raw.push({ signature: contentSig, kind: "content", contentVaries: false, records: g.records });
  }

  // Pass 2 — semi-dynamic zones (structure repeats, text varies), over the
  // records not already claimed by a fixed-content candidate.
  const remaining = allRecords.filter((r) => !claimedContentSigs.has(r.contentSig));
  for (const [structuralSig, g] of groupBy(remaining, (r) => r.structuralSig)) {
    if (g.pageIds.size < minPages) continue;
    const distinctTexts = new Set(g.records.map((r) => r.text));
    if (distinctTexts.size <= 1) continue; // a single fixed text would be a pass-1 case
    raw.push({
      signature: structuralSig,
      kind: "structure",
      contentVaries: true,
      records: g.records,
    });
  }

  const survivors = dropNestedCandidates(raw);
  const candidates = survivors.map((c) => buildCandidate(c, ctx));
  candidates.sort(
    (a, b) =>
      b.pageCount - a.pageCount ||
      b.sampleText.length - a.sampleText.length ||
      a.signature.localeCompare(b.signature),
  );

  return { candidates: candidates.slice(0, maxCandidates), pagesAnalyzed };
}

interface RawCandidate {
  signature: string;
  kind: "content" | "structure";
  contentVaries: boolean;
  records: SubtreeRecord[];
}

/**
 * `outer` properly contains `inner` when every occurrence of `inner` sits
 * strictly inside an occurrence of `outer` on the same page. Byte ranges
 * from the parse give exact nesting without a second walk.
 */
function contains(outer: RawCandidate, inner: RawCandidate): boolean {
  if (outer === inner) return false;
  for (const ri of inner.records) {
    const enclosed = outer.records.some(
      (ro) =>
        ro.pageId === ri.pageId &&
        ro.start <= ri.start &&
        ro.end >= ri.end &&
        !(ro.start === ri.start && ro.end === ri.end),
    );
    if (!enclosed) return false;
  }
  return true;
}

/**
 * Remove redundant nested candidates so each real repeated block is
 * reported once, at the right granularity:
 *
 *   - a VARYING wrapper (structure) that merely encloses a FIXED block
 *     (content) is page noise — the fixed inner block is the boilerplate,
 *     so the wrapper is dropped;
 *   - once those wrappers are gone, an inner subtree enclosed by a
 *     surviving fixed block (or by a surviving varying zone) is a sub-part
 *     of it, so the inner is dropped.
 */
function dropNestedCandidates(raw: readonly RawCandidate[]): RawCandidate[] {
  // Phase A — drop varying wrappers around a fixed content block.
  const afterA = raw.filter(
    (o) => !(o.kind === "structure" && raw.some((i) => i.kind === "content" && contains(o, i))),
  );
  // Phase B — drop inner sub-parts enclosed by a surviving candidate.
  return afterA.filter((inner) => !afterA.some((outer) => contains(outer, inner)));
}

function pickRepresentative(records: readonly SubtreeRecord[]): SubtreeRecord {
  let best = records[0];
  if (best === undefined) throw new Error("detectBoilerplate: empty group");
  for (const r of records) if (r.elementCount > best.elementCount) best = r;
  return best;
}

function distinctClusters(records: readonly SubtreeRecord[]): string[] {
  const s = new Set<string>();
  for (const r of records) if (r.clusterKey !== "") s.add(r.clusterKey);
  return [...s].sort();
}

function buildCandidate(c: RawCandidate, ctx: PlacementContext): BoilerplateCandidate {
  const rep = pickRepresentative(c.records);
  const clusterKeys = distinctClusters(c.records);
  const pageIds = [...new Set(c.records.map((r) => r.pageId))].sort();
  const urls = distinctUrls(c.records);
  const { placement, reason } = decidePlacement(
    { pageCount: pageIds.length, clusterKeys, contentVaries: c.contentVaries },
    ctx,
  );
  return {
    signature: c.signature,
    kind: c.kind,
    tag: rep.tag,
    pageCount: pageIds.length,
    memberPageIds: pageIds,
    memberUrls: urls,
    clusterKeys,
    contentVaries: c.contentVaries,
    sampleText: rep.text.slice(0, 120),
    suggestedPlacement: placement,
    placementReason: reason,
  };
}

function distinctUrls(records: readonly SubtreeRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    if (r.url === "" || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r.url);
    if (out.length >= 10) break;
  }
  return out;
}
