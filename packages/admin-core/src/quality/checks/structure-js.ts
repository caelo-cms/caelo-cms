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
 * Only modules rendered on a staged page count: an unplaced module's JS
 * ships nowhere. Site-scope findings, one per module and rule — the fix is
 * one module edit, wherever it is placed. Analysis: module-js-analysis.ts.
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import type { Finding } from "./findings.js";
import { analyseModuleJs, foreignHooks, hookOwners, templateHooks } from "./module-js-analysis.js";
import type { StructureLayout } from "./structure.js";
import type { StructureAnalysis, StructureModule } from "./structure-analysis.js";

/** Most hooks / items a message names before "…". */
const MAX_LISTED = 6;

/** The module-JS findings of one staged build. Pure. */
export function moduleJsFindings(
  analysis: StructureAnalysis,
  modules: readonly StructureModule[],
  layouts: readonly StructureLayout[],
): Finding[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const owners = hookOwners(modules);
  const neutral = new Set(layouts.flatMap((l) => [...templateHooks(l.html)]));
  const findings: Finding[] = [];
  for (const m of modules) {
    const pages = analysis.placements.get(m.id);
    if (!pages || pages.size === 0 || m.js.trim().length === 0) continue;
    const facts = analyseModuleJs(m.js);
    const name = `"${m.displayName}" (${m.id})`;
    const own = new Set([m.id, ...(analysis.nested.get(m.id) ?? [])]);
    const foreign = foreignHooks(facts, own, owners, neutral);

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

function clip(message: string): string {
  return truncateKeepingIds(message, 1000);
}

function list(items: readonly string[]): string {
  const head = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${head} … (+${items.length - MAX_LISTED})` : head;
}
