// SPDX-License-Identifier: MPL-2.0

/**
 * Recursive module renderer — the ONE renderer for nested modules
 * (`module` / `module-list` fields), shared by the editor preview
 * (`pages.render_preview`, which pre-renders each placement through
 * `renderModuleWithContent`) and the composer (`composePageWithLayout`
 * with a `nestedModules` resolver, which the static generator supplies
 * so deployed pages render nested modules exactly as the preview does).
 * Pure function so it's unit-testable without the compose stack; the
 * callers fetch the data and hand it over through a resolver.
 *
 * Substitution + iteration live in the shared template engine
 * (`./template-engine.ts`). This file keeps the recursion +
 * cycle-detection + depth-limit guards. Per-call shape:
 *   1. `renderInner` validates the (moduleId, contentInstanceId)
 *      pair against the resolver and the depth / cycle bookkeeping.
 *   2. `substituteWithRecursion` pre-resolves every nested
 *      ref declared via field.kind === 'module' / 'module-list' by
 *      recursing through `renderInner`, builds a deterministic
 *      partials map (`<name>` for single refs, `<name>__<index>`
 *      for list elements), and hands the engine the HTML + view +
 *      partials.
 *   3. The engine performs primitive substitution, section
 *      iteration, and loud-raw / failure-marker emission. Its
 *      `missingSlots` are merged into the recursion context's
 *      `missing` array.
 *
 * Template grammar (extends v0.4.0's `{{fieldName}}` with two nested
 * forms):
 *
 *   {{fieldName}}                      — primitive substitution (text,
 *                                        richtext, url, image, ...).
 *   {{>fieldName}}                     — single nested module slot
 *                                        (field kind = 'module').
 *                                        values[fieldName] is
 *                                        { moduleId, contentInstanceId }.
 *   {{#fieldName}}…{{/fieldName}}      — section over a list field
 *                                        (kind = text-list / link-list
 *                                        / module-list). text-list /
 *                                        link-list iterate the inner
 *                                        template; module-list ignores
 *                                        the inner and renders each
 *                                        element's nested module HTML
 *                                        via `renderInner` (recursion).
 *
 * Pre-1.0 fail-loud (CLAUDE.md §2):
 *   - Depth limit 8 — beyond that, emit an HTML comment naming the
 *     limit + add a `missingSlots` entry; do NOT silently truncate.
 *   - Cycle detection — track `(moduleId, contentInstanceId)` pairs on
 *     the recursion path; on revisit, comment + missingSlots entry.
 *   - Missing referenced module / soft-deleted content_instance —
 *     comment + missingSlots entry. Same channel; the operator sees the
 *     gap in the preview, and the static generator refuses the build.
 *
 * CSS + JS dedup: every unique module touched during recursion
 * contributes its CSS + JS once. The caller collects the seen-set out
 * of band so the page's <head>/<style> + footer scripts are stable.
 */

import type { ModuleFieldKind } from "./content.js";
import { caeloMissingComment, renderTemplate, type TemplateField } from "./template-engine.js";

const MAX_RECURSION_DEPTH = 8;

/** A module the recursion can render: its code plus its field schema. */
export interface NestedModuleResource {
  readonly moduleId: string;
  readonly slug: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  readonly fields: readonly {
    readonly name: string;
    readonly kind: ModuleFieldKind;
    readonly default?: unknown;
  }[];
}

/** A content instance the recursion can render a nested module with. */
export interface NestedContentInstanceResource {
  readonly id: string;
  readonly moduleId: string;
  readonly values: Record<string, unknown>;
  readonly deletedAt: string | null;
}

/** The stored shape of a `module` field value / `module-list` element. */
export interface NestedRefValue {
  readonly moduleId: string;
  readonly contentInstanceId: string;
}

/**
 * Resolver supplied by `pages.render_preview` and the static generator
 * after batch-loading every module + content_instance the page might
 * reference (walks values recursively before render to avoid N+1
 * queries during the recursion itself).
 */
export interface NestedRenderResolver {
  getModule(moduleId: string): NestedModuleResource | null;
  getContentInstance(contentInstanceId: string): NestedContentInstanceResource | null;
}

/**
 * One failure marker, attributed to the field it happened under so a
 * refused deploy can name it.
 */
export interface NestedRenderFailure {
  /**
   * Field trail from the rendered module down to where the failure
   * happened, e.g. `plans[1]` or `plans[1] > cta`; empty when the
   * failure is in the rendered module's own template (the marker itself
   * then names the field).
   */
  readonly field: string;
  /** The `missingSlots` marker, verbatim. */
  readonly reason: string;
}

/** Output of the recursive renderer. */
export interface NestedRenderResult {
  readonly html: string;
  /** Modules whose CSS/JS this render touched (caller dedupes by slug). */
  readonly touchedModuleIds: ReadonlySet<string>;
  /** Slots whose nested ref couldn't resolve (cycle / missing / depth limit). */
  readonly missingSlots: readonly string[];
  /** The same markers as `missingSlots`, each with its field trail. */
  readonly failures: readonly NestedRenderFailure[];
}

