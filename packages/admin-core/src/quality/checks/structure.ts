// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — the core `structure` check: markup that should be a module
 * but is not.
 *
 * One-off free HTML on a single page is fine. The second copy of a pattern
 * is not: copies are edited one by one and drift, the copy lives in field
 * values where a text edit can break it, and its CSS has to sit in the
 * layout where it ships on every page. Maintainer decision on #820: this is
 * a core check like Lighthouse (it protects Caelo's own module model), and
 * only CLEAR repeats block:
 *
 * - `structure/repeated-markup` (error): the same pattern sits in free
 *   markup on two or more pages, or free markup repeats a module's own
 *   template exactly. Make it one module and place it.
 * - `structure/duplicate-module` (error): two modules with structurally
 *   identical templates. Keep one, give it the content as values.
 * - `structure/similar-markup` (warning): near matches of the above —
 *   likely the same pattern drifting, but not certain.
 * - `structure/layout-css-module-specific` (warning): layout CSS for
 *   classes only one module (or only free markup) uses.
 * - `structure/repeated-items` (warning, #1068): one pattern written out
 *   three or more times side by side in the free markup of one module on
 *   one page — a list of items kept as hand-written HTML (83 tool cards
 *   in one richtext value). Not a block: a single page is allowed free
 *   HTML, but the items belong in a `list` field (a module-list only when
 *   each item is a module of its own). Pages where the pattern already
 *   blocks as repeated or similar markup get that finding only.
 * - `structure/duplicate-navigation` (error, epic #1107): two modules
 *   carry the same set of links (three or more) as their own data —
 *   local list entries or hand-written links. A header and a footer
 *   with the same menu kept twice drift apart; keep it in ONE shared
 *   list and bind both. Links of a shared list never count.
 * - `structure/similar-navigation` (warning): near matches of the above
 *   (Jaccard ≥ the near-match threshold) — likely one menu drifting.
 * - `structure/manual-page-listing` (#1256, structure-listing.ts): a
 *   module keeps links to most published pages of one page type by hand
 *   (local list entries, cards in a module-list, scalar href fields)
 *   instead of a list field bound to a page query. Error while pages of
 *   the type are missing, warning when the set is complete; the default
 *   page type is exempt.
 * - Module JS (#1198, structure-js.ts): `structure/foreign-module-js` and
 *   `structure/js-rendered-content` (errors), `structure/site-wide-module-js`
 *   and `structure/js-written-text` (warnings) — a script in the wrong
 *   module, and content a script builds instead of the HTML carrying it.
 *
 * Deliberate exceptions go through the existing per-rule acceptance.
 */

import {
  isPattern,
  NEAR_MATCH_THRESHOLD,
  parseMarkup,
  type SubtreeShape,
  shapeSimilarity,
  stripMustache,
  truncateKeepingIds,
} from "@caelo-cms/shared";
import type { SiteCheck, StagedPage } from "./check.js";
import type { Finding } from "./findings.js";
import { siteHostsOf } from "./links-analysis.js";
import { MAX_FINDINGS_PER_CALL } from "./runner.js";
import {
  analyseStructure,
  type LinkGroup,
  type PatternOccurrence,
  type StructureAnalysis,
  type StructureModule,
  selectorClasses,
} from "./structure-analysis.js";
import { moduleJsFindings } from "./structure-js.js";
import { manualListingFindings, type StructurePageIndex } from "./structure-listing.js";

export const STRUCTURE_CHECK_ID = "structure";

/** A layout as the structure check needs it. */
export interface StructureLayout {
  readonly id: string;
  readonly displayName: string;
  readonly html: string;
  readonly css: string;
}

/** Where the check reads the module templates, layouts and pages (main, = staged). */
export interface StructureSources {
  modules(): Promise<readonly StructureModule[]>;
  layouts(): Promise<readonly StructureLayout[]>;
  /** Page types and every page's type (#1256). */
  pageIndex(): Promise<StructurePageIndex>;
}

/** Most distinct one-page patterns compared pairwise for near matches. */
const MAX_NEAR_CANDIDATES = 2_000;
/** Most page paths / classes a message names before "…". */
const MAX_LISTED = 6;

/** One pattern seen in several places. */
interface PatternGroup {
  readonly label: string;
  readonly occurrences: PatternOccurrence[];
  /** A module whose template is this pattern (exact or near). */
  readonly module: StructureModule | null;
}

/** Build the core structure check over the given sources. */
export function createStructureCheck(sources: StructureSources): SiteCheck {
  return {
    id: STRUCTURE_CHECK_ID,
    title: "Markup structure",
    scope: "site",
    async run({ pages, build }) {
      const [modules, layouts, pageIndex] = await Promise.all([
        sources.modules(),
        sources.layouts(),
        sources.pageIndex(),
      ]);
      const siteHosts = new Set([
        ...pageIndex.siteHosts,
        ...siteHostsOf([build.baseUrl, build.displayBaseUrl]),
      ]);
      return structureFindings(pages, modules, layouts, { ...pageIndex, siteHosts });
    },
  };
}

/** The findings of one staged build. Pure; exported for tests. */
export function structureFindings(
  pages: readonly StagedPage[],
  modules: readonly StructureModule[],
  layouts: readonly StructureLayout[],
  pageIndex: StructurePageIndex,
): Finding[] {
  const analysis = analyseStructure(pages, modules);
  const byId = new Map(modules.map((m) => [m.id, m]));
  const groups = groupPatterns(analysis, byId);
  const findings = [
    ...perPage("structure/repeated-markup", "error", groups.exact, byId),
    ...duplicateModules(analysis, byId),
    ...perPage("structure/similar-markup", "warning", groups.near, byId),
    ...layoutCss(analysis, layouts, byId),
    ...repeatedItems(analysis, [...groups.exact, ...groups.near], byId),
    ...navigationFindings(analysis.linkGroups, byId),
    ...manualListingFindings(analysis.listingGroups, pages, pageIndex, byId),
    ...moduleJsFindings(analysis, pages, modules, layouts),
  ];
  // Errors first (stable within a severity), so a cut keeps what blocks.
  // The fix of one group is site-wide, so the next Stage re-reports
  // whatever was cut.
  const rank = (f: Finding) => (f.severity === "error" ? 0 : 1);
  return findings.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FINDINGS_PER_CALL);
}

function groupPatterns(
  analysis: StructureAnalysis,
  byId: ReadonlyMap<string, StructureModule>,
): { exact: PatternGroup[]; near: PatternGroup[] } {
  // Every module counts, placed or not: a free copy of a module that
  // exists is a copy either way, and placing the module is the fix.
  const templates = [...analysis.templateShapes].filter(([, s]) => isPattern(s));
  const bySig = new Map<string, PatternOccurrence[]>();
  for (const o of analysis.occurrences) {
    const list = bySig.get(o.shape.signature) ?? [];
    list.push(o);
    bySig.set(o.shape.signature, list);
  }
  const exact: PatternGroup[] = [];
  const rest: PatternOccurrence[][] = [];
  for (const list of bySig.values()) {
    const first = list[0] as PatternOccurrence;
    const templateId = templates.find(([, s]) => s.signature === first.shape.signature)?.[0];
    const module = templateId ? (byId.get(templateId) ?? null) : null;
    if (module || pageCount(list) >= 2)
      exact.push({ label: first.label, occurrences: list, module });
    else rest.push(list);
  }
  return { exact, near: nearGroups(rest.slice(0, MAX_NEAR_CANDIDATES), templates, byId) };
}

/** Cluster one-page patterns that are near matches of each other or of a template. */
function nearGroups(
  lists: readonly PatternOccurrence[][],
  templates: readonly (readonly [string, SubtreeShape])[],
  byId: ReadonlyMap<string, StructureModule>,
): PatternGroup[] {
  const parent = lists.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };
  const shapes = lists.map((list) => (list[0] as PatternOccurrence).shape);
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      if (
        shapeSimilarity(shapes[i] as SubtreeShape, shapes[j] as SubtreeShape) >=
        NEAR_MATCH_THRESHOLD
      )
        parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, PatternOccurrence[]>();
  lists.forEach((list, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), ...list]);
  });
  const out: PatternGroup[] = [];
  for (const occ of clusters.values()) {
    const first = occ[0] as PatternOccurrence;
    const templateId = templates.find(
      ([, s]) => shapeSimilarity(first.shape, s) >= NEAR_MATCH_THRESHOLD,
    )?.[0];
    const module = templateId ? (byId.get(templateId) ?? null) : null;
    if (module || pageCount(occ) >= 2) out.push({ label: first.label, occurrences: occ, module });
  }
  return out;
}

