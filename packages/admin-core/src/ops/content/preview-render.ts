// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.1 — Recursive module renderer. Pure function so it's
 * unit-testable without the compose stack. `pages.render_preview`
 * fetches the data + calls into here.
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
 *   {{#fieldName}}{{/fieldName}}        — repeated nested module slot
 *                                        (field kind = 'module-list').
 *                                        values[fieldName] is an array
 *                                        of { moduleId, contentInstanceId };
 *                                        each nested module is rendered
 *                                        in order against its own
 *                                        content_instance. NOTE: any
 *                                        `inner` template text between
 *                                        the open + close tags is
 *                                        currently IGNORED in v0.12 —
 *                                        per-element wrappers
 *                                        (e.g. `<li>{{>item}}</li>`)
 *                                        are a future v0.x extension.
 *                                        Author the wrapper inside the
 *                                        nested module's own HTML.
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

const MAX_RECURSION_DEPTH = 8;

export interface ModuleResource {
  readonly moduleId: string;
  readonly slug: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  readonly fields: readonly {
    readonly name: string;
    readonly kind: string;
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

function substituteWithRecursion(
  mod: ModuleResource,
  ci: ContentInstanceResource,
  ctx: RenderContext,
): string {
  let html = mod.html;

  // 1. Iteration slots: {{#fieldName}}…inner…{{/fieldName}}.
  // Process before single-module + primitive so the inner template
  // doesn't get touched twice. Non-greedy match; supports any inner.
  //
  // Three kinds dispatch through this branch by field.kind:
  //   module-list — array of {moduleId, contentInstanceId} refs;
  //                 each element renders its nested module's HTML
  //                 (inner template text is ignored — wrappers
  //                 belong inside the nested module).
  //   text-list   — array of strings; inner template substitutes
  //                 {{.}} or {{item}} with the current element.
  //   link-list   — array of {label, href}; inner template
  //                 substitutes {{label}} + {{href}} per iteration.
  html = html.replace(
    /\{\{#\s*([a-z][a-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g,
    (_full, name: string, inner: string) => {
      const field = mod.fields.find((f) => f.name === name);
      if (!field) {
        ctx.missing.push(`field-not-declared:${name}`);
        return comment(`field-not-declared ${name}`);
      }
      if (
        field.kind !== "module-list" &&
        field.kind !== "text-list" &&
        field.kind !== "link-list"
      ) {
        ctx.missing.push(
          `kind-mismatch:${name} expected=module-list|text-list|link-list actual=${field.kind}`,
        );
        return comment(`kind-mismatch ${name}`);
      }
      // Resolve the list values — prefer ci.values, fall back to the
      // field's `default` so module authors can ship a sensible list
      // that renders before the first content-instance edit.
      const raw = Object.hasOwn(ci.values, name)
        ? ci.values[name]
        : "default" in field
          ? field.default
          : undefined;
      if (!Array.isArray(raw)) {
        // Empty list / unset is fine — render nothing.
        return "";
      }

      if (field.kind === "text-list") {
        // Inner template references {{.}} or {{item}} per iteration.
        // Element type: string. We coerce to string defensively so
        // numbers / booleans don't blow up rendering.
        const parts: string[] = [];
        for (let i = 0; i < raw.length; i += 1) {
          const el = raw[i];
          if (typeof el !== "string" && typeof el !== "number" && typeof el !== "boolean") {
            ctx.missing.push(`text-list-malformed:${name}[${i}]`);
            parts.push(comment(`text-list-malformed ${name}[${i}]`));
            continue;
          }
          const value = String(el);
          parts.push(inner.replace(/\{\{\s*(?:\.|item)\s*\}\}/g, () => value));
        }
        return parts.join("");
      }

      if (field.kind === "link-list") {
        // Inner template references {{label}} + {{href}} per iteration.
        const parts: string[] = [];
        for (let i = 0; i < raw.length; i += 1) {
          const el = raw[i];
          if (
            typeof el !== "object" ||
            el === null ||
            typeof (el as { label?: unknown }).label !== "string" ||
            typeof (el as { href?: unknown }).href !== "string"
          ) {
            ctx.missing.push(`link-list-malformed:${name}[${i}]`);
            parts.push(comment(`link-list-malformed ${name}[${i}]`));
            continue;
          }
          const { label, href } = el as { label: string; href: string };
          parts.push(
            inner
              .replace(/\{\{\s*label\s*\}\}/g, () => label)
              .replace(/\{\{\s*href\s*\}\}/g, () => href),
          );
        }
        return parts.join("");
      }

      // module-list: each element renders its nested module's HTML
      // (recursing through renderInner). Inner template text is
      // ignored — per-element wrappers belong inside the nested
      // module's own HTML, not in the outer iterator block.
      const parts: string[] = [];
      for (let i = 0; i < raw.length; i += 1) {
        const el = raw[i];
        if (!isNestedRef(el)) {
          ctx.missing.push(`module-list-malformed:${name}[${i}]`);
          parts.push(comment(`module-list-malformed ${name}[${i}]`));
          continue;
        }
        const nestedMod = ctx.resolver.getModule(el.moduleId);
        const nestedCi = ctx.resolver.getContentInstance(el.contentInstanceId);
        if (!nestedMod) {
          ctx.missing.push(`module-missing:${el.moduleId}`);
          parts.push(comment(`module-missing ${el.moduleId}`));
          continue;
        }
        if (!nestedCi || nestedCi.deletedAt !== null) {
          ctx.missing.push(`content-instance-missing:${el.contentInstanceId}`);
          parts.push(comment(`content-instance-missing ${el.contentInstanceId}`));
          continue;
        }
        parts.push(renderInner(el.moduleId, el.contentInstanceId, ctx));
        void inner;
      }
      return parts.join("");
    },
  );

  // 2. Single nested module slots: {{>fieldName}}.
  html = html.replace(/\{\{>\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_full, name: string) => {
    const field = mod.fields.find((f) => f.name === name);
    if (!field) {
      ctx.missing.push(`field-not-declared:${name}`);
      return comment(`field-not-declared ${name}`);
    }
    if (field.kind !== "module") {
      ctx.missing.push(`kind-mismatch:${name} expected=module actual=${field.kind}`);
      return comment(`kind-mismatch ${name}`);
    }
    const ref = ci.values[name];
    if (!isNestedRef(ref)) {
      // Missing / malformed nested ref — render comment for visibility.
      ctx.missing.push(`module-ref-malformed:${name}`);
      return comment(`module-ref-malformed ${name}`);
    }
    return renderInner(ref.moduleId, ref.contentInstanceId, ctx);
  });

  // 3. Primitive {{fieldName}} substitution — unchanged from v0.4.0
  // (now with `mod.fields[].default` as the fallback).
  html = html.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (full, name: string) => {
    if (Object.hasOwn(ci.values, name)) {
      const v = ci.values[name];
      return v === null || v === undefined ? "" : String(v);
    }
    const field = mod.fields.find((f) => f.name === name);
    if (field && field.default !== undefined && field.default !== null) {
      return String(field.default);
    }
    return full;
  });

  return html;
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
