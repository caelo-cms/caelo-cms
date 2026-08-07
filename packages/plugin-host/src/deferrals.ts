// SPDX-License-Identifier: MPL-2.0

/**
 * Module deferrals — withholding a module's content until a plugin says
 * otherwise (#450).
 *
 * A plugin knows things about a module that the module's author does
 * not: this one embeds YouTube, and until the visitor has agreed to
 * marketing cookies it must not reach YouTube at all. Stripping the
 * element in the browser is too late — the request has already gone
 * out. The decision has to be made where the page is BUILT.
 *
 * So core emits the module's real HTML inside an inert `<template>`
 * alongside a visible placeholder module, and the plugin's client
 * runtime (#449) clones it into place once its condition is met.
 * Browsers issue no requests for anything inside a `<template>`, so
 * "not yet loaded" is a fact about the network, not a promise about
 * the DOM.
 *
 * ## Deliberately not about consent
 *
 * Core learns "withheld by plugin X for reason Y" and nothing more.
 * Consent is one caller; a paywall and an auth gate want the same
 * primitive, and none of their vocabulary belongs in the composer.
 *
 * ## Per module, not per placement
 *
 * A video module classified once is withheld everywhere it appears —
 * including from a layout, which is where site-wide chrome lives. A
 * per-placement decision would have to be repeated for every page and
 * would silently miss the next one.
 */

import { type ModuleDeferralSpec, moduleDeferralSpec } from "@caelo-cms/plugin-sdk";
import { execute, type OperationRegistry } from "@caelo-cms/query-api";
import { type ModuleFieldKind, renderTemplate } from "@caelo-cms/shared";
import {
  hostInfra,
  hostSystemActorId,
  isPluginDisabled,
  loadedPlugins,
  runPluginOperation,
} from "./dispatch.js";

/** What the composer needs to emit one withheld module. */
export interface ResolvedDeferral {
  readonly pluginSlug: string;
  readonly reason: string;
  readonly placeholderModuleSlug: string;
  /** The placeholder module, already rendered from its field defaults. */
  readonly placeholderHtml: string;
  readonly placeholderCss: string;
}

/** moduleId → the verdict withholding it. Absent means "renders normally". */
export type ResolvedDeferrals = ReadonlyMap<string, ResolvedDeferral>;

interface ModuleRow {
  slug: string;
  html: string;
  css: string;
  fields?: ReadonlyArray<{ name: string; kind?: ModuleFieldKind; default?: unknown }>;
}

/**
 * Resolve which of these modules are withheld, and render each one's
 * placeholder.
 *
 * Loud, per CLAUDE.md §2, on every branch that could otherwise degrade
 * quietly: a failing plugin op, an ill-formed verdict, two plugins
 * disagreeing about one module, and a placeholder module that does not
 * exist all throw. Rendering the withheld module normally because the
 * placeholder was missing would leak the very request the deferral
 * exists to prevent — the least acceptable silent fallback in this
 * codebase.
 *
 * @param moduleIds every module in the current render pass.
 */
export async function resolveModuleDeferrals(
  moduleIds: ReadonlyArray<string>,
): Promise<ResolvedDeferrals> {
  const out = new Map<string, ResolvedDeferral>();
  if (moduleIds.length === 0) return out;

  const contributors = loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.deferralsOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (contributors.length === 0) return out;

  const raw = new Map<string, { pluginSlug: string; spec: ModuleDeferralSpec }>();
  for (const lp of contributors) {
    const operationName = lp.definition.deferralsOperation as string;
    const r = await runPluginOperation({
      pluginSlug: lp.slug,
      operationName,
      args: { moduleIds: [...moduleIds] },
    });
    if (!r.ok) {
      throw new Error(
        `deferrals: ${lp.slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const value = (r.value as { deferrals?: Record<string, unknown> }).deferrals ?? {};
    for (const [moduleId, entry] of Object.entries(value)) {
      const parsed = moduleDeferralSpec.safeParse(entry);
      if (!parsed.success) {
        throw new Error(
          `deferrals: plugin "${lp.slug}" returned an invalid verdict for module ${moduleId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      const existing = raw.get(moduleId);
      if (existing && existing.pluginSlug !== lp.slug) {
        // Two plugins withholding one module cannot both be honoured —
        // whichever placeholder won would silently discard the other's
        // condition, and the visitor would satisfy one gate and pass
        // both.
        throw new Error(
          `deferrals: module ${moduleId} is withheld by both "${existing.pluginSlug}" and "${lp.slug}". A module can have at most one gate.`,
        );
      }
      raw.set(moduleId, { pluginSlug: lp.slug, spec: parsed.data });
    }
  }
  if (raw.size === 0) return out;

  const placeholders = await loadPlaceholders(
    new Set([...raw.values()].map((v) => v.spec.placeholderModuleSlug)),
  );
  for (const [moduleId, { pluginSlug, spec }] of raw) {
    const mod = placeholders.get(spec.placeholderModuleSlug);
    if (!mod) {
      throw new Error(
        `deferrals: plugin "${pluginSlug}" withholds module ${moduleId} behind placeholder module "${spec.placeholderModuleSlug}", which does not exist. Create it (or point the plugin at one) — rendering the withheld module instead would issue exactly the request the gate exists to prevent.`,
      );
    }
    // A field without a `kind` predates the typed schema; the composer
    // treats those as plain primitives, so mirror that here rather than
    // dropping the field and shipping a raw `{{name}}` to the visitor.
    const fields = (mod.fields ?? []).map((f) => ({
      name: f.name,
      kind: f.kind ?? ("text" as ModuleFieldKind),
      ...(f.default !== undefined ? { default: f.default } : {}),
    }));
    const rendered = renderTemplate({ html: mod.html, fields });
    out.set(moduleId, {
      pluginSlug,
      reason: spec.reason,
      placeholderModuleSlug: spec.placeholderModuleSlug,
      placeholderHtml: rendered.html,
      placeholderCss: mod.css,
    });
  }
  return out;
}

/** One `modules.list` read for every placeholder in the pass. */
async function loadPlaceholders(slugs: ReadonlySet<string>): Promise<Map<string, ModuleRow>> {
  const infra = hostInfra();
  const r = await execute(
    infra.registry as OperationRegistry,
    infra.adapter,
    { actorId: hostSystemActorId(), actorKind: "system", requestId: "plugin-deferrals" },
    "modules.list",
    {},
  );
  if (!r.ok) {
    throw new Error(`deferrals: modules.list failed: ${JSON.stringify(r.error)}`);
  }
  const out = new Map<string, ModuleRow>();
  for (const m of (r.value as { modules: ModuleRow[] }).modules) {
    if (slugs.has(m.slug)) out.set(m.slug, m);
  }
  return out;
}