function pageCount(list: readonly PatternOccurrence[]): number {
  return new Set(list.map((o) => o.pageId)).size;
}

/** One finding per affected page, naming every group on it. */
function perPage(
  ruleId: string,
  severity: "error" | "warning",
  groups: readonly PatternGroup[],
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  const onPage = new Map<string, PatternGroup[]>();
  for (const g of groups) {
    for (const pageId of new Set(g.occurrences.map((o) => o.pageId))) {
      onPage.set(pageId, [...(onPage.get(pageId) ?? []), g]);
    }
  }
  const lead = severity === "error" ? "Repeated free markup" : "Similar free markup";
  return [...onPage].map(([pageId, gs]) => ({
    ruleId,
    severity,
    pageId,
    message: clip(`${lead}: ${gs.map((g) => describeGroup(g, pageId, byId)).join(" ")}`),
    fix: gs.some((g) => g.module)
      ? {
          tool: "add_module",
          hint: "place the existing module by moduleId with this page's content as values, then remove the free copy from the field value",
        }
      : {
          tool: "add_module",
          hint: "mint ONE module from this markup with semantic fields (a `list` field for repeated entries; a module-list only when each item is a module of its own), place it on every listed page with that page's values, remove the free copies, and move the pattern's CSS from the layout into the module",
        },
  }));
}

