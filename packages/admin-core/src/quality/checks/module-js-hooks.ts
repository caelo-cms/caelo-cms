// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1198 — which module owns a DOM hook, and which hooks a module's
 * JS takes from other modules (the `structure/foreign-module-js` and
 * `structure/site-wide-module-js` rules, structure-js.ts; the write-time
 * hint, ai/tools/_module-js-guard.ts).
 *
 * A module owns the hooks its template renders: classes, ids and `data-*`
 * attribute names, quoted or not. Layout chrome and the platform's own
 * hooks are neutral. A hook three or more modules render is shared by
 * design; one that one or two render is theirs, and a `caelo:site-wide:`
 * declaration never covers it.
 */

import { stripMustache } from "@caelo-cms/shared";
import type { ModuleJsFacts } from "./module-js-analysis.js";

/** The hooks a template renders: its classes, ids and `data-*` attribute names. */
export function templateHooks(html: string): Set<string> {
  const markup = stripMustache(html);
  const out = new Set<string>();
  // Quoted or unquoted (`class=hero`): both are valid HTML.
  for (const m of markup.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    for (const c of (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/)) if (c) out.add(`.${c}`);
  }
  for (const m of markup.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (v) out.add(`#${v}`);
  }
  for (const m of markup.matchAll(/\s(data-[\w-]+)/gi))
    out.add(`[${(m[1] as string).toLowerCase()}]`);
  return out;
}

/** Platform hooks every module may use (the interaction kit, composer stamps). */
function isPlatformHook(hook: string): boolean {
  return hook.startsWith("[data-caelo-") || hook.startsWith(".caelo-");
}

/**
 * A hook three or more modules render is shared by design (`[data-reveal]`
 * on every section); one that one or two modules render is theirs — two,
 * because a pattern kept as two module copies (the demo form) is still
 * one component.
 */
const SHARED_HOOK_OWNERS = 3;

/** How a module's JS relates to the hooks other modules render. */
export interface ForeignHooks {
  /** Other module id → hooks of that module's own markup the JS drives. */
  readonly specific: ReadonlyMap<string, readonly string[]>;
  /** Shared hooks (rendered by three or more modules) the JS drives without a site-wide declaration. */
  readonly shared: readonly string[];
}

/**
 * The hooks a module's JS takes from other modules.
 *
 * @param own - the module itself plus every module nested inside it.
 * @param owners - hook → ids of the modules whose templates render it.
 * @param neutral - hooks of the layout chrome, which any module may drive.
 */
export function foreignHooks(
  facts: ModuleJsFacts,
  own: ReadonlySet<string>,
  owners: ReadonlyMap<string, ReadonlySet<string>>,
  neutral: ReadonlySet<string> = new Set(),
): ForeignHooks {
  const specific = new Map<string, string[]>();
  const shared: string[] = [];
  for (const hook of facts.hooks) {
    if (isPlatformHook(hook) || neutral.has(hook)) continue;
    const by = owners.get(hook);
    if (!by || by.size === 0 || [...by].some((id) => own.has(id))) continue;
    if (by.size >= SHARED_HOOK_OWNERS) {
      if (facts.siteWide === null || facts.siteWide.length === 0) shared.push(hook);
      continue;
    }
    for (const id of by) specific.set(id, [...(specific.get(id) ?? []), hook]);
  }
  return { specific, shared };
}

/** hook → ids of the modules whose templates render it. */
export function hookOwners(
  modules: readonly { readonly id: string; readonly html: string }[],
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const m of modules) {
    for (const h of templateHooks(m.html)) {
      const set = owners.get(h) ?? new Set<string>();
      set.add(m.id);
      owners.set(h, set);
    }
  }
  return owners;
}
