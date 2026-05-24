// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.1 — Recursive module renderer. Pure function so it's
 * unit-testable without the compose stack. `pages.render_preview`
 * fetches the data + calls into here.
 *
 * v0.13 (#71) — Substitution + iteration moved into the shared
 * template engine (`@caelo-cms/shared/template-engine`). This file
 * keeps the recursion + cycle-detection + depth-limit guards because
 * those rely on the DB-aware RenderResolver to walk nested module /
 * content_instance refs. Per-call shape:
 *   1. `renderInner` validates the (moduleId, contentInstanceId)
 *      pair against the resolver and the depth / cycle bookkeeping.
 *   2. The new `substituteWithRecursion` pre-resolves every nested
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
 *     gap in the preview.
 *
 * CSS + JS dedup: every unique module touched during recursion
 * contributes its CSS + JS once. The caller collects the seen-set out
 * of band so the page's <head>/<style> + footer scripts are stable.
 */

import { type ModuleFieldKind, renderTemplate } from "@caelo-cms/shared";

const MAX_RECURSION_DEPTH = 8;

export interface ModuleResource {
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

export interface ContentInstanceResource {
  readonly id: string;
  readonly moduleId: string;
  readonly values: Record<string, unknown>;
  readonly deletedAt: string | null;
}

export interface NestedRefValue {
  readonly moduleId: string;
  readonly contentInstanceId: string;
}

/**
 * Resolver supplied by `pages.render_preview` after batch-loading every
 * module + content_instance the page might reference (walks values
 * recursively before render to avoid N+1 queries during the recursion
 * itself).
 */
export interface RenderResolver {
  getModule(moduleId: string): ModuleResource | null;
  getContentInstance(contentInstanceId: string): ContentInstanceResource | null;
}

export interface RenderResult {
  readonly html: string;
  /** Modules whose CSS/JS this render touched (caller dedupes by slug). */
  readonly touchedModuleIds: ReadonlySet<string>;
  /** Slots whose nested ref couldn't resolve (cycle / missing / depth limit). */
  readonly missingSlots: readonly string[];
}

interface RenderContext {
  readonly resolver: RenderResolver;
  readonly touched: Set<string>;
  readonly missing: string[];
  readonly path: ReadonlySet<string>;
  readonly depth: number;
}

function isNestedRef(v: unknown): v is NestedRefValue {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { moduleId?: unknown }).moduleId === "string" &&
    typeof (v as { contentInstanceId?: unknown }).contentInstanceId === "string"
  );
}

function comment(reason: string): string {
  return `<!-- caelo:missing reason=${reason} -->`;
}

/**
 * Render a module's HTML against a content_instance's values, recursing
 * into nested-module fields.
 */
export function renderModuleWithContent(
  moduleId: string,
  contentInstanceId: string,
  resolver: RenderResolver,
): RenderResult {
  const touched = new Set<string>();
  const missing: string[] = [];
  const html = renderInner(moduleId, contentInstanceId, {
    resolver,
    touched,
    missing,
    path: new Set<string>(),
    depth: 0,
  });
  return { html, touchedModuleIds: touched, missingSlots: missing };
}

function renderInner(moduleId: string, contentInstanceId: string, ctx: RenderContext): string {
  if (ctx.depth >= MAX_RECURSION_DEPTH) {
    ctx.missing.push(`depth-limit:${moduleId}/${contentInstanceId}`);
    return comment(`depth-limit-${MAX_RECURSION_DEPTH}`);
  }
  const cycleKey = `${moduleId}:${contentInstanceId}`;
  if (ctx.path.has(cycleKey)) {
    ctx.missing.push(`cycle:${cycleKey}`);
    return comment(`cycle ${cycleKey}`);
  }

  const mod = ctx.resolver.getModule(moduleId);
  if (!mod) {
    ctx.missing.push(`module-missing:${moduleId}`);
    return comment(`module-missing ${moduleId}`);
  }
  const ci = ctx.resolver.getContentInstance(contentInstanceId);
  if (!ci || ci.deletedAt !== null) {
    ctx.missing.push(`content-instance-missing:${contentInstanceId}`);
    return comment(`content-instance-missing ${contentInstanceId}`);
  }
  if (ci.moduleId !== moduleId) {
    ctx.missing.push(
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
    path,
    depth: ctx.depth + 1,
  };

  return substituteWithRecursion(mod, ci, childCtx);
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
  mod: ModuleResource,
  ci: ContentInstanceResource,
  ctx: RenderContext,
): string {
  const partials: Record<string, string> = {};
  for (const field of mod.fields) {
    if (field.kind === "module") {
      const ref = ci.values[field.name];
      if (isNestedRef(ref)) {
        partials[field.name] = renderInner(ref.moduleId, ref.contentInstanceId, ctx);
      }
      continue;
    }
    if (field.kind === "module-list") {
      const raw = Object.hasOwn(ci.values, field.name) ? ci.values[field.name] : field.default;
      if (!Array.isArray(raw)) continue;
      for (let i = 0; i < raw.length; i += 1) {
        const el = raw[i];
        if (!isNestedRef(el)) continue; // engine emits module-list-malformed
        partials[`${field.name}__${i}`] = renderInner(el.moduleId, el.contentInstanceId, ctx);
      }
    }
  }

  const result = renderTemplate({
    html: mod.html,
    fields: mod.fields,
    contentValues: ci.values,
    partials,
  });
  for (const m of result.missingSlots) ctx.missing.push(m);
  return result.html;
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