function describeGroup(
  g: PatternGroup,
  pageId: string,
  byId: ReadonlyMap<string, StructureModule>,
): string {
  const paths = [...new Set(g.occurrences.map((o) => o.path))];
  const hosts = [...new Set(g.occurrences.map((o) => byId.get(o.hostModuleId)?.displayName))];
  const here = g.occurrences.find((o) => o.pageId === pageId);
  const host = here ? byId.get(here.hostModuleId)?.displayName : undefined;
  const target = g.module
    ? `the markup of module "${g.module.displayName}" (${g.module.id}), copied as free HTML`
    : `free HTML in the fields of ${hosts.map((h) => `"${h}"`).join(", ")}`;
  return (
    `\`${g.label}\` here${host ? ` (in "${host}")` : ""} is ${target}; ` +
    `on ${paths.length} page(s): ${list(paths)}.`
  );
}

/**
 * One warning per page for patterns repeated side by side in one module's
 * free markup, unless that module's free markup on the page is already
 * part of a repeated / similar group (its finding names the same fix).
 */
function repeatedItems(
  analysis: StructureAnalysis,
  groups: readonly PatternGroup[],
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  const covered = new Set(
    groups.flatMap((g) => g.occurrences.map((o) => `${o.pageId}\u0000${o.hostModuleId}`)),
  );
  const onPage = new Map<string, string[]>();
  for (const r of analysis.siblingRepeats) {
    if (covered.has(`${r.pageId}\u0000${r.hostModuleId}`)) continue;
    const host = byId.get(r.hostModuleId)?.displayName ?? r.hostModuleId;
    const line = `\`${r.label}\` is written out ${r.count} times side by side in the free HTML of "${host}".`;
    onPage.set(r.pageId, [...(onPage.get(r.pageId) ?? []), line]);
  }
  return [...onPage].map(([pageId, lines]) => ({
    ruleId: "structure/repeated-items",
    severity: "warning" as const,
    pageId,
    message: clip(
      `Repeated items in free markup: ${lines.join(" ")} Each copy is edited on its own and the copies drift.`,
    ),
    fix: {
      tool: "add_module",
      hint: "give the host module a `list` field with one entry per item (list type links / menu / texts, or a list type with the item's fields) and render the entries with {{#field}}…{{/field}}; use a module-list only when each item is a module of its own. Then remove the hand-written copies from the field value",
    },
  }));
}

/** Most distinct link sets compared pairwise for near matches. */
const MAX_NAV_CANDIDATES = 500;

/** One set of links and the modules that carry it as their own data. */
interface NavGroup {
  readonly hrefs: readonly string[];
  readonly modules: Set<string>;
  readonly pages: Set<string>;
}

/**
 * Two or more modules carrying the same links as their own copies (epic
 * #1107): exact sets block, near sets warn. One site finding per group —
 * the fix (one shared list) is one change, wherever the modules sit.
 */
function navigationFindings(
  groups: readonly LinkGroup[],
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  const bySig = new Map<string, NavGroup>();
  for (const g of groups) {
    const sig = g.hrefs.join("\u0000");
    const ng = bySig.get(sig) ?? { hrefs: g.hrefs, modules: new Set(), pages: new Set() };
    ng.modules.add(g.moduleId);
    ng.pages.add(g.pageId);
    bySig.set(sig, ng);
  }
  const all = [...bySig.values()];
  const findings: Finding[] = [];
  const exact = all.filter((g) => g.modules.size >= 2);
  for (const g of exact)
    findings.push(navigationFinding("exact", g.hrefs, g.modules, g.pages, byId));

  // Near: cluster the remaining sets (one module each) by link overlap.
  const rest = all.filter((g) => g.modules.size < 2).slice(0, MAX_NAV_CANDIDATES);
  const parent = rest.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      if (jaccard((rest[i] as NavGroup).hrefs, (rest[j] as NavGroup).hrefs) >= NEAR_MATCH_THRESHOLD)
        parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, NavGroup[]>();
  rest.forEach((g, i) => {
    clusters.set(find(i), [...(clusters.get(find(i)) ?? []), g]);
  });
  for (const cluster of clusters.values()) {
    const modules = new Set(cluster.flatMap((g) => [...g.modules]));
    if (modules.size < 2) continue;
    const hrefs = [...new Set(cluster.flatMap((g) => g.hrefs))].sort();
    const pages = new Set(cluster.flatMap((g) => [...g.pages]));
    findings.push(navigationFinding("near", hrefs, modules, pages, byId));
  }
  return findings;
}

