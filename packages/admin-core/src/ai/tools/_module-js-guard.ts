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
 *
 * Epic #1371 — the same catalog read feeds the page-weight hints
 * (_page-weight-guard.ts: one list rendered twice), so every module write
 * pays for one `modules.list` and at most one `layouts.list`.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { analyseModuleJs } from "../../quality/checks/module-js-analysis.js";
import { foreignHooks, hookOwners, templateHooks } from "../../quality/checks/module-js-hooks.js";
import { pageWeightHints, type WeightGuardModule } from "./_page-weight-guard.js";
import type { ToolContext } from "./dispatch.js";

interface GuardModule extends WeightGuardModule {
  readonly js: string;
}

/** A layout as the guards read it from `layouts.list`. */
interface GuardLayout {
  readonly html: string;
  readonly blocks: readonly { readonly moduleSlugs: readonly string[] }[];
}

/** Most hooks a hint names. */
const MAX_HOOKS = 4;

/**
 * Write-time hints for the given modules ("" when there is nothing to
 * say): their JS (#1198) and lists they render twice (#1371).
 *
 * @param moduleIds - the modules this write created or whose html, js or fields it changed.
 */
export async function moduleWriteGuardSuffix(
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
  let layouts: GuardLayout[] | null = null;
  const readLayouts = async () => {
    layouts ??= await listLayouts(ctx, toolCtx);
    return layouts;
  };
  const jsHints = await moduleJsHints(catalog, moduleIds, readLayouts);
  const written = catalog.filter((m) => moduleIds.includes(m.id));
  const binds = written.some((m) =>
    (m.fields ?? []).some((f) => (f as { kind?: unknown }).kind === "list"),
  );
  const chromeSlugs = binds
    ? new Set((await readLayouts()).flatMap((l) => l.blocks.flatMap((b) => b.moduleSlugs)))
    : new Set<string>();
  const weightHints = binds ? pageWeightHints(catalog, moduleIds, chromeSlugs) : [];
  return (
    (jsHints.length === 0 ? "" : ` module-js-guard: ${jsHints.join(". ")}.`) +
    (weightHints.length === 0 ? "" : ` page-weight-guard: ${weightHints.join(". ")}.`)
  );
}

/** The module-JS hints (#1198) for the written modules that carry a script. */
async function moduleJsHints(
  catalog: readonly GuardModule[],
  moduleIds: readonly string[],
  readLayouts: () => Promise<GuardLayout[]>,
): Promise<string[]> {
  const written = catalog.filter((m) => moduleIds.includes(m.id) && m.js.trim().length > 0);
  if (written.length === 0) return [];

  const owners = hookOwners(catalog);
  const byId = new Map(catalog.map((m) => [m.id, m]));
  let neutral: Set<string> | null = null;
  const hints: string[] = [];
  for (const m of written) {
    const facts = analyseModuleJs(m.js);
    const name = `"${m.displayName}"`;
    if (facts.hooks.length > 0 && !hasNestedFields(m)) {
      neutral ??= new Set((await readLayouts()).flatMap((l) => [...templateHooks(l.html)]));
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
  return hints;
}

function hasNestedFields(m: GuardModule): boolean {
  return (m.fields ?? []).some((f) => {
    const kind = (f as { kind?: unknown }).kind;
    return kind === "module" || kind === "module-list";
  });
}

/** Every layout (own markup + chrome slugs); empty on a failed read. */
async function listLayouts(ctx: ExecutionContext, toolCtx: ToolContext): Promise<GuardLayout[]> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {
    includeDeleted: false,
  });
  if (!r.ok) return [];
  return (r.value as { layouts?: GuardLayout[] }).layouts ?? [];
}
