// SPDX-License-Identifier: MPL-2.0

/**
 * Shared template engine for AI-authored module HTML. Consolidates the
 * no-DB `applyFieldSubstitution` in `preview-compose.ts` and the
 * DB-aware `substituteWithRecursion` in `preview-render.ts` into a
 * single engine built on `mustache.js` (Plan B per issue #71).
 *
 * Grammar (a Mustache subset — see CMS_REQUIREMENTS §3.1 / §5):
 *   {{name}}                  — primitive substitution
 *   {{#name}}…inner…{{/name}}  — section: ITERATES over a list field
 *                                 (text-list / link-list / module-list);
 *                                 for a SCALAR (text/image/…) or single
 *                                 `module` field it is a CONDITIONAL —
 *                                 the block renders once when the field
 *                                 has a value, and is dropped when empty
 *                                 (never a kind-mismatch — that used to
 *                                 silently drop real scalar content)
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
 * v0.11.1 (issue #76): `theme-asset-unbound:<slot>` for the four
 * `{{theme_<slot>_url}}` placeholders when the active theme's asset
 * slot isn't bound.
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
import { stripCdataGuards } from "./strip-cdata.js";

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
  /**
   * Plugin-provided lists for THIS page, keyed by the claimed name a
   * module iterates as `{{#name}}`. The plugin supplies the data, the
   * module owns the markup — so a language switcher looks like the site
   * it lives on instead of carrying a plugin's fixed HTML.
   *
   * Resolved per page, which is what lets a module carrying one sit in
   * a LAYOUT and cover every page. The `staticRender` placeholder can't:
   * it needs the page's own id baked into its HTML.
   */
  readonly dataLists?: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string>>>>>;
  /**
   * Names an INSTALLED plugin declares that are not live right now,
   * mapped to the owning plugin. A module written while the plugin ran
   * still says `{{#language_links}}`; this is what lets the render
   * report "that plugin is switched off" instead of "unknown field".
   */
  readonly dormantDataLists?: Readonly<Record<string, string>>;
  /**
   * v0.11.1 (issue #76) — active theme's resolved asset URLs. When
   * present, `{{theme_logo_url}}` / `{{theme_logo_dark_url}}` /
   * `{{theme_favicon_url}}` / `{{theme_social_share_url}}` substitute
   * to the asset URL string. Unbound slots (null/absent) follow the
   * existing loud-raw invariant (CLAUDE.md §2): the `{{…}}` stays in
   * the output verbatim AND `theme-asset-unbound:<slot>` lands in
   * `missingSlots`. Per-placement `contentValues` still take
   * precedence so an operator can override on a single module.
   */
  readonly themeAssets?: {
    readonly logo: string | null;
    readonly logoDark: string | null;
    readonly favicon: string | null;
    readonly socialShare: string | null;
  };
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
// HTML) is handled below via lowercased view lookup. Whitespace
// between `{{` and the sigil (#, >, /) is permitted to match the
// Mustache spec — an extractor that pretty-prints AI-authored HTML
// shouldn't silently break section / partial dispatch.
// The section body uses a "tempered dot" — `(?:(?!CLOSE)[\s\S])*` — instead
// of a lazy `[\s\S]*?`. The lazy form makes the engine try, then backtrack,
// the close-tag match at every interior position, which is O(n²) on
// unclosed/large input (CodeQL js/polynomial-redos). The tempered form
// consumes one character only when the close tag does not start there, so
// there is a single unambiguous path. The capture stops at the first close
// tag for the captured name, exactly as the lazy form did — same output.
const SECTION_RE =
  /\{\{\s*#\s*([a-z][a-z0-9_]*)\s*\}\}((?:(?!\{\{\s*\/\s*\1\s*\}\})[\s\S])*)\{\{\s*\/\s*\1\s*\}\}/g;
const PARTIAL_RE = /\{\{\s*>\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const PRIMITIVE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

// Section-dispatch kinds (the engine's `{{#name}}` operand). Imported
// from content.ts so new list-shaped kinds wire through automatically
// when the canonical declaration is extended.
const SECTION_KINDS: ReadonlySet<string> = new Set(MODULE_FIELD_SECTION_KINDS);

// v0.11.1 (issue #76) — the four theme-asset substitutions the engine
// resolves from `RenderTemplateInput.themeAssets`. Keys are the
// `{{name}}` placeholders module authors write; the table maps them
// back to the asset slot on the ComposeTheme.assets aggregate.
const THEME_ASSET_KEY_TO_SLOT = {
  theme_logo_url: "logo",
  theme_logo_dark_url: "logoDark",
  theme_favicon_url: "favicon",
  theme_social_share_url: "socialShare",
} as const;
const THEME_ASSET_KEYS = Object.keys(THEME_ASSET_KEY_TO_SLOT) as ReadonlyArray<
  keyof typeof THEME_ASSET_KEY_TO_SLOT
>;

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
 *
 * @example
 * // AC #1 fixture (issue #71). Iterates a link-list field per element.
 * renderTemplate({
 *   html: '<nav>{{#nav_items}}<a href="{{href}}">{{label}}</a>{{/nav_items}}</nav>',
 *   fields: [{ name: 'nav_items', kind: 'link-list' }],
 *   contentValues: {
 *     nav_items: [
 *       { label: 'Docs', href: '/docs' },
 *       { label: 'Blog', href: '/blog' },
 *     ],
 *   },
 * });
 * // → {
 * //     html: '<nav><a href="/docs">Docs</a><a href="/blog">Blog</a></nav>',
 * //     missingSlots: [],
 * //   }
 *
 * @see {@link TemplateField} for the field shape (name + kind + optional default).
 * @see {@link ./content.js#MODULE_FIELD_KINDS} for the canonical kind union.
 * @see {@link ./content.js#MODULE_FIELD_SECTION_KINDS} for the kinds the engine
 *      iterates via `{{#name}}` (text-list / link-list / module-list).
 */
export function renderTemplate(input: RenderTemplateInput): RenderTemplateOutput {
  const missing: string[] = [];
  const fieldByName = new Map<string, TemplateField>();
  for (const f of input.fields) fieldByName.set(f.name, f);
  const cvs = input.contentValues ?? {};
  const partials = input.partials ?? {};

  // Sentinels survive Mustache.render untouched (they contain no
  // `{{` `}}`), then get restored to the original Mustache source
  // after render — the loud-raw invariant. The prefix carries a
  // per-call UUID so the sentinel string is unguessable from the
  // outside: a module author who pastes the literal `__CAELO_TPL_…__`
  // pattern into their HTML can't break loud-raw restore by
  // intercepting the sentinel for a known-key sentinel — they would
  // have to guess the UUID minted at render time.
  const sentinels = new Map<string, string>();
  const sentinelPrefix = `__CAELO_TPL_${globalThis.crypto.randomUUID()}_`;
  const mkSentinel = (original: string): string => {
    const key = `${sentinelPrefix}${sentinels.size}__`;
    sentinels.set(key, original);
    return key;
  };

  // 0. Defensively unwrap XHTML-style CDATA guards the model sometimes
  //    emits around inline <style>/<script> — they otherwise survive the
  //    byte-preserving compose path and leak a stray `]]>` into the page.
  //    Store-time normalization (modules.create/update) cleans new
  //    modules; this covers any already-stored HTML + the deploy render.
  const sourceHtml = stripCdataGuards(input.html);

  // 1. {{#name}}…{{/name}} sections.
  let html = sourceHtml.replace(SECTION_RE, (match, name: string, inner: string) =>
    renderSection(
      match,
      name,
      inner,
      fieldByName,
      cvs,
      partials,
      missing,
      mkSentinel,
      input.dataLists ?? {},
      input.dormantDataLists ?? {},
    ),
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

  // v0.11.1 (issue #76) — pre-populate four theme-asset substitutions
  // when the caller supplied `themeAssets`. `contentValues` already
  // populated `view` above so any per-placement override wins (per
  // §S19's "contentValues take precedence" invariant). Unbound slots
  // (null) DON'T land in the view — they fall through to the loud-raw
  // path below, but mark themselves with `theme-asset-unbound:<slot>`
  // so the failure marker disambiguates from `field-not-declared`.
  const themeAssetKeys = THEME_ASSET_KEYS;
  const themeAssetSlotByKey = THEME_ASSET_KEY_TO_SLOT;
  const themeAssets = input.themeAssets;
  if (themeAssets) {
    for (const key of themeAssetKeys) {
      const slot = themeAssetSlotByKey[key];
      const url = themeAssets[slot];
      if (typeof url === "string" && url.length > 0 && !(key in view)) {
        view[key] = url;
      }
    }
  }

  html = html.replace(PRIMITIVE_RE, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower in view) return `{{${lower}}}`;
    // v0.11.1 (issue #76) — theme-asset placeholder with no bound URL.
    // Use a dedicated marker so the failure surface disambiguates from
    // the generic field-not-declared marker.
    if (lower in themeAssetSlotByKey) {
      const slot = themeAssetSlotByKey[lower as keyof typeof THEME_ASSET_KEY_TO_SLOT];
      missing.push(`theme-asset-unbound:${slot}`);
      return mkSentinel(match);
    }
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
  dataLists: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string>>>>>,
  dormantLists: Readonly<Record<string, string>>,
): string {
  const field = fields.get(name);
  if (!field) {
    // No declared field — a plugin may still offer this name. Module
    // fields are looked up FIRST by construction, so a plugin can never
    // shadow something the module's author declared.
    const items = dataLists[name];
    if (items) return renderDataList(inner, items);
    // Declared by an installed plugin that is NOT running. Naming the
    // plugin turns "unknown field" (hunt for a typo) into "switch that
    // plugin back on", which is the actual fix.
    const owner = dormantLists[name];
    if (owner) {
      missing.push(`plugin-list-unavailable:${name} plugin=${owner}`);
      return mkSentinel(match);
    }
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
  // Any NON-list field used as a `{{#name}}…{{/name}}` section is a
  // CONDITIONAL (Mustache semantics): render the inner block once when the
  // field has a present, non-empty value; drop it when empty. This is what
  // makes `{{#subtitle}}<p>{{subtitle}}</p>{{/subtitle}}` wrap a scalar
  // text/image field — previously a scalar in a section fell through to
  // `kind-mismatch` and SILENTLY DROPPED real content (headings, body copy,
  // an image, a single nested module). `{{name}}` inside the block resolves
  // in the later primitive pass (a `module` field's `{{>name}}` in the
  // partial pass); `{{.}}`/`{{item}}` are substituted here for parity with
  // the *-list renderers. An empty conditional is intentional, not
  // "missing" — nothing is pushed to `missing`.
  return renderConditionalSection(name, inner, field, cvs);
}

/**
 * Render a `{{#name}}…{{/name}}` section over a scalar/module field as a
 * Mustache conditional: the block once when the value is present, else "".
 */
function renderConditionalSection(
  name: string,
  inner: string,
  field: TemplateField,
  cvs: Readonly<Record<string, unknown>>,
): string {
  const raw = Object.hasOwn(cvs, name) ? cvs[name] : field.default;
  if (!isPresentSectionValue(raw)) return "";
  const value = scalarSectionString(raw);
  return value.length > 0 ? inner.replace(/\{\{\s*(?:\.|item)\s*\}\}/g, () => value) : inner;
}

/**
 * Mustache-style truthiness for a conditional section value. Empty string,
 * null/undefined, `false`, and an empty array/object are absent; everything
 * else (incl. a numeric 0 — a real content value, not a control flag) is
 * present.
 */
function isPresentSectionValue(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === false) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (typeof raw === "number") return !Number.isNaN(raw);
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === "object") return Object.keys(raw as object).length > 0;
  return true;
}

/** String form for `{{.}}`/`{{item}}` inside a scalar conditional. Objects
 *  (module refs / image objects) render through `{{name}}`/`{{>name}}`, not
 *  `{{.}}`, so they stringify to "". */
function scalarSectionString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
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

/**
 * Iterate a plugin-provided list, substituting each item's keys inside
 * the section body.
 *
 * Unlike `link-list` no shape is imposed: the keys are whatever the
 * plugin declared in `itemFields`, so a language switcher uses
 * href/label/locale and a comment list something else entirely. A
 * `{{key}}` the item does not carry is left raw, matching the engine's
 * loud-raw rule everywhere else — a typo'd key stays visible instead of
 * quietly rendering as nothing.
 */
function renderDataList(
  inner: string,
  items: ReadonlyArray<Readonly<Record<string, string>>>,
): string {
  const parts: string[] = [];
  for (const item of items) {
    let rendered = inner;
    for (const [key, value] of Object.entries(item)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rendered = rendered.replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "g"), () => value);
    }
    parts.push(rendered);
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
      inner.replace(/\{\{\s*label\s*\}\}/g, () => label).replace(/\{\{\s*href\s*\}\}/g, () => href),
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
