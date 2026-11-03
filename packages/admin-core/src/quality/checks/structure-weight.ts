// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1371 — page weight in the core `structure` check: the frame every
 * page carries, and lists rendered more than once on one page.
 *
 * - `structure/heavy-chrome`: the elements a page builds before any of its
 *   own content — layout / template markup, the frame modules (layout
 *   chrome, kind `chrome`, or a module on nearly every page) and plugin
 *   output outside modules (a consent banner). The frame ships on every
 *   page, so its weight is paid site-wide; the first layout of a page is
 *   its biggest long task, and Lighthouse's DOM budget is about 800
 *   elements. Warning from {@link CHROME_WARN_ELEMENTS}, error from
 *   {@link CHROME_ERROR_ELEMENTS} (it leaves the content half the budget).
 *   One site finding per frame (pages with the same frame parts), naming
 *   each part's count and the share inside inline SVG.
 * - `structure/repeated-render`: the entries of one list rendered more than
 *   once on a page. The shared-list rule (`duplicate-navigation`) fixes
 *   the DATA — one list, many modules — but a header that writes its menu
 *   once for desktop and once for mobile, plus a footer with the same
 *   menu, puts every link into the DOM three times. Error when ONE module
 *   renders a list twice (one markup serves every width) or a page renders
 *   it three or more times; warning for two renders in different modules
 *   (header + footer). One site finding per list.
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import type { Finding } from "./findings.js";
import type { StructureModule } from "./structure-analysis.js";
import { LAYOUT_PART, type ListRender, type PageWeight } from "./structure-weight-analysis.js";

/** Frame elements from which a page's frame is reported. */
export const CHROME_WARN_ELEMENTS = 250;
/** Frame elements from which the frame blocks Publish live. */
export const CHROME_ERROR_ELEMENTS = 400;
/** Share of pages a module must be rendered on to count as frame without being chrome. */
export const FRAME_PAGE_SHARE = 0.9;
/** Fewest pages before "on nearly every page" means anything. */
export const FRAME_MIN_PAGES = 5;
/** Renders of one list on one page from which it is an error. */
export const REPEATED_RENDER_ERROR = 3;
/** Most parts / paths a message names. */
const MAX_LISTED = 6;

/**
 * The modules that form the frame: placed in a layout block, of kind
 * `chrome`, or rendered on at least {@link FRAME_PAGE_SHARE} of the pages.
 */
export function frameModuleIds(
  modules: readonly StructureModule[],
  layoutChromeSlugs: ReadonlySet<string>,
  placements: ReadonlyMap<string, ReadonlySet<string>>,
  pageCount: number,
): Set<string> {
  const out = new Set<string>();
  for (const m of modules) {
    const onPages = placements.get(m.id)?.size ?? 0;
    const nearlyEverywhere =
      pageCount >= FRAME_MIN_PAGES && onPages >= Math.ceil(pageCount * FRAME_PAGE_SHARE);
    if (m.kind === "chrome" || layoutChromeSlugs.has(m.slug) || nearlyEverywhere) out.add(m.id);
  }
  return out;
}

/** One frame (same parts) and the pages it sits on. */
interface FrameGroup {
  readonly parts: readonly string[];
  /** The heaviest page of the group: its per-part weights. */
  heaviest: { total: number; path: string; parts: Map<string, { elements: number; svg: number }> };
  pages: number;
  contentSum: number;
}

