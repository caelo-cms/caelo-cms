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
 *   2. `substituteWithRecursion` hands the engine the HTML + view +
 *      a partial resolver (`<name>` for single refs, `<name>__<index>`
 *      for list elements) that recurses through `renderInner` only
 *      for the nested refs the template actually dispatches.
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
 *                                        (kind = list / module-list).
 *                                        A `list` iterates the inner
 *                                        template per entry (an entry's
 *                                        `{{>f}}` module field recurses
 *                                        here too); module-list ignores
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
 * Module ids: the root element of every nested module render carries
 * `data-caelo-module-id` (#1027), the same stamp the composer puts on a
 * page placement's root, in the preview and the static build alike.
 *
 * CSS + JS dedup: every unique module touched during recursion
 * contributes its CSS + JS once. The caller collects the seen-set out
 * of band so the page's <head>/<style> + footer scripts are stable.
 */

import { isLinkFailureMarker, type LinkResolver } from "./link-refs.js";
import type { ListPageContext } from "./lists/resolve.js";
import { tagModuleId } from "./module-id-tag.js";
import { caeloMissingComment, renderTemplate, type TemplateField } from "./template-engine.js";

const MAX_RECURSION_DEPTH = 8;

/** A module the recursion can render: its code plus its field schema. */
export interface NestedModuleResource {
  readonly moduleId: string;
  readonly slug: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  readonly fields: readonly TemplateField[];
}

/** A content instance the recursion can render a nested module with. */
export interface NestedContentInstanceResource {
  readonly id: string;
  readonly moduleId: string;
  readonly values: Record<string, unknown>;
  readonly deletedAt: string | null;
  /**
   * The stored content instance these values belong to, when `id` is a
   * render-local alias (the editor's edit-marked copy `edit:<key>`):
   * local list entries are addressed by the real instance id (overlays,
   * `data-caelo-list-item`). Absent = `id` itself.
   */
  readonly listHolderId?: string;
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
  /** The page's list context (`lists/resolve.ts`), threaded to every
   *  nested module so a list renders the same at any depth — a menu
   *  inside a nested chrome module included. */
  readonly lists: ListPageContext | undefined;
  /** Content instance whose values this level renders (local list address). */
  readonly listHolder: string | null;
  /** Epic #724 — resolves internal references in every nested module. */
  readonly linkResolver: LinkResolver | undefined;
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
  lists?: ListPageContext,
  linkResolver?: LinkResolver,
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
    lists,
    listHolder: null,
    linkResolver,
  });
  return { html, touchedModuleIds: touched, missingSlots: missing, failures };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    lists: ctx.lists,
    // Variant content (`variant:<key>`) is no stored instance, so its
    // local list entries carry no instance address.
    listHolder: ci.listHolderId ?? (UUID_RE.test(ci.id) ? ci.id : null),
    linkResolver: ctx.linkResolver,
  };

  return substituteWithRecursion(mod.html, mod.fields, ci.values, childCtx);
}

/**
 * v0.13 (#71) — Thin wrapper around the shared template engine.
 * Hands the engine a partial resolver that recurses through
 * `renderInner` (which keeps the depth-limit + cycle-detection +
 * module-missing / content-instance-missing guards) for exactly the
 * nested refs the template dispatches, then lets the engine do
 * substitution + loud-raw + failure-marker emission.
 *
 * Partial-key contract (matches the engine's expectations):
 *   - single `{{>name}}` (module field): `<name>` → rendered HTML (or
 *     the loud comment from renderInner if recursion failed).
 *   - `{{#name}}…{{/name}}` over module-list: `<name>__<i>` → rendered
 *     HTML for element i. Malformed elements (non-NestedRef shape)
 *     resolve to `undefined` — the engine emits the existing
 *     `module-list-malformed:<name>[<i>]` marker.
 *   - `{{>f}}` inside an entry of list field `<name>`:
 *     `list:<name>/<itemId>/<f>`, with the ref passed alongside (the
 *     entry may come from a shared list, not from `values`).
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
  // Resolved lazily: the engine asks only for the refs the template
  // dispatches (a `{{>name}}` it reaches, a `{{#name}}` module-list
  // section). A declared field the HTML never references is not
  // rendered, so a stale ref in it cannot fail the build and its CSS/JS
  // stays off the page. Memoised: `{{>name}}` twice renders it once.
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const rendered = new Map<string, string | undefined>();
  const partials = (key: string, ref?: NestedRefValue): string | undefined => {
    if (!rendered.has(key)) rendered.set(key, renderPartial(key, ref, fieldByName, values, ctx));
    return rendered.get(key);
  };

  const result = renderTemplate({
    html,
    fields,
    contentValues: values,
    partials,
    themeAssets: ctx.themeAssets,
    lists: ctx.lists,
    listHolder: { contentInstanceId: ctx.listHolder },
    linkResolver: ctx.linkResolver,
  });
  for (const m of result.missingSlots) {
    // A broken reference inside a nested module stays raw in the partial
    // HTML (loud-raw), so the enclosing module's render meets it again.
    // The nested render already reported it with the precise field
    // trail; drop the echo instead of reporting one broken link twice.
    if (isLinkFailureMarker(m) && ctx.missing.includes(m)) continue;
    fail(ctx, m);
  }
  return result.html;
}

/**
 * Render the partial the engine asked for: `<name>` (a `module` field),
 * `<name>__<i>` (element i of a `module-list`) or
 * `list:<name>/<itemId>/<f>` (a list entry's module field, `ref` given).
 * `undefined` when the value is not a well-formed ref — the engine then
 * emits its own `module-ref-malformed` / `module-list-malformed` marker.
 */
