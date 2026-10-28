// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1198 — the module-JS rules of the core `structure` check, the JS
 * twin of `structure/layout-css-module-specific`: code that serves one
 * module belongs in that module, and content belongs in the HTML.
 *
 * - `structure/foreign-module-js` (error): a module's JS drives markup
 *   only one or two OTHER modules render. A header carrying the demo
 *   form's submit handler is the case that produced the issue.
 * - `structure/site-wide-module-js` (warning): it drives hooks three or
 *   more modules share (scroll reveal) without a `caelo:site-wide:`
 *   comment saying that is deliberate.
 * - `structure/js-rendered-content` (error): the JS builds visible
 *   content — markup with text, links or interpolated data written into
 *   the page, or the entries of a content array. Crawlers and LLMs read
 *   the HTML source, not what a script adds.
 * - `structure/js-written-text` (warning): the JS writes long literal
 *   text into the page.
 *
 * Only modules whose JS a staged page ships count: an unplaced module's JS
 * ships nowhere. A module root stamp is not enough evidence on its own — a
 * module with empty html, or a wrapperless parent whose first element is a
 * nested module's root, has no stamp of its own, yet the composer still
 * bundles its JS (shared preview-compose.ts). So the page's own module
 * script (`<script defer data-source="modules">`, inline or base64) and
 * its consent-deferred scripts (`data-caelo-deferred-script="<id>"`) are
 * read too (shippedOn). Site-scope findings, one per module and rule — the
 * fix is one module edit, wherever it is placed. Analysis:
 * module-js-analysis.ts, module-js-hooks.ts.
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import type { StagedPage } from "./check.js";
import type { Finding } from "./findings.js";
import { analyseModuleJs } from "./module-js-analysis.js";
import { foreignHooks, hookOwners, templateHooks } from "./module-js-hooks.js";
import type { StructureLayout } from "./structure.js";
import type { StructureAnalysis, StructureModule } from "./structure-analysis.js";

/** Most hooks / items a message names before "…". */
const MAX_LISTED = 6;