/**
 * v0.11.1 (issue #76) — active theme's resolved asset URLs threaded
 * through the recursion so module HTML carrying `{{theme_logo_url}}`
 * etc. resolves inside nested modules the same way it does in placed
 * ones.
 */
export interface NestedRenderThemeAssets {
  readonly logo: string | null;
  readonly logoDark: string | null;
  readonly favicon: string | null;
  readonly socialShare: string | null;
}

interface RenderContext {
  readonly resolver: NestedRenderResolver;
  readonly touched: Set<string>;
  readonly missing: string[];
  readonly failures: NestedRenderFailure[];
  /** Field trail of the module being rendered (see NestedRenderFailure). */
  readonly via: string;
  readonly path: ReadonlySet<string>;
  readonly depth: number;
  /** v0.11.1 (issue #76) — see NestedRenderThemeAssets. Undefined when no
   *  active theme on this install (renderer emits loud-raw for any
   *  `{{theme_<slot>_url}}` placeholders). */
  readonly themeAssets: NestedRenderThemeAssets | undefined;
  /** Plugin data lists for the page being rendered, and the names of
   *  installed-but-inactive plugins' lists. Threaded to every nested
   *  module: a switcher can sit inside a nested chrome module. */
  readonly dataLists: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string>>>>>;
  readonly dormantDataLists: Readonly<Record<string, string>>;
}

function isNestedRef(v: unknown): v is NestedRefValue {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { moduleId?: unknown }).moduleId === "string" &&
    typeof (v as { contentInstanceId?: unknown }).contentInstanceId === "string"
  );
}

// Shared with the template engine so the failure-comment shape is
// declared in exactly one place (`packages/shared/src/template-engine.ts`).
// The chat-runner diag pass + editor missing-content surface depend on
// this exact `<!-- caelo:missing reason=… -->` byte sequence.
const comment = caeloMissingComment;

function fail(ctx: RenderContext, reason: string): void {
  ctx.missing.push(reason);
  ctx.failures.push({ field: ctx.via, reason });
}

/**
 * Render a module's HTML against a content_instance's values, recursing
 * into nested-module fields.
 */
export function renderModuleWithContent(
  moduleId: string,
  contentInstanceId: string,
  resolver: NestedRenderResolver,
  themeAssets?: NestedRenderThemeAssets,
  pluginLists?: {
    readonly dataLists: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string>>>>>;
    readonly dormantDataLists: Readonly<Record<string, string>>;
  },
): NestedRenderResult {
  const touched = new Set<string>();
  const missing: string[] = [];
  const failures: NestedRenderFailure[] = [];
  const html = renderInner(moduleId, contentInstanceId, {
    resolver,
    touched,
    missing,
    failures,
    via: "",
    path: new Set<string>(),
    depth: 0,
    themeAssets,
    dataLists: pluginLists?.dataLists ?? {},
    dormantDataLists: pluginLists?.dormantDataLists ?? {},
  });
  return { html, touchedModuleIds: touched, missingSlots: missing, failures };
}

function renderInner(moduleId: string, contentInstanceId: string, ctx: RenderContext): string {
  if (ctx.depth >= MAX_RECURSION_DEPTH) {
    fail(ctx, `depth-limit:${moduleId}/${contentInstanceId}`);
    return comment(`depth-limit-${MAX_RECURSION_DEPTH}`);
  }
  const cycleKey = `${moduleId}:${contentInstanceId}`;
  if (ctx.path.has(cycleKey)) {
    fail(ctx, `cycle:${cycleKey}`);
    return comment(`cycle ${cycleKey}`);
  }

  const mod = ctx.resolver.getModule(moduleId);
  if (!mod) {
    fail(ctx, `module-missing:${moduleId}`);
    return comment(`module-missing ${moduleId}`);
  }
  const ci = ctx.resolver.getContentInstance(contentInstanceId);
  if (!ci || ci.deletedAt !== null) {
    fail(ctx, `content-instance-missing:${contentInstanceId}`);
    return comment(`content-instance-missing ${contentInstanceId}`);
  }
  if (ci.moduleId !== moduleId) {
    fail(
      ctx,
      `content-instance-mismatch:${contentInstanceId} (for ${ci.moduleId}, expected ${moduleId})`,
    );
    return comment(`content-instance-mismatch ${contentInstanceId}`);
  }
  ctx.touched.add(moduleId);

  const path = new Set(ctx.path);
  path.add(cycleKey);
  const childCtx: RenderContext = {
    resolver: ctx.resolver,
    touched: ctx.touched,
    missing: ctx.missing,
    failures: ctx.failures,
    via: ctx.via,
    path,
    depth: ctx.depth + 1,
    themeAssets: ctx.themeAssets,
    dataLists: ctx.dataLists,
    dormantDataLists: ctx.dormantDataLists,
  };

  return substituteWithRecursion(mod.html, mod.fields, ci.values, childCtx);
}

