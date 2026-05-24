// SPDX-License-Identifier: MPL-2.0

/**
 * Shared template engine for AI-authored module HTML. Consolidates the
 * no-DB `applyFieldSubstitution` in `preview-compose.ts` and the
 * DB-aware `substituteWithRecursion` in `preview-render.ts` into a
 * single engine built on `mustache.js` (Plan B per issue #71).
 *
 * Grammar (a Mustache subset — see CMS_REQUIREMENTS §3.1 / §5):
 *   {{name}}                  — primitive substitution
 *   {{#name}}…inner…{{/name}}  — section: iterates over text-list /
 *                                 link-list / module-list field kinds
 *   {{>name}}                 — single nested module reference
 *                                 (module field kind)
 *
 * Substitution priority for {{name}}:
 *   1. contentValues[name]    — per-placement value
 *   2. fields[name].default   — module-level default
 *   3. raw `{{name}}` left in place  (CLAUDE.md §2 — no fallbacks pre-1.0,
 *                                     so broken templates stay visible)
 *
 * Loud-raw invariant: an unknown `{{name}}` / `{{#name}}` / `{{>name}}`
 * (no matching declared field) is left as raw text in the output, not
 * silenced. Mustache's "unknown → empty string" default is overridden
 * by a sentinel pre-scan + post-substitute pass that re-injects the
 * original Mustache source after rendering. See plan §2 risk #2.
 *
 * Failure markers preserved verbatim from the legacy preview-render
 * for `missingSlots`: `field-not-declared:<name>`,
 * `kind-mismatch:<name> expected=<…> actual=<kind>`,
 * `text-list-malformed:<name>[<i>]`, `link-list-malformed:<name>[<i>]`,
 * `module-list-malformed:<name>[<i>]`, `module-ref-malformed:<name>`.
 * The chat-runner diag pass + editor missing-content surface read
 * these literal strings; any rename is a silent regression for them.
 *
 * No HTML escaping. Module HTML substitutes raw — modules are the
 * place raw HTML lives (CMS_REQUIREMENTS §3.1). Auto-escape would
 * silently break every <a href="{{url}}"> in the catalog. The
 * `Mustache.escape` override at module load is the public Mustache
 * configuration knob; the engine module is the sole workspace
 * importer of mustache so the singleton mutation is scoped in
 * effect.
 *
 * Partials are caller-supplied (sync `Record<string, string>`). The
 * compose path passes an empty map (no DB) — module / module-list
 * refs become loud HTML comments so static-gen output is visible-
 * broken instead of silent-empty. The preview-render path
 * pre-resolves each nested ref via its existing RenderResolver walk
 * (depth-limit + cycle-detection live there, untouched) and supplies
 * the rendered HTML as a partial.
 */

import Mustache from "mustache";
import { MODULE_FIELD_SECTION_KINDS, type ModuleFieldKind } from "./content.js";

// Override Mustache's default HTML escape — module HTML substitutes
// raw. The engine module is the only workspace importer of mustache,
// so the singleton mutation is scoped in effect. Plan §2 risk #1: the
// {{href}} test pins this; any leak of the default escape fails.
Mustache.escape = (s: unknown): string => (s === null || s === undefined ? "" : String(s));

/**
 * Subset of `modules.fields[]` the engine cares about. The full
 * schema lives in `content.ts`; the engine only needs `name`, `kind`,
 * and the optional `default`. Importers pass the full row through.
 */
export interface TemplateField {
  readonly name: string;
  readonly kind: ModuleFieldKind;
  readonly default?: unknown;
}

export interface RenderTemplateInput {
  readonly html: string;
  readonly fields: readonly TemplateField[];
  /** Per-placement values from `content_instances.values`. */
  readonly contentValues?: Readonly<Record<string, unknown>>;
  /**
   * Pre-rendered nested-module HTML keyed by:
   *   - `<name>`            for single `{{>name}}` (module field kind)
   *   - `<name>__<index>`   for each `{{#name}}` element (module-list)
   * Compose path: empty map (no DB → loud HTML comments emit).
   * Preview-render path: built from RenderResolver walks.
   */
  readonly partials?: Readonly<Record<string, string>>;
}

export interface RenderTemplateOutput {
  readonly html: string;
  /** Structured failure channel — see file-level comment for the markers. */
  readonly missingSlots: readonly string[];
}

interface NestedRef {
  readonly moduleId: string;
  readonly contentInstanceId: string;
}