function renderPartial(
  key: string,
  ref: NestedRefValue | undefined,
  fieldByName: ReadonlyMap<string, TemplateField>,
  values: Readonly<Record<string, unknown>>,
  ctx: RenderContext,
): string | undefined {
  const hit = nestedRefForPartial(key, ref, fieldByName, values);
  if (!hit) return undefined;
  // #1027 — a nested module's root carries its own id, exactly like a
  // page placement's (the composer tags those), so the live-edit overlay
  // and the quality checks attribute its markup to the nested module
  // instead of reading it as free HTML of the parent. A failure comment
  // has no element and stays as it is.
  return tagModuleId(
    renderInner(hit.ref.moduleId, hit.ref.contentInstanceId, descend(ctx, hit.step)),
    hit.ref.moduleId,
  );
}

/**
 * The nested ref behind partial `key`, with its field trail step
 * (`name` or `name[i]`); `undefined` when the key names no well-formed
 * ref. The one place that maps the engine's partial keys to values.
 */
function nestedRefForPartial(
  key: string,
  ref: NestedRefValue | undefined,
  fieldByName: ReadonlyMap<string, TemplateField>,
  values: Readonly<Record<string, unknown>>,
): { readonly ref: NestedRefValue; readonly field: string; readonly step: string } | undefined {
  if (key.startsWith(LIST_PARTIAL_PREFIX)) {
    const [name, itemId, entryField] = key.slice(LIST_PARTIAL_PREFIX.length).split("/");
    if (!name || !itemId || !entryField || !ref || !isNestedRef(ref)) return undefined;
    return { ref, field: name, step: `${name}[${itemId}].${entryField}` };
  }
  const single = fieldByName.get(key);
  if (single?.kind === "module") {
    const ref = values[key];
    return isNestedRef(ref) ? { ref, field: key, step: key } : undefined;
  }
  const sep = key.lastIndexOf("__");
  const index = key.slice(sep + 2);
  if (sep <= 0 || !/^\d+$/.test(index)) return undefined;
  const name = key.slice(0, sep);
  const list = fieldByName.get(name);
  if (list?.kind !== "module-list") return undefined;
  const raw = Object.hasOwn(values, name) ? values[name] : list.default;
  if (!Array.isArray(raw)) return undefined;
  const i = Number(index);
  const el = raw[i];
  return isNestedRef(el) ? { ref: el, field: name, step: `${name}[${i}]` } : undefined;
}

/** Partial-key prefix of a list entry's embedded module (`template-sections.ts`). */
const LIST_PARTIAL_PREFIX = "list:";

/** A nested ref a module's template dispatches (see {@link dispatchedNestedRefs}). */
export interface DispatchedNestedRef extends NestedRefValue {
  /** The `module` / `module-list` field holding it. */
  readonly field: string;
}

/**
 * Epic #724 (rollout F) — the nested refs that render when this module
 * renders with these values: exactly the refs {@link renderPlacedModule}
 * recurses into. Rendering is lazy (a declared `module` / `module-list`
 * field the HTML never dispatches with `{{>name}}` / `{{#name}}` is not
 * rendered), so a checker that walks every declared field would report
 * links that never ship. This asks the template engine itself which
 * partials it dispatches, so it follows the grammar exactly.
 *
 * @returns one entry per dispatched ref, in render order, deduplicated.
 */