/** `structure/heavy-chrome` findings for the measured pages. */
export function heavyChromeFindings(
  weights: readonly PageWeight[],
  frame: ReadonlySet<string>,
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  const isFrame = (part: string) =>
    part === LAYOUT_PART || part.startsWith("plugin:") || frame.has(part.slice("module:".length));
  const groups = new Map<string, FrameGroup>();
  for (const w of weights) {
    const frameParts = [...w.parts.keys()].filter(isFrame).sort();
    let total = 0;
    let content = 0;
    const parts = new Map<string, { elements: number; svg: number }>();
    for (const [part, weight] of w.parts) {
      if (isFrame(part)) {
        total += weight.elements;
        parts.set(part, { ...weight });
      } else content += weight.elements;
    }
    const key = frameParts.join("\u0000");
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        parts: frameParts,
        heaviest: { total, path: w.path, parts },
        pages: 1,
        contentSum: content,
      });
      continue;
    }
    g.pages++;
    g.contentSum += content;
    if (total > g.heaviest.total) g.heaviest = { total, path: w.path, parts };
  }
  const findings: Finding[] = [];
  for (const g of groups.values()) {
    const { total, parts, path } = g.heaviest;
    if (total < CHROME_WARN_ELEMENTS) continue;
    const error = total >= CHROME_ERROR_ELEMENTS;
    const breakdown = [...parts]
      .sort((a, b) => b[1].elements - a[1].elements)
      .map(([part, w]) => {
        const svg = w.svg > 0 ? ` (${w.svg} inside inline SVG)` : "";
        return `${partName(part, byId)} ${w.elements}${svg}`;
      });
    const content = Math.round(g.contentSum / g.pages);
    const heavierThanContent =
      total > content ? ` — more than the page content itself (${content} on average)` : "";
    findings.push({
      ruleId: "structure/heavy-chrome",
      severity: error ? "error" : "warning",
      message: clip(
        `Heavy frame: ${total} elements on every page before its own content (e.g. ${path}; ` +
          `reported from ${CHROME_WARN_ELEMENTS}, blocks from ${CHROME_ERROR_ELEMENTS}) on ${g.pages} page(s)${heavierThanContent}: ` +
          `${list(breakdown)}. The browser lays all of it out on every page view before the first paint.`,
      ),
      fix: {
        tool: "update_modules_many",
        hint: 'render each list once (one <nav> for every width; the mobile menu collapses the same markup with data-caelo-ui="mobile-nav" instead of a second copy), give the footer its own short list instead of the whole menu, drop wrapper elements that carry no style of their own, and replace repeated inline SVG icons with one <img> per icon file or a CSS mask',
      },
    });
  }
  return findings;
}

/** `structure/repeated-render` findings: one per list rendered twice or more somewhere. */
export function repeatedRenderFindings(
  renders: readonly ListRender[],
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  const byList = new Map<string, ListRender[]>();
  for (const r of renders) byList.set(r.list, [...(byList.get(r.list) ?? []), r]);
  const findings: Finding[] = [];
  for (const [listKey, onPages] of byList) {
    const most = Math.max(...onPages.map((r) => r.renders));
    const twiceInOne = new Set(
      onPages.flatMap((r) => [...r.byModule].filter(([, n]) => n >= 2).map(([id]) => id)),
    );
    const modules = new Set(onPages.flatMap((r) => [...r.byModule.keys()]));
    const error = twiceInOne.size > 0 || most >= REPEATED_RENDER_ERROR;
    const names = (ids: Iterable<string>) =>
      [...ids].map((id) => `"${byId.get(id)?.displayName ?? id}" (${id})`);
    const what = listKey.startsWith("shared:")
      ? `shared list caelo:list/${listKey.slice("shared:".length)}`
      : `local list \`${listKey.split(":")[2]}\``;
    const inOne =
      twiceInOne.size > 0 ? ` ${list(names(twiceInOne))} render(s) it twice on its own.` : "";
    const paths = [...new Set(onPages.map((r) => r.path))];
    findings.push({
      ruleId: "structure/repeated-render",
      severity: error ? "error" : "warning",
      message: clip(
        `List rendered ${most} times on one page: the ${what} is written into the HTML ${most} times by ${list(names(modules))}.${inOne} ` +
          `Every copy is DOM the browser builds and links crawlers read again; on ${paths.length} page(s): ${list(paths)}.`,
      ),
      fix: {
        tool: "update_modules_many",
        hint:
          twiceInOne.size > 0
            ? 'iterate the list ONCE in the module html: one <nav> serves desktop and mobile — collapse it with data-caelo-ui="mobile-nav" and CSS instead of a second {{#field}} loop'
            : "show the list in one module only: give the other place (usually the footer) its own short shared list (upsert_lists_many: legal pages, contact, top sections) and bind that module's list field to it",
      },
    });
  }
  return findings;
}

function partName(part: string, byId: ReadonlyMap<string, StructureModule>): string {
  if (part === LAYOUT_PART) return "layout / template markup";
  if (part.startsWith("plugin:")) return `plugin output "${part.slice("plugin:".length)}"`;
  const id = part.slice("module:".length);
  return `"${byId.get(id)?.displayName ?? id}" (${id})`;
}

function list(items: readonly string[]): string {
  const head = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${head} … (+${items.length - MAX_LISTED})` : head;
}

function clip(message: string): string {
  return truncateKeepingIds(message, 1000);
}