// Field names per the v0.4.0 + v0.12.0 grammar: lowercase ASCII +
// digits + underscores. Case-insensitive primitive matching (the AI
// sometimes camelCases the placeholder when extracting from existing
// HTML) is handled below via lowercased view lookup.
const SECTION_RE = /\{\{#\s*([a-z][a-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g;
const PARTIAL_RE = /\{\{>\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const PRIMITIVE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

// Section-dispatch kinds (the engine's `{{#name}}` operand). Imported
// from content.ts so new list-shaped kinds wire through automatically
// when the canonical declaration is extended.
const SECTION_KINDS: ReadonlySet<string> = new Set(MODULE_FIELD_SECTION_KINDS);

function isNestedRef(v: unknown): v is NestedRef {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { moduleId?: unknown }).moduleId === "string" &&
    typeof (v as { contentInstanceId?: unknown }).contentInstanceId === "string"
  );
}

/**
 * Render a `caelo:missing` HTML comment carrying a failure reason.
 * The shape (`<!-- caelo:missing reason=<…> -->`) is part of the
 * public failure-marker contract — the chat-runner diag pass reads
 * the comment text out of rendered HTML, and the editor's missing-
 * content surface highlights it for the operator. Exported so the
 * DB-aware preview-render path (`packages/admin-core/src/ops/content/
 * preview-render.ts`) emits the exact same shape without redeclaring.
 */
export function caeloMissingComment(reason: string): string {
  return `<!-- caelo:missing reason=${reason} -->`;
}

const comment = caeloMissingComment;

/**
 * Render `html` against `contentValues` + `fields` + `partials`,
 * returning the substituted HTML plus a structured `missingSlots`
 * channel. Pure / sync / no IO.
 */
export function renderTemplate(input: RenderTemplateInput): RenderTemplateOutput {
  const missing: string[] = [];
  const fieldByName = new Map<string, TemplateField>();
  for (const f of input.fields) fieldByName.set(f.name, f);
  const cvs = input.contentValues ?? {};
  const partials = input.partials ?? {};

  // Sentinels survive Mustache.render untouched (they contain no
  // `{{` `}}`), then get restored to the original Mustache source
  // after render — the loud-raw invariant. The token is intentionally
  // long + uppercase so accidental collision with a module's literal
  // HTML content is negligible (and a collision would just produce
  // weird output, which is pre-1.0 fail-loud behaviour anyway).
  const sentinels = new Map<string, string>();
  const mkSentinel = (original: string): string => {
    const key = `__CAELO_TEMPLATE_ENGINE_RAW_${sentinels.size}__`;
    sentinels.set(key, original);
    return key;
  };

  // 1. {{#name}}…{{/name}} sections.
  let html = input.html.replace(SECTION_RE, (match, name: string, inner: string) =>
    renderSection(match, name, inner, fieldByName, cvs, partials, missing, mkSentinel),
  );

  // 2. {{>name}} single partials.
  html = html.replace(PARTIAL_RE, (match, name: string) =>
    renderPartialRef(match, name, fieldByName, cvs, partials, missing, mkSentinel),
  );

  // 3. {{name}} primitives. Pre-rewrite to canonical lowercase form
  //    so the (lowercased) view picks them up regardless of source
  //    casing. Unknowns become sentinels for loud-raw.
  const declaredFieldNames = new Set<string>();
  for (const f of input.fields) {
    declaredFieldNames.add(f.name);
    declaredFieldNames.add(f.name.toLowerCase());
  }
  const view: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cvs)) {
    view[k.toLowerCase()] = v === null || v === undefined ? "" : v;
  }
  for (const f of input.fields) {
    const lower = f.name.toLowerCase();
    if (lower in view) continue;
    if (SECTION_KINDS.has(f.kind) || f.kind === "module") continue;
    if (f.default !== undefined && f.default !== null) view[lower] = f.default;
  }

  html = html.replace(PRIMITIVE_RE, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower in view) return `{{${lower}}}`;
    // No value + no default: leave raw (CLAUDE.md §2). Track in
    // missingSlots only when the field isn't declared at all —
    // declared-but-empty is the operator's responsibility (still
    // authoring), not a system-side gap callers should warn about.
    if (!declaredFieldNames.has(name) && !declaredFieldNames.has(lower)) {
      missing.push(`field-not-declared:${name}`);
    }
    return mkSentinel(match);
  });

  // 4. Render. The view holds only lowercase keys; sentinels survive
  //    untouched; sections + partials are already pre-substituted.
  const rendered = Mustache.render(html, view);

  // 5. Restore loud-raw sentinels.
  let final = rendered;
  for (const [sentinel, original] of sentinels) {
    final = final.split(sentinel).join(original);
  }

  return { html: final, missingSlots: missing };
}