function navigationFinding(
  match: "exact" | "near",
  hrefs: readonly string[],
  modules: ReadonlySet<string>,
  pages: ReadonlySet<string>,
  byId: ReadonlyMap<string, StructureModule>,
): Finding {
  const names = [...modules].map((id) => `"${byId.get(id)?.displayName ?? id}" (${id})`);
  const what =
    match === "exact"
      ? `carry the same ${hrefs.length} links (${list(hrefs)})`
      : `carry nearly the same links (${list(hrefs)})`;
  return {
    ruleId: match === "exact" ? "structure/duplicate-navigation" : "structure/similar-navigation",
    severity: match === "exact" ? "error" : "warning",
    message: clip(
      `${match === "exact" ? "Duplicate navigation" : "Similar navigation"}: modules ${list(names)} ${what} as copies of their own, on ${pages.size} page(s) — each copy is edited on its own and they drift apart.`,
    ),
    fix: {
      tool: "promote_local_list",
      hint: "keep these links in ONE shared list: promote one module's list field to a shared list (promote_local_list; hand-written links first become a list field), then bind the other modules' list fields to the same caelo:list/<id> and drop their own copies",
    },
  };
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  let both = 0;
  for (const x of b) if (sa.has(x)) both++;
  return both / (sa.size + b.length - both);
}

/** Modules whose templates are structurally identical. */
function duplicateModules(
  analysis: StructureAnalysis,
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  const bySig = new Map<string, string[]>();
  for (const [id, shape] of analysis.templateShapes) {
    if (!analysis.placements.has(id) || !isPattern(shape)) continue;
    bySig.set(shape.signature, [...(bySig.get(shape.signature) ?? []), id]);
  }
  const findings: Finding[] = [];
  for (const ids of bySig.values()) {
    if (ids.length < 2) continue;
    const names = ids.map((id) => `"${byId.get(id)?.displayName}" (${id})`);
    const pages = new Set(ids.flatMap((id) => [...(analysis.placements.get(id) ?? [])]));
    for (const pageId of pages) {
      findings.push({
        ruleId: "structure/duplicate-module",
        severity: "error",
        pageId,
        message: clip(
          `Duplicate modules: ${list(names)} have the same markup structure — they are one pattern kept as ${ids.length} copies.`,
        ),
        fix: {
          tool: "add_module",
          hint: "keep one of these modules (move differing hardcoded text into fields), place it by moduleId wherever the others are placed with their content as values, then delete the copies with delete_modules_many",
        },
      });
    }
  }
  return findings;
}

/** Layout CSS rules for classes only one module, or only free markup, uses. */
function layoutCss(
  analysis: StructureAnalysis,
  layouts: readonly StructureLayout[],
  byId: ReadonlyMap<string, StructureModule>,
): Finding[] {
  const findings: Finding[] = [];
  for (const layout of layouts) {
    const own = new Set(
      // Every class the layout CAN render — an optional `{{#s}}cls{{/s}}`
      // class is still the layout's own.
      parseMarkup(stripMustache(layout.html, { keepOptionalAttributeText: true })).flatMap(
        function all(n): string[] {
          return [...n.classes, ...n.children.flatMap(all)];
        },
      ),
    );
    const specific: string[] = [];
    for (const cls of selectorClasses(layout.css)) {
      const use = analysis.classUse.get(cls);
      if (!use || use.chrome || own.has(cls)) continue;
      const hosts = new Set([...use.modules, ...use.freeIn]);
      if (use.modules.size === 1 && use.freeIn.size === 0) {
        const id = [...use.modules][0] as string;
        specific.push(`.${cls} (module "${byId.get(id)?.displayName}")`);
      } else if (use.modules.size === 0 && hosts.size > 0) {
        specific.push(`.${cls} (free markup only)`);
      }
    }
    if (specific.length === 0) continue;
    findings.push({
      ruleId: "structure/layout-css-module-specific",
      severity: "warning",
      message: clip(
        `Module CSS in the layout: layout "${layout.displayName}" styles ${list(specific)} — these rules ship on every page but serve one module or free markup.`,
      ),
      fix: {
        tool: "update_modules_many",
        hint: "move these rules into the CSS of the module that uses them (for free markup: into the module you mint for it), then drop them from the layout with propose_update_layout",
      },
    });
  }
  return findings;
}

function list(items: readonly (string | undefined)[]): string {
  const shown = items.filter((s): s is string => s !== undefined);
  const head = shown.slice(0, MAX_LISTED).join(", ");
  return shown.length > MAX_LISTED ? `${head} … (+${shown.length - MAX_LISTED})` : head;
}

function clip(message: string): string {
  return truncateKeepingIds(message, 1000);
}
