// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1198 — write-time hints for module JS, the early half of the
 * module-JS rules of the core `structure` check (quality/checks/structure-js.ts).
 *
 * After a module write that touched `js` or `html`, the module's stored JS
 * is read the way the Stage check reads it: does it drive markup of other
 * modules, does it build content the HTML should carry? Hints on an
 * already-successful write, never a gate — the Stage check blocks what is
 * left. Same analysis on both sides (module-js-analysis.ts), so a hint here
 * is exactly the finding the Stage would raise.
 *
 * One difference: here the modules nested in a module are not known (they
 * are chosen per placement), so a module with `module` / `module-list`
 * fields gets no foreign-markup hint. The Stage check sees the rendered
 * nesting and decides.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { analyseModuleJs } from "../../quality/checks/module-js-analysis.js";
import { foreignHooks, hookOwners, templateHooks } from "../../quality/checks/module-js-hooks.js";
import type { ToolContext } from "./dispatch.js";

interface GuardModule {
  readonly id: string;
  readonly displayName: string;
  readonly html: string;
  readonly js: string;
  readonly fields?: readonly unknown[];
}

/** Most hooks a hint names. */
const MAX_HOOKS = 4;

/**
 * Hints for the JS of the given modules ("" when there is nothing to say).
 *
 * @param moduleIds - the modules this write created or whose js / html it changed.
 */
export async function moduleJsGuardSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  moduleIds: readonly string[],
): Promise<string> {
  if (moduleIds.length === 0) return "";
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list", {
    includeDeleted: false,
  });
  // A failed read only loses the hint; the write it comments on succeeded.
  if (!listed.ok) return "";
  const catalog = (listed.value as { modules?: GuardModule[] }).modules ?? [];
  const written = catalog.filter((m) => moduleIds.includes(m.id) && m.js.trim().length > 0);
  if (written.length === 0) return "";

  const owners = hookOwners(catalog);
  const byId = new Map(catalog.map((m) => [m.id, m]));
  let neutral: Set<string> | null = null;
  const hints: string[] = [];
  for (const m of written) {
    const facts = analyseModuleJs(m.js);
    const name = `"${m.displayName}"`;
    if (facts.hooks.length > 0 && !hasNestedFields(m)) {
      neutral ??= await layoutHooks(ctx, toolCtx);
      const foreign = foreignHooks(facts, new Set([m.id]), owners, neutral);
      for (const [id, hooks] of foreign.specific) {
        const target = `"${byId.get(id)?.displayName ?? id}" (${id})`;
        hints.push(
          `the js of ${name} drives markup of module ${target} (${hooks.slice(0, MAX_HOOKS).join(", ")}) — move that script into the js of ${target}. Module js belongs to the module whose markup it touches, never into a header or footer because those load on every page (Stage blocks this: structure/foreign-module-js)`,
        );
      }
      if (foreign.shared.length > 0) {
        hints.push(
          `the js of ${name} drives ${foreign.shared.slice(0, MAX_HOOKS).join(", ")}, rendered by many modules — if that is deliberate site-wide behaviour (e.g. scroll reveal), add a comment \`/* caelo:site-wide: <reason> */\` to the js; otherwise move the script into the modules it serves`,
        );
      }
    }
    if (facts.rendersContent.length > 0) {
      hints.push(
        `the js of ${name} ${facts.rendersContent.join("; ")} — search engines and AI crawlers read the HTML source, not what a script adds: put the content into the module html (repeated entries as a \`list\` field) and let the js only show/hide it (Stage blocks this: structure/js-rendered-content)`,
      );
    }
    if (facts.writesText.length > 0) {
      hints.push(
        `the js of ${name} writes text ${facts.writesText.join(", ")} into the page — keep that text in the module html (hidden until needed) and toggle it`,
      );
    }
  }
  return hints.length === 0 ? "" : ` module-js-guard: ${hints.join(". ")}.`;
}

function hasNestedFields(m: GuardModule): boolean {
  return (m.fields ?? []).some((f) => {
    const kind = (f as { kind?: unknown }).kind;
    return kind === "module" || kind === "module-list";
  });
}

/** Hooks of every layout's own markup (any module may drive the chrome); empty on a failed read. */
async function layoutHooks(ctx: ExecutionContext, toolCtx: ToolContext): Promise<Set<string>> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {
    includeDeleted: false,
  });
  if (!r.ok) return new Set();
  const layouts = (r.value as { layouts?: { html: string }[] }).layouts ?? [];
  return new Set(layouts.flatMap((l) => [...templateHooks(l.html)]));
}