function renderSection(
  match: string,
  name: string,
  inner: string,
  fields: Map<string, TemplateField>,
  cvs: Readonly<Record<string, unknown>>,
  partials: Readonly<Record<string, string>>,
  missing: string[],
  mkSentinel: (original: string) => string,
): string {
  const field = fields.get(name);
  if (!field) {
    missing.push(`field-not-declared:${name}`);
    return mkSentinel(match);
  }
  if (field.kind === "module-list") {
    return renderModuleList(name, field, cvs, partials, missing);
  }
  if (field.kind === "text-list") {
    return renderTextList(name, inner, field, cvs, missing);
  }
  if (field.kind === "link-list") {
    return renderLinkList(name, inner, field, cvs, missing);
  }
  const reason = `kind-mismatch:${name} expected=module-list|text-list|link-list actual=${field.kind}`;
  missing.push(reason);
  return comment(reason);
}

function renderTextList(
  name: string,
  inner: string,
  field: TemplateField,
  cvs: Readonly<Record<string, unknown>>,
  missing: string[],
): string {
  const raw = Object.hasOwn(cvs, name) ? cvs[name] : field.default;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const el = raw[i];
    if (typeof el !== "string" && typeof el !== "number" && typeof el !== "boolean") {
      missing.push(`text-list-malformed:${name}[${i}]`);
      parts.push(comment(`text-list-malformed ${name}[${i}]`));
      continue;
    }
    const value = String(el);
    parts.push(inner.replace(/\{\{\s*(?:\.|item)\s*\}\}/g, () => value));
  }
  return parts.join("");
}

function renderLinkList(
  name: string,
  inner: string,
  field: TemplateField,
  cvs: Readonly<Record<string, unknown>>,
  missing: string[],
): string {
  const raw = Object.hasOwn(cvs, name) ? cvs[name] : field.default;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const el = raw[i];
    if (
      typeof el !== "object" ||
      el === null ||
      typeof (el as { label?: unknown }).label !== "string" ||
      typeof (el as { href?: unknown }).href !== "string"
    ) {
      missing.push(`link-list-malformed:${name}[${i}]`);
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

function renderModuleList(
  name: string,
  field: TemplateField,
  cvs: Readonly<Record<string, unknown>>,
  partials: Readonly<Record<string, string>>,
  missing: string[],
): string {
  const raw = Object.hasOwn(cvs, name) ? cvs[name] : field.default;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const el = raw[i];
    if (!isNestedRef(el)) {
      missing.push(`module-list-malformed:${name}[${i}]`);
      parts.push(comment(`module-list-malformed ${name}[${i}]`));
      continue;
    }
    const partialKey = `${name}__${i}`;
    const partialHtml = partials[partialKey];
    if (partialHtml === undefined) {
      // Compose path: no DB → no partials → loud comment so
      // operators see the gap. The preview-render path always
      // supplies a partial (or routes a structured failure marker
      // through it from renderInner), so this branch is the
      // static-gen escape hatch until #70 lands.
      parts.push(`<!-- caelo:module-list ${name} needs recursive renderer (compose path) -->`);
      continue;
    }
    parts.push(partialHtml);
  }
  return parts.join("");
}

function renderPartialRef(
  match: string,
  name: string,
  fields: Map<string, TemplateField>,
  cvs: Readonly<Record<string, unknown>>,
  partials: Readonly<Record<string, string>>,
  missing: string[],
  mkSentinel: (original: string) => string,
): string {
  const field = fields.get(name);
  if (!field) {
    missing.push(`field-not-declared:${name}`);
    return mkSentinel(match);
  }
  if (field.kind !== "module") {
    const reason = `kind-mismatch:${name} expected=module actual=${field.kind}`;
    missing.push(reason);
    return comment(reason);
  }
  const ref = cvs[name];
  if (!isNestedRef(ref)) {
    missing.push(`module-ref-malformed:${name}`);
    return comment(`module-ref-malformed ${name}`);
  }
  const partialHtml = partials[name];
  if (partialHtml === undefined) {
    return `<!-- caelo:module ${name} needs recursive renderer (compose path) -->`;
  }
  return partialHtml;
}
