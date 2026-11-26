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

import {
  type DeferralCandidate,
  type DeferralPlaceholderRef,
  type ModuleDeferralSpec,
  moduleDeferralSpec,
  placeholderSlots,
} from "@caelo-cms/plugin-sdk";
import { execute, type OperationRegistry } from "@caelo-cms/query-api";
import { type ComposeDeferral, type ModuleFieldKind, renderTemplate } from "@caelo-cms/shared";
import {
  hostInfra,
  hostSystemActorId,
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { escapePluginText } from "./plugin-values.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import { assertAnswerSize, type RenderPointCall } from "./render-points.js";

/**
 * What the composer needs to emit one withheld module: a gate's
 * placeholder already rendered from its module's field defaults, or an
 * omitted module's editor notice (`null` outside the editor preview).
 */
export type ResolvedDeferral = ComposeDeferral;

/** moduleId → the verdict withholding it. Absent means "renders normally". */
export type ResolvedDeferrals = ReadonlyMap<string, ResolvedDeferral>;

interface ModuleRow {
  slug: string;
  html: string;
  css: string;
  fields?: ReadonlyArray<{ name: string; kind?: ModuleFieldKind; default?: unknown }>;
}

/**
 * #1271 — whether any running plugin decides deferrals. Without one no
 * module is withheld, so a build need not load every module's content to
 * ask.
 */
export function hasDeferralContributors(): boolean {
  return loadedPlugins
    .all()
    .some(
      (lp) => !isPluginDisabled(lp.slug) && typeof lp.definition.deferralsOperation === "string",
    );
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
 * @param modules every module in the current render pass, with the
 *   content about to ship, so a gate judges what is rendered rather than
 *   a verdict recorded before the latest edit.
 */
export async function resolveModuleDeferrals(
  modules: ReadonlyArray<DeferralCandidate>,
  scope: RenderScope,
): Promise<ResolvedDeferrals> {
  const out = new Map<string, ResolvedDeferral>();
  if (modules.length === 0) return out;

  const contributors = loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.deferralsOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (contributors.length === 0) return out;

  const raw = new Map<string, { pluginSlug: string; spec: ModuleDeferralSpec }>();
  const chunks = chunkModules(modules);
  for (const lp of contributors) {
    const operationName = lp.definition.deferralsOperation as string;
    const label = `deferrals: ${lp.slug}.${operationName}`;
    let skipped = false;
    for (const chunk of chunks) {
      const r = await runPluginOperation({
        invocation: renderInvocation(scope),
        pluginSlug: lp.slug,
        operationName,
        args: { moduleIds: chunk.map((m) => m.moduleId), modules: chunk },
        maxAnswerBytes: DEFERRALS_CALL.maxAnswerBytes,
      });
      if (!r.ok) {
        const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
        // #1087 — a preview shows the modules ungated and flags it; a build
        // throws (it must never ship a gated module ungated).
        if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "deferrals", reason })) {
          skipped = true;
          break;
        }
        throw new Error(reason);
      }
      assertAnswerSize(DEFERRALS_CALL, label, r.value);
      const asked = new Set(chunk.map((m) => m.moduleId));
      const value = (r.value as { deferrals?: Record<string, unknown> } | null)?.deferrals ?? {};
      for (const [moduleId, entry] of Object.entries(value)) {
        if (!asked.has(moduleId)) {
          throw new Error(`${label}: answered for module ${moduleId}, which was not asked about`);
        }
        const parsed = moduleDeferralSpec.safeParse(entry);
        if (!parsed.success) {
          throw new Error(
            `deferrals: plugin "${lp.slug}" returned an invalid verdict for module ${moduleId}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
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
    if (skipped) {
      for (const [moduleId, v] of raw) if (v.pluginSlug === lp.slug) raw.delete(moduleId);
    }
  }
  if (raw.size === 0) return out;

  const gates = new Map<string, { pluginSlug: string; spec: ModuleGateSpec }>();
  for (const [moduleId, { pluginSlug, spec }] of raw) {
    if (!("omit" in spec)) {
      gates.set(moduleId, { pluginSlug, spec });
      continue;
    }
    // The notice explains to the operator why the module is missing;
    // a visitor gets nothing in its place.
    out.set(moduleId, {
      pluginSlug,
      reason: spec.reason,
      omit: true,
      editorNotice: scope.editorPreview
        ? declaredPlaceholder(pluginSlug, spec.editorNotice, moduleId)
        : null,
    });
  }
  if (gates.size === 0) return out;

  const placeholders = await loadPlaceholders(
    new Set([...gates.values()].map((v) => v.spec.placeholderModuleSlug)),
  );
  for (const [moduleId, { pluginSlug, spec }] of gates) {
    const mod = placeholders.get(spec.placeholderModuleSlug);
    if (!mod && spec.placeholder) {
      // The plugin ships a placeholder of its own; the page keeps
      // rendering until someone designs the site's module for it.
      const placeholder = declaredPlaceholder(pluginSlug, spec.placeholder, moduleId);
      out.set(moduleId, {
        pluginSlug,
        reason: spec.reason,
        placeholderModuleSlug: spec.placeholderModuleSlug,
        placeholderHtml: placeholder.html,
        placeholderCss: placeholder.css,
      });
      continue;
    }
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

type ModuleGateSpec = Exclude<ModuleDeferralSpec, { omit: true }>;

/**
 * Bytes of modules one deferrals call carries. Every module of the pass
 * ships with its content, so a build of a large site asks in several
 * calls, each well under the 1 MB message line.
 */
const DEFERRAL_CHUNK_BYTES = 512 * 1024;

/** A verdict is a reason, a placeholder name and short text: 1 MB per call is far beyond any real answer. */
const DEFERRALS_CALL: RenderPointCall = { point: "deferrals", maxAnswerBytes: 1024 * 1024 };

/** Split the pass's modules into calls of about {@link DEFERRAL_CHUNK_BYTES}, in order. */
export function chunkModules(
  modules: ReadonlyArray<DeferralCandidate>,
  maxBytes = DEFERRAL_CHUNK_BYTES,
): DeferralCandidate[][] {
  const chunks: DeferralCandidate[][] = [];
  let chunk: DeferralCandidate[] = [];
  let bytes = 0;
  for (const m of modules) {
    const size = Buffer.byteLength(JSON.stringify(m)) + 1;
    if (chunk.length > 0 && bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(m);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

const SLOT_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/**
 * #1729 — the markup a verdict names: one of the plugin's reviewed
 * `deferralPlaceholders`, its `{{name}}` slots filled with the verdict's
 * text, escaped. A verdict carries data, never markup, so a plugin cannot
 * put a script or a third-party request where a withheld embed was.
 *
 * Loud: a name the manifest does not declare, a slot without a value and
 * a value for no slot all throw. A placeholder rendered with a raw
 * `{{slot}}` would read as broken, and a guessed one would be a fallback.
 */
export function declaredPlaceholder(
  pluginSlug: string,
  ref: DeferralPlaceholderRef,
  moduleId: string,
): { html: string; css: string } {
  const declared = loadedPlugins.bySlug(pluginSlug)?.definition.deferralPlaceholders ?? {};
  const decl = Object.hasOwn(declared, ref.name) ? declared[ref.name] : undefined;
  if (!decl) {
    throw new Error(
      `deferrals: plugin "${pluginSlug}" names placeholder "${ref.name}" for module ${moduleId}, which its manifest does not declare (declared: ${Object.keys(declared).join(", ") || "none"}). A placeholder is reviewed markup: the plugin has to declare it in deferralPlaceholders (a new version).`,
    );
  }
  const values = ref.values ?? {};
  const slots = placeholderSlots(decl.html);
  const missing = slots.filter((s) => !Object.hasOwn(values, s));
  const extra = Object.keys(values).filter((k) => !slots.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `deferrals: plugin "${pluginSlug}" fills placeholder "${ref.name}" for module ${moduleId} with the wrong values${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}${extra.length > 0 ? `; not a slot of it: ${extra.join(", ")}` : ""}`,
    );
  }
  return {
    html: decl.html.replace(SLOT_RE, (_m, name: string) => escapePluginText(values[name] ?? "")),
    css: decl.css,
  };
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