/** The module-JS findings of one staged build. Pure. */
export function moduleJsFindings(
  analysis: StructureAnalysis,
  stagedPages: readonly StagedPage[],
  modules: readonly StructureModule[],
  layouts: readonly StructureLayout[],
): Finding[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const shipped = shippedOn(analysis, stagedPages, modules);
  const owners = hookOwners(modules);
  const neutral = new Set(layouts.flatMap((l) => [...templateHooks(l.html)]));
  const findings: Finding[] = [];
  for (const m of modules) {
    const pages = shipped.get(m.id);
    if (!pages || pages.size === 0 || m.js.trim().length === 0) continue;
    const facts = analyseModuleJs(m.js);
    const name = `"${m.displayName}" (${m.id})`;
    const own = new Set([m.id, ...(analysis.nested.get(m.id) ?? [])]);
    // A wrapperless parent keeps its first child's stamp instead of its
    // own (tagModuleId), so the modules nested in it are not visible here.
    // Without them its own markup is unknown: no foreign-markup verdict.
    const nestingUnknown = !analysis.placements.has(m.id) && /\{\{[>#]/.test(m.html);
    const foreign = nestingUnknown
      ? { specific: new Map<string, readonly string[]>(), shared: [] }
      : foreignHooks(facts, own, owners, neutral);

    if (foreign.specific.size > 0) {
      const targets = [...foreign.specific].map(
        ([id, hooks]) => `"${byId.get(id)?.displayName ?? id}" (${id}: ${list(hooks)})`,
      );
      findings.push({
        ruleId: "structure/foreign-module-js",
        severity: "error",
        message: clip(
          `Script in the wrong module: the JS of ${name} drives markup of ${list(targets)}. It runs on all ${pages.size} page(s) of ${name} and ties that module to code it does not need (consent, errors, load).`,
        ),
        fix: {
          tool: "update_modules_many",
          hint: "move each script into the JS of the module whose markup it drives (one IIFE per module, querying that module's root class), then remove it from this module's JS; when two modules carry copies of the same markup, make them one module first",
        },
      });
    }
    if (foreign.shared.length > 0) {
      findings.push({
        ruleId: "structure/site-wide-module-js",
        severity: "warning",
        message: clip(
          `Site-wide script without declaration: the JS of ${name} drives ${list(foreign.shared)}, hooks that many modules render.`,
        ),
        fix: {
          tool: "update_modules_many",
          hint: "if this behaviour is meant for the whole site (e.g. scroll reveal), say so in the JS with a comment `/* caelo:site-wide: <reason> */`; otherwise move the script into the modules it serves",
        },
      });
    }
    if (facts.rendersContent.length > 0) {
      findings.push({
        ruleId: "structure/js-rendered-content",
        severity: "error",
        message: clip(
          `Content built by JavaScript: the JS of ${name} ${list(facts.rendersContent)}. Search engines and AI crawlers read the HTML source, not what a script adds.`,
        ),
        fix: {
          tool: "update_modules_many",
          hint: "put the content into the module's html — repeated entries as a `list` field rendered with {{#field}}…{{/field}} — and let the JS only show, hide or reorder markup that is already there",
        },
      });
    }
    if (facts.writesText.length > 0) {
      findings.push({
        ruleId: "structure/js-written-text",
        severity: "warning",
        message: clip(
          `Text written by JavaScript: the JS of ${name} writes ${list(facts.writesText)} into the page.`,
        ),
        fix: {
          tool: "update_modules_many",
          hint: "keep the text in the module's html (a field, hidden with the `hidden` attribute until needed) and let the JS toggle it",
        },
      });
    }
  }
  return findings;
}

const BUNDLE_OPEN = '<script defer data-source="modules"';
const BASE64_SRC = ' src="data:text/javascript;base64,';
const DEFERRED_RE = /data-caelo-deferred-script="([0-9a-f-]{36})"/gi;

/**
 * Module id → the staged pages that ship its JS: rendered roots, deferred
 * scripts, and — for modules without either — the page's module bundle
 * containing the module's JS. The bundle has no per-module markers, so a
 * module counts only for what is left once the scripts of the modules
 * known to be on those pages are taken out, and only as whole lines (the
 * composer joins scripts with "\n"): an unused module whose JS repeats a
 * placed module's statement is not shipped. Bundles repeat across pages,
 * so each distinct bundle is searched once.
 */
function shippedOn(
  analysis: StructureAnalysis,
  pages: readonly StagedPage[],
  modules: readonly StructureModule[],
): Map<string, Set<string>> {
  const shipped = new Map<string, Set<string>>();
  const on = (moduleId: string, pageId: string) => {
    const set = shipped.get(moduleId) ?? new Set<string>();
    set.add(pageId);
    shipped.set(moduleId, set);
  };
  for (const [id, onPages] of analysis.placements) for (const p of onPages) on(id, p);
  const bundles = new Map<string, string[]>();
  for (const page of pages) {
    for (const m of page.html.matchAll(DEFERRED_RE))
      on((m[1] as string).toLowerCase(), page.pageId);
    const bundle = moduleBundle(page.html);
    if (bundle !== null) bundles.set(bundle, [...(bundles.get(bundle) ?? []), page.pageId]);
  }
  const residuals = [...bundles].map(([bundle, pageIds]) => {
    let rest = bundle;
    for (const m of modules) {
      if (m.js.trim().length === 0) continue;
      const known = shipped.get(m.id);
      if (known && pageIds.some((p) => known.has(p))) rest = rest.replace(m.js, "");
    }
    return { rest: `\n${rest}\n`, pageIds };
  });
  for (const m of modules) {
    if (m.js.trim().length === 0 || shipped.has(m.id)) continue;
    for (const { rest, pageIds } of residuals) {
      if (rest.includes(`\n${m.js}\n`)) for (const p of pageIds) on(m.id, p);
    }
  }
  return shipped;
}

/** The page's module script as the composer emitted it, or null. */
function moduleBundle(html: string): string | null {
  const at = html.indexOf(BUNDLE_OPEN);
  if (at === -1) return null;
  const rest = at + BUNDLE_OPEN.length;
  if (html.startsWith(BASE64_SRC, rest)) {
    const start = rest + BASE64_SRC.length;
    const end = html.indexOf('"', start);
    return end === -1 ? null : Buffer.from(html.slice(start, end), "base64").toString("utf8");
  }
  const open = html.indexOf(">", rest);
  const close = html.indexOf("</script>", open);
  return open === -1 || close === -1 ? null : html.slice(open + 1, close);
}

function clip(message: string): string {
  return truncateKeepingIds(message, 1000);
}

function list(items: readonly string[]): string {
  const head = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${head} … (+${items.length - MAX_LISTED})` : head;
}
