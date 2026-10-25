// SPDX-License-Identifier: MPL-2.0

/**
 * Shared template engine for AI-authored module HTML. Consolidates the
 * no-DB `applyFieldSubstitution` in `preview-compose.ts` and the
 * DB-aware `substituteWithRecursion` in `nested-module-render.ts` into a
 * single engine built on `mustache.js` (Plan B per issue #71).
 *
 * Grammar (a Mustache subset — see CMS_REQUIREMENTS §3.1 / §5, and
 * `docs/lists.md` §8 for lists):
 *   {{name}}                  — primitive substitution
 *   {{#name}}…inner…{{/name}}  — section: ITERATES over a `list` field
 *                                 (any binding — local, shared, query,
 *                                 system, plugin source) or a
 *                                 `module-list`; for a SCALAR or single
 *                                 `module` field it is a CONDITIONAL —
 *                                 the block renders once when the field
 *                                 has a value, and is dropped when empty
 *                                 (never a kind-mismatch — that used to
 *                                 silently drop real scalar content)
 *   {{^name}}…inner…{{/name}}  — inverted section: renders when the list
 *                                 is empty or the value absent / false
 *   {{>name}}                 — single nested module reference
 *                                 (module field kind)
 *   {{page.title}}, {{a.b}}   — dot access (`page.*`, compound entry
 *                                 values); inside a list entry the
 *                                 entry's keys, `{{>recurse}}`,
 *                                 `{{>f}}` (embedded module) and the
 *                                 system keys — see template-sections.ts
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
 * `module-list-malformed:<name>[<i>]`, `module-ref-malformed:<name>`,
 * `nested-renderer-unavailable:<name>` / `…:<name>[<i>]` (a nested ref
 * rendered without the recursive renderer's partial).
 * v0.11.1 (issue #76): `theme-asset-unbound:<slot>` for the four
 * `{{theme_<slot>_url}}` placeholders when the active theme's asset
 * slot isn't bound.
 * Epic #1107 (lists): `list-unbound:<field>`, `list-missing:<listId>`,
 * `list-type-missing:<slug>`, `list-source-unavailable:<name> plugin=<slug>`,
 * `list-malformed:<field>[<path>]`, `field-not-declared:<field>.<key>`
 * for a key no entry, enclosing entry or module field has, and
 * `list-context-unavailable:<field>` / `…:page` for a list rendered by a
 * caller that gave the engine no list context (never legitimate output).
 * Epic #724: `link-target-missing:page/<id>` / `…:media/<id>` for an
 * internal reference (`caelo:page/<id>`, `caelo:media/<id>`) whose
 * target does not exist, `link-resolver-unavailable:<kind>/<id>` for
 * one rendered without a resolver, and `link-ref-malformed:<text>` for
 * text that starts like a reference but breaks the grammar (see
 * `link-refs.ts`).
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
 * recursive renderer (`nested-module-render.ts` — used by the editor
 * preview and, through the composer's `nestedModules` resolver, by the
 * static generator) pre-resolves each nested ref (depth-limit +
 * cycle-detection live there) and supplies the rendered HTML as a
 * partial. A caller without it gets loud HTML comments plus a
 * `nested-renderer-unavailable` marker instead of silent-empty output.
 */

import Mustache from "mustache";
import { MODULE_FIELD_SECTION_KINDS, type ModuleFieldKind } from "./content.js";
import { type LinkResolver, resolveLinkRefsInHtml } from "./link-refs.js";
import { type SourceDef, sourceDefSchema } from "./lists/list-type.js";
import type { ListHolder, ListPageContext } from "./lists/resolve.js";
import { stripCdataGuards } from "./strip-cdata.js";
import { renderSections } from "./template-sections.js";

// Override Mustache's default HTML escape — module HTML substitutes
// raw. The engine module is the only workspace importer of mustache,
// so the singleton mutation is scoped in effect. Plan §2 risk #1: the
// {{href}} test pins this; any leak of the default escape fails.
Mustache.escape = (s: unknown): string => (s === null || s === undefined ? "" : String(s));