/**
 * v0.13 (#71) — Thin wrapper around the shared template engine.
 * Pre-resolves nested module / module-list refs by recursing through
 * `renderInner` (which keeps the depth-limit + cycle-detection +
 * module-missing / content-instance-missing guards), builds the
 * partials map the engine consumes, then delegates substitution +
 * loud-raw + failure-marker emission to the engine.
 *
 * Partial-key contract (matches the engine's expectations):
 *   - single `{{>name}}` (module field): partials[<name>] = rendered
 *     HTML (or the loud comment from renderInner if recursion failed).
 *   - `{{#name}}…{{/name}}` over module-list: partials[`<name>__<i>`]
 *     = rendered HTML for element i. Malformed elements (non-NestedRef
 *     shape) are NOT pre-resolved — the engine emits the existing
 *     `module-list-malformed:<name>[<i>]` marker.
 *
 * Failure-marker parity: every literal `missingSlots` string the
 * legacy hand-rolled substitution emitted is preserved — half by the
 * engine (kind-mismatch, *-malformed, module-ref-malformed,
 * field-not-declared), half by `renderInner` (depth-limit, cycle,
 * module-missing, content-instance-missing, content-instance-mismatch).
 * The chat-runner diag pass + editor missing-content surface match
 * these strings literally; renaming any is a silent regression.
 */
function substituteWithRecursion(
  html: string,
  fields: readonly TemplateField[],
  values: Readonly<Record<string, unknown>>,
  ctx: RenderContext,
): string {
  const partials: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === "module") {
      const ref = values[field.name];
      if (isNestedRef(ref)) {
        partials[field.name] = renderInner(
          ref.moduleId,
          ref.contentInstanceId,
          descend(ctx, field.name),
        );
      }
      continue;
    }
    if (field.kind === "module-list") {
      const raw = Object.hasOwn(values, field.name) ? values[field.name] : field.default;
      if (!Array.isArray(raw)) continue;
      for (let i = 0; i < raw.length; i += 1) {
        const el = raw[i];
        if (!isNestedRef(el)) continue; // engine emits module-list-malformed
        partials[`${field.name}__${i}`] = renderInner(
          el.moduleId,
          el.contentInstanceId,
          descend(ctx, `${field.name}[${i}]`),
        );
      }
    }
  }

  const result = renderTemplate({
    html,
    fields,
    contentValues: values,
    partials,
    themeAssets: ctx.themeAssets,
    dataLists: ctx.dataLists,
    dormantDataLists: ctx.dormantDataLists,
  });
  for (const m of result.missingSlots) fail(ctx, m);
  return result.html;
}

/** The context for rendering the nested module at `step` under ctx's module. */
function descend(ctx: RenderContext, step: string): RenderContext {
  return { ...ctx, via: ctx.via.length > 0 ? `${ctx.via} > ${step}` : step };
}

/**
 * A module as the composer places it: its HTML, fields and the values
 * that fill them (a content instance's values, possibly replaced by a
 * content variant), but not necessarily a row the resolver knows.
 */
export interface NestedRenderPlacement {
  readonly html: string;
  readonly fields: readonly TemplateField[];
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * Render a placed module whose nested `module` / `module-list` fields
 * resolve through `resolver` — the composer's entry point. Same
 * recursion, depth limit (8) and failure markers as
 * {@link renderModuleWithContent}; the placed module itself is depth 0.
 *
 * @returns the HTML, the nested modules the render touched (the placed
 *   module only when it also appears nested — the caller owns its
 *   CSS/JS), and every failure marker of the placed module and its
 *   descendants, each with its field trail.
 */
export function renderPlacedModule(
  placement: NestedRenderPlacement,
  resolver: NestedRenderResolver,
  options: {
    readonly themeAssets?: NestedRenderThemeAssets;
    readonly dataLists?: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string>>>>>;
    readonly dormantDataLists?: Readonly<Record<string, string>>;
  },
): NestedRenderResult {
  const touched = new Set<string>();
  const missing: string[] = [];
  const failures: NestedRenderFailure[] = [];
  const html = substituteWithRecursion(placement.html, placement.fields, placement.values, {
    resolver,
    touched,
    missing,
    failures,
    via: "",
    // The placed module's values may be a content variant rather than
    // an instance's own, so it does not seed the cycle path; a ref back
    // to its instance is caught one level down.
    path: new Set<string>(),
    depth: 1,
    themeAssets: options.themeAssets,
    dataLists: options.dataLists ?? {},
    dormantDataLists: options.dormantDataLists ?? {},
  });
  return { html, touchedModuleIds: touched, missingSlots: missing, failures };
}

/**
 * Walk a content_instance's values to find every nested-module reference
 * it carries (single + list shapes). Used by the caller to pre-batch
 * the modules + content_instances the page will need.
 */
export function collectNestedRefs(values: Record<string, unknown>): NestedRefValue[] {
  const refs: NestedRefValue[] = [];
  for (const v of Object.values(values)) {
    if (isNestedRef(v)) {
      refs.push(v);
    } else if (Array.isArray(v)) {
      for (const el of v) {
        if (isNestedRef(el)) refs.push(el);
      }
    }
  }
  return refs;
}