export function dispatchedNestedRefs(
  html: string,
  fields: readonly TemplateField[],
  values: Readonly<Record<string, unknown>>,
  lists?: ListPageContext,
): DispatchedNestedRef[] {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const out: DispatchedNestedRef[] = [];
  const asked = new Set<string>();
  renderTemplate({
    html,
    fields,
    contentValues: values,
    ...(lists ? { lists } : {}),
    partials: (key, ref) => {
      const hit = nestedRefForPartial(key, ref, fieldByName, values);
      if (!hit) return undefined;
      if (!asked.has(key)) {
        asked.add(key);
        out.push({ ...hit.ref, field: hit.field });
      }
      return "";
    },
  });
  return out;
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
    /** The page's list context (`lists/resolve.ts`). */
    readonly lists?: ListPageContext;
    /** The placement's stored content instance (local list address); absent for defaults. */
    readonly contentInstanceId?: string;
    /** Epic #724 — resolves internal references (see `link-refs.ts`). */
    readonly linkResolver?: LinkResolver;
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
    lists: options.lists,
    listHolder: options.contentInstanceId ?? null,
    linkResolver: options.linkResolver,
  });
  return { html, touchedModuleIds: touched, missingSlots: missing, failures };
}

/**
 * Walk a content_instance's values to find every nested-module reference
 * it carries: `module` / `module-list` values and the `module` fields of
 * local list entries at any depth (`{ id, node, values, children }`).
 * Used by the caller to pre-batch the modules + content_instances the
 * page will need.
 */
export function collectNestedRefs(values: Readonly<Record<string, unknown>>): NestedRefValue[] {
  const refs: NestedRefValue[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > MAX_COLLECT_DEPTH || typeof v !== "object" || v === null) return;
    if (isNestedRef(v)) {
      refs.push({ moduleId: v.moduleId, contentInstanceId: v.contentInstanceId });
      return;
    }
    if (Array.isArray(v)) {
      for (const el of v) visit(el, depth + 1);
      return;
    }
    const entry = v as { values?: unknown; children?: unknown };
    if (typeof entry.values === "object" && entry.values !== null) {
      for (const inner of Object.values(entry.values)) visit(inner, depth + 1);
    }
    if (Array.isArray(entry.children)) visit(entry.children, depth + 1);
  };
  for (const v of Object.values(values)) visit(v, 0);
  return refs;
}

/**
 * A copy of `values` in which every nested-module reference
 * {@link collectNestedRefs} finds points at `remap(contentInstanceId)`.
 * Walks exactly the shapes the collector walks, so every ref the collector
 * reports is the ref this rewrites; everything else is copied unchanged.
 * Deep copies (`pages.duplicate`, `placement.fork_content`) use it to point
 * a copied parent at its copied children instead of the source's.
 *
 * @param remap the new instance id for a source id. It should throw for an
 *   id it has no copy for: keeping the source id would leave the copy
 *   sharing nested content with the original.
 */
export function rewriteNestedRefs(
  values: Readonly<Record<string, unknown>>,
  remap: (contentInstanceId: string) => string,
): Record<string, unknown> {
  const visitAll = (v: object, depth: number): unknown =>
    Array.isArray(v)
      ? v.map((el) => visit(el, depth))
      : Object.fromEntries(Object.entries(v).map(([k, el]) => [k, visit(el, depth)]));
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > MAX_COLLECT_DEPTH || typeof v !== "object" || v === null) return v;
    if (isNestedRef(v)) return { ...v, contentInstanceId: remap(v.contentInstanceId) };
    if (Array.isArray(v)) return v.map((el) => visit(el, depth + 1));
    const entry = v as { values?: unknown; children?: unknown };
    const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    if (typeof entry.values === "object" && entry.values !== null) {
      out.values = visitAll(entry.values, depth + 1);
    }
    if (Array.isArray(entry.children)) out.children = visit(entry.children, depth + 1);
    return out;
  };
  return visitAll(values, 0) as Record<string, unknown>;
}

/** Bound for {@link collectNestedRefs}: list depth (8) × two levels per entry, plus slack. */
const MAX_COLLECT_DEPTH = 24;