/**
 * Subset of `modules.fields[]` the engine cares about. The full
 * schema lives in `content.ts`; the engine needs `name`, `kind`, the
 * optional `default` and, for a `list` field, its binding
 * (`listType`, `bind`, `list`, `source` — `docs/lists.md` §7).
 * Importers pass the full row through.
 */
export interface TemplateField {
  readonly name: string;
  readonly kind: ModuleFieldKind;
  readonly default?: unknown;
  readonly listType?: string;
  readonly bind?: "local" | "shared" | "source";
  readonly list?: string;
  readonly source?: SourceDef;
}

/**
 * Parse a stored `modules.fields` jsonb (array or JSON text) into the
 * fields the engine renders with: name, kind (absent = `text`), default,
 * and a `list` field's binding. A typo'd kind passes through as is — the
 * engine reports it loudly (kind-mismatch) instead of the parser hiding
 * it. Entries without a string name are skipped; they cannot be rendered.
 */
export function templateFieldsFromJson(raw: unknown): TemplateField[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: TemplateField[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      kind: (typeof o.kind === "string" ? o.kind : "text") as ModuleFieldKind,
      ...(o.default !== undefined ? { default: o.default } : {}),
      ...(typeof o.listType === "string" ? { listType: o.listType } : {}),
      ...(o.bind === "local" || o.bind === "shared" || o.bind === "source" ? { bind: o.bind } : {}),
      ...(typeof o.list === "string" ? { list: o.list } : {}),
      // A source that fails its schema stays absent: the resolver then
      // reports `list-malformed:<field>[source]` instead of guessing.
      ...(sourceDefSchema.safeParse(o.source).success ? { source: o.source as SourceDef } : {}),
    });
  }
  return out;
}

/**
 * Renders the nested-module partial for `key` (see
 * {@link RenderTemplateInput.partials}) on demand, or `undefined` when
 * the caller has no renderer for it. `ref` is passed for the module
 * field of a list entry (key `list:<field>/<itemId>/<entryField>`),
 * whose value the caller cannot look up by field name.
 */
export type PartialResolver = (
  key: string,
  ref?: { readonly moduleId: string; readonly contentInstanceId: string },
) => string | undefined;

export interface RenderTemplateInput {
  readonly html: string;
  readonly fields: readonly TemplateField[];
  /** Per-placement values from `content_instances.values`. */
  readonly contentValues?: Readonly<Record<string, unknown>>;
  /**
   * Nested-module HTML keyed by:
   *   - `<name>`            for single `{{>name}}` (module field kind)
   *   - `<name>__<index>`   for each `{{#name}}` element (module-list)
   *   - `list:<field>/<itemId>/<entryField>` for `{{>entryField}}`
   *     inside an entry of list field `<field>` (resolver gets the ref)
   * Either pre-rendered, or a {@link PartialResolver} the engine calls
   * only for the refs the template actually dispatches — the recursive
   * renderer (nested-module-render.ts) passes a resolver so a declared
   * but unreferenced field is never rendered. Absent / `undefined` for
   * a key → loud HTML comments + `nested-renderer-unavailable` markers.
   */
  readonly partials?: Readonly<Record<string, string>> | PartialResolver;
  /**
   * The list view of THIS page (`lists/resolve.ts`): resolves `list`
   * fields, `{{page.*}}` and plugin list sources. Without it a `list`
   * field renders raw with `list-context-unavailable:<field>`.
   */
  readonly lists?: ListPageContext;
  /**
   * The content instance whose values are rendered — the address of
   * local list entries for overlays and `data-caelo-list-item`. Absent
   * for field defaults (site chrome).
   */
  readonly listHolder?: ListHolder;
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
  /**
   * Epic #724 — turns internal references (`caelo:page/<id>`,
   * `caelo:media/<id>`) into URLs for the page being rendered. Applied
   * to the fully substituted output, so a reference resolves wherever it
   * came from: module HTML attributes, a field value, a field default, a
   * list entry, rich text. A missing target stays raw and pushes
   * `link-target-missing:<kind>/<id>`; with no resolver every reference
   * pushes `link-resolver-unavailable:<kind>/<id>` (loud, never empty).
   */
  readonly linkResolver?: LinkResolver;
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
const PARTIAL_RE = /\{\{\s*>\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const PRIMITIVE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
// A plain tag (no Mustache sigil) of any name, and the identifier test
// that tells a field placeholder from literal text such as `{{Page URL}}`.
// No `\s*` before the close: it would overlap `[^{}]*` (polynomial
// backtracking); the callback trims instead.
const NON_IDENTIFIER_TAG_RE = /\{\{\s*([^#^/>!&={}\s][^{}]*)\}\}/g;
const IDENTIFIER_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

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
 * recursive nested-module renderer (`nested-module-render.ts`) emits
 * the exact same shape without redeclaring.
 */
export function caeloMissingComment(reason: string): string {
  return `<!-- caelo:missing reason=${reason} -->`;
}

const comment = caeloMissingComment;

/**
 * `missingSlots` marker prefix for a `module` / `module-list` ref the
 * caller gave the engine no partial for — it rendered without the
 * recursive nested-module renderer. Never legitimate in deployed HTML.
 */
const NESTED_RENDERER_UNAVAILABLE = "nested-renderer-unavailable";

/**
 * Render `html` against `contentValues` + `fields` + `partials`,
 * returning the substituted HTML plus a structured `missingSlots`
 * channel. Pure / sync / no IO.
 *
 * @example
 * // A local list of the shipped `links` type; `lists` comes from
 * // createListRenderContext(data).forPage(pageId, { linkResolver }).
 * renderTemplate({
 *   html: '<nav>{{#nav}}<a href="{{link}}">{{label}}</a>{{/nav}}</nav>',
 *   fields: [{ name: 'nav', kind: 'list', listType: 'links' }],
 *   contentValues: {
 *     nav: [{ id: '<uuid>', node: 'link', values: { label: 'Docs', link: { href: '/docs' } } }],
 *   },
 *   lists,
 * });
 * // → html: '<nav><a href="/docs" data-caelo-list-item="local/nav/<uuid>">Docs</a></nav>'
 *
 * @see {@link TemplateField} for the field shape (name + kind + optional default).
 * @see {@link ./content.js#MODULE_FIELD_KINDS} for the canonical kind union.
 * @see {@link ./content.js#MODULE_FIELD_SECTION_KINDS} for the kinds the engine
 *      iterates via `{{#name}}` (list / module-list).
 */
export function renderTemplate(input: RenderTemplateInput): RenderTemplateOutput {
  const missing: string[] = [];
  const fieldByName = new Map<string, TemplateField>();
  for (const f of input.fields) fieldByName.set(f.name, f);
  const cvs = input.contentValues ?? {};
  const partialSource = input.partials ?? {};
  const partials: PartialResolver =
    typeof partialSource === "function"
      ? partialSource
      : (key: string) => (Object.hasOwn(partialSource, key) ? partialSource[key] : undefined);

  // Sentinels survive Mustache.render untouched (they contain no
  // `{{` `}}`), then get restored to the original Mustache source
  // after render — the loud-raw invariant. The prefix carries a
  // per-call UUID so the sentinel string is unguessable from the
  // outside: a module author who pastes the literal `__CAELO_TPL_…__`
  // pattern into their HTML can't break loud-raw restore by
  // intercepting the sentinel for a known-key sentinel — they would
  // have to guess the UUID minted at render time.
  //
  // The same sentinels also carry DATA through the render (#1053): every
  // value the engine pastes into the template before Mustache runs — a
  // list item, a link label/href, a conditional's `{{.}}`, a plugin list
  // value, a rendered nested module — is wrapped, so literal `{{…}}` in
  // content (a GTM `{{Page URL}}` in a code example) is never parsed as a
  // tag a second time. Values Mustache substitutes itself are never
  // re-parsed, so only these pre-pasted ones need it.
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

  // 1. {{#name}}…{{/name}} and {{^name}}…{{/name}} sections, list
  //    entries and dot access (template-sections.ts).
  let html = renderSections(sourceHtml, {
    fields: fieldByName,
    values: cvs,
    partials,
    missing,
    mkSentinel,
    lists: input.lists,
    holder: input.listHolder ?? { contentInstanceId: null },
    moduleLevelKeys: new Set(THEME_ASSET_KEYS),
    renderModuleList: (name, field) =>
      renderModuleList(name, field as TemplateField, cvs, partials, missing, mkSentinel),
  });

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

  // 3b. A tag whose name is not a field identifier (`{{Page URL}}`, a
  //     Google Tag Manager variable in a snippet) can never be a
  //     placeholder — field names are snake_case. Mustache would look it
  //     up and silently render "", so it stays literal (#1053).
  html = html.replace(NON_IDENTIFIER_TAG_RE, (match, name: string) =>
    IDENTIFIER_RE.test(name.trim()) ? match : mkSentinel(match),
  );

  // 4. Render. The view holds only lowercase keys; sentinels survive
  //    untouched; sections + partials are already substituted.
  const rendered = Mustache.render(html, view);

  // 5. Restore sentinels in one pass. A single replace never re-scans
  //    the text it inserts, so restored content cannot be mistaken for a
  //    sentinel (and a list of N items costs one scan, not N).
  let final =
    sentinels.size === 0
      ? rendered
      : rendered.replace(
          new RegExp(`${sentinelPrefix}\\d+__`, "g"),
          (key) => sentinels.get(key) ?? key,
        );

  // 6. Resolve internal references (epic #724). Last, so values,
  //    defaults and list items substituted above are covered; nested
  //    partials arrive already resolved by their own render, and a
  //    resolved URL never matches the reference grammar again.
  final = resolveLinkRefsInHtml(final, input.linkResolver, missing);

  return { html: final, missingSlots: missing };
}

function renderModuleList(
  name: string,
  field: TemplateField,
  cvs: Readonly<Record<string, unknown>>,
  partials: PartialResolver,
  missing: string[],
  mkSentinel: (original: string) => string,
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
    const partialHtml = partials(partialKey);
    if (partialHtml === undefined) {
      // The caller rendered without a nested-module resolver (the
      // recursive renderer in nested-module-render.ts supplies a
      // partial — or a structured failure marker — for every
      // well-formed ref). Loud comment + structured marker, so the
      // editor flags it and the static generator refuses to ship it.
      missing.push(`${NESTED_RENDERER_UNAVAILABLE}:${name}[${i}]`);
      parts.push(`<!-- caelo:module-list ${name} needs recursive renderer (compose path) -->`);
      continue;
    }
    parts.push(mkSentinel(partialHtml));
  }
  return parts.join("");
}

function renderPartialRef(
  match: string,
  name: string,
  fields: Map<string, TemplateField>,
  cvs: Readonly<Record<string, unknown>>,
  partials: PartialResolver,
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
  const ref = Object.hasOwn(cvs, name) ? cvs[name] : undefined;
  // An unset or explicitly null single `module` field is an EMPTY slot,
  // the same as an empty module-list / list: it renders nothing and
  // is not a failure (#1041). The static generator refuses a Stage on any
  // marker, so flagging "empty" here made an optional nested slot
  // impossible to leave blank. A present value that is not a ref is still
  // malformed and stays loud.
  if (ref === undefined || ref === null) return "";
  if (!isNestedRef(ref)) {
    missing.push(`module-ref-malformed:${name}`);
    return comment(`module-ref-malformed ${name}`);
  }
  const partialHtml = partials(name);
  if (partialHtml === undefined) {
    // See renderModuleList: rendered without a nested-module resolver.
    missing.push(`${NESTED_RENDERER_UNAVAILABLE}:${name}`);
    return `<!-- caelo:module ${name} needs recursive renderer (compose path) -->`;
  }
  return mkSentinel(partialHtml);
}
