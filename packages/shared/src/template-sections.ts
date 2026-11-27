// SPDX-License-Identifier: MPL-2.0

/**
 * Section pass of the template engine (`template-engine.ts`): every
 * `{{#name}}…{{/name}}` and `{{^name}}…{{/name}}`, list iteration with
 * entry scopes, `{{>recurse}}`, `{{>f}}` for an entry's embedded module,
 * dot access, a module `link` field's `{{f.href}}` and `{{page.*}}`
 * (epic #1107, `docs/lists.md` §8).
 *
 * The template is tokenized ONCE and sections are matched with one stack
 * per name, so a children loop may repeat inside itself
 * (`{{#children}}…{{#children}}…{{/children}}…{{/children}}`) and the cost
 * stays linear in the number of tags — no regex backtracks over a section
 * body (CodeQL js/polynomial-redos).
 *
 * Output contract with the later passes: text outside list entries and
 * every tag this pass does not own (a module field's `{{name}}`, a
 * top-level `{{>name}}`, `{{&x}}`, comments) comes out verbatim, so the
 * partial and primitive passes treat it exactly as before. Everything
 * this pass pastes — entry values, rendered nested modules, the original
 * source of a tag that must stay raw — is wrapped in a sentinel (#1053),
 * so content that happens to contain `{{…}}` is never parsed again.
 */

import { PAGE_KEY_TYPES, pageKeyUnknownMarker, pagePathUnknownMarker } from "./lists/page-paths.js";
import {
  contextualPluginValue,
  type PluginValueOrigin,
  pluginValueOf,
  pluginValueRefusedMarker,
} from "./lists/plugin-values.js";
import type { ListFieldSpec, ListHolder, ListPageContext } from "./lists/resolve.js";
import {
  LINK_VALUE_KEYS,
  linkValue,
  parseLinkFieldValue,
  plainValue,
} from "./lists/resolve-values.js";
import type { ScopeEntry, ScopeValue } from "./lists/scope.js";
import { placeholderContextAt } from "./template-contexts.js";

/** A field as the section pass needs it (subset of `TemplateField`). */
export interface SectionField extends Partial<Omit<ListFieldSpec, "name" | "default">> {
  readonly name: string;
  readonly kind: string;
  readonly default?: unknown;
}

/** Renders the nested-module partial for `key`; `ref` is set for an entry's module field. */
export type SectionPartialResolver = (
  key: string,
  ref?: { readonly moduleId: string; readonly contentInstanceId: string },
) => string | undefined;

/** What the section pass works with — one per `renderTemplate` call. */
export interface SectionEnv {
  readonly fields: ReadonlyMap<string, SectionField>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly partials: SectionPartialResolver;
  readonly missing: string[];
  readonly mkSentinel: (original: string) => string;
  readonly lists: ListPageContext | undefined;
  readonly holder: ListHolder;
  /** Theme-asset placeholder names, which are module-level keys too. */
  readonly moduleLevelKeys: ReadonlySet<string>;
  /** #1729 — refuse every plugin value with this rule (a nested module placed outside element content). */
  readonly refusePluginValues?: string;
  /**
   * #1748 — called with every core value this pass substitutes (a list
   * entry's, a `{{page.*}}` / `{{site_text.*}}` / link path's, a
   * conditional's `{{.}}`, a module field an entry does not answer), at
   * the offset of its tag's `{{` in the module HTML: the engine records it
   * when it changes the markup around it (`core-value-structure.ts`).
   * Module fields Mustache substitutes are checked at the tags this pass
   * reaches ({@link SectionEnv.moduleText}): a tag in a section that
   * renders nothing is no place of the value.
   */
  readonly coreValue?: (start: number, value: string, field: string) => void;
  /**
   * #1748 — the string Mustache substitutes for module field `name`
   * (lowercased): its value or default, a link field's href; null for
   * anything else (a plugin's value, a list, nothing).
   */
  readonly moduleText?: (name: string) => string | null;
  /** Renders a `module-list` field (inner block ignored), shared with the old engine path. */
  readonly renderModuleList: (name: string, field: SectionField) => string;
}

/** One `{{…}}` tag of the template. */
interface Token {
  readonly start: number;
  readonly end: number;
  /** `#`, `^`, `/`, `>` or "" for a plain tag. */
  readonly sigil: string;
  readonly name: string;
}

// `\s*` around the sigil is split by the mandatory sigil character, and
// the name ends on a word character, so no two quantifiers compete for
// the same input (linear matching).
const TAG_RE = /\{\{\s*([#^/>&]\s*)?([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\s*\}\}/g;
const SECTION_NAME_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const DOT_RE = /\{\{\s*\.\s*\}\}/g;

/** Dotted heads the list context answers, not an entry: `{{page.*}}`, `{{site_text.*}}`. */
const CONTEXT_HEADS = new Set(["page", "site_text"]);

function contextHead(name: string): string {
  return (name.split(".")[0] ?? "").toLowerCase();
}

function isContextHead(name: string): boolean {
  return CONTEXT_HEADS.has(contextHead(name));
}

function tokenize(html: string): Token[] {
  const out: Token[] = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m !== null; m = TAG_RE.exec(html)) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      sigil: (m[1] ?? "").trim(),
      name: m[2] as string,
    });
  }
  return out;
}

/**
 * Pair every section open with its close: one stack per name, so a name
 * nests inside itself and an unclosed open simply stays unpaired (the
 * later Mustache pass reports it, as before).
 */
function matchSections(tokens: readonly Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stacks = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    if (!SECTION_NAME_RE.test(t.name)) return;
    if (t.sigil === "#" || t.sigil === "^") {
      const s = stacks.get(t.name) ?? [];
      s.push(i);
      stacks.set(t.name, s);
    } else if (t.sigil === "/") {
      const open = stacks.get(t.name)?.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  });
  return pairs;
}

/** One list entry being rendered, with the block its section iterates. */
interface Frame {
  readonly entry: ScopeEntry;
  /** Token range of the iterating section's body: [first token, close token). */
  readonly block: {
    readonly from: number;
    readonly to: number;
    readonly textFrom: number;
    readonly textTo: number;
  };
  readonly name: string;
}

/**
 * A dotted name whose head exists and whose rest does not. `resolved`
 * counts the parts that were found (the head included) and `last` is the
 * value of the last of them; both are unset when the head itself is
 * unavailable (no page outside a page render, a module `link` field).
 * `entry` is the list entry that answered the head, if one did.
 */
interface Miss {
  readonly missing: true;
  readonly resolved?: number;
  readonly last?: ScopeValue;
  readonly entry?: ScopeEntry;
}

interface RenderState {
  readonly chain: readonly Frame[];
  /** `{{.}}` / `{{item}}` value inside a scalar conditional; null elsewhere. */
  readonly dot: string | null;
  /** Set when a plugin supplied {@link dot} (#1729): it is checked where it lands. */
  readonly dotPlugin?: PluginValueOrigin;
  /** The field the conditional over {@link dot} reads (#1748, named in a failure). */
  readonly dotField?: string;
}

/**
 * Run the section pass over `html`. Returns the HTML with every matched
 * section rendered and every tag inside list entries resolved.
 */
export function renderSections(html: string, env: SectionEnv): string {
  const tokens = tokenize(html);
  if (tokens.length === 0) return html;
  const pairs = matchSections(tokens);
  // Without a section or a dotted name (`{{&…}}` tags aside, which only a
  // plugin's value makes this pass's) the template is Mustache's, as it
  // always was: a plugin's value is then the only thing placed here.
  const corePass = pairs.size > 0 || tokens.some((t) => t.sigil !== "&" && t.name.includes("."));
  const pluginOwned = Object.values(env.values).some((v) => pluginValueOf(v) !== null);
  const r = new SectionRenderer(html, tokens, pairs, env, !corePass);
  // #1748 — without a section every tag renders, and Mustache substitutes
  // each module field there: this pass leaves them, so check them here.
  if (!corePass) {
    for (const t of tokens) if (t.sigil === "" || t.sigil === "&") r.coreModuleValue(t);
  }
  if (!corePass && !pluginOwned) return html;
  return r.range(0, tokens.length, 0, html.length, { chain: [], dot: null });
}

class SectionRenderer {
  constructor(
    private readonly html: string,
    private readonly tokens: readonly Token[],
    private readonly pairs: ReadonlyMap<number, number>,
    private readonly env: SectionEnv,
    /** Place only plugins' values: every core tag stays for Mustache, as without this pass. */
    private readonly pluginOnly = false,
  ) {}

  /** Render tokens [from, to) covering text [textFrom, textTo). */
  range(from: number, to: number, textFrom: number, textTo: number, st: RenderState): string {
    let out = "";
    let cursor = textFrom;
    let i = from;
    while (i < to) {
      const t = this.tokens[i] as Token;
      out += this.text(cursor, t.start, st);
      const close = this.pairs.get(i);
      if ((t.sigil === "#" || t.sigil === "^") && close !== undefined && close < to) {
        const c = this.tokens[close] as Token;
        const block = { from: i + 1, to: close, textFrom: t.end, textTo: c.start };
        out += this.section(t, block, this.html.slice(t.start, c.end), st);
        cursor = c.end;
        i = close + 1;
        continue;
      }
      this.pluginTag = false;
      const rendered = this.tag(t, st);
      // A plugin's value in a `{{{f}}}` replaces the whole tag, braces
      // included; a core value keeps the output it always had.
      const triple = this.html[t.start - 1] === "{" && this.html[t.end] === "}";
      if (this.pluginTag && triple && out.endsWith("{")) {
        out = out.slice(0, -1) + rendered;
        cursor = t.end + 1;
      } else {
        out += rendered;
        cursor = t.end;
      }
      i += 1;
    }
    return out + this.text(cursor, textTo, st);
  }

  /** Set by {@link pluginText}: the tag just rendered was a plugin's value. */
  private pluginTag = false;

  /**
   * #1729 (§4.5) — a plugin's value at the tag starting at `start`,
   * escaped or refused by where the module places it
   * (`template-contexts.ts`, `contextualPluginValue`). A refused value
   * keeps the tag raw and records `plugin-value-refused:…:<rule>`.
   */
  private pluginText(
    start: number,
    origin: PluginValueOrigin,
    value: string,
    source: string,
  ): string {
    this.pluginTag = true;
    const context = this.env.refusePluginValues
      ? ({ kind: "refused", rule: this.env.refusePluginValues } as const)
      : placeholderContextAt(this.html, start);
    const result = contextualPluginValue(context, origin, value);
    if (!result.ok) {
      return this.raw(
        source,
        pluginValueRefusedMarker(origin.plugin, origin.point, origin.address, result.rule),
      );
    }
    return result.html.length === 0 ? "" : this.env.mkSentinel(result.html);
  }

  private text(from: number, to: number, st: RenderState): string {
    const s = this.html.slice(from, to);
    if (st.dot === null || s.length === 0) return s;
    const dot = st.dot;
    const plugin = st.dotPlugin;
    return s.replace(DOT_RE, (match: string, offset: number) => {
      if (plugin) return this.pluginText(from + offset, plugin, dot, match);
      this.coreValue(from + offset, dot, st.dotField ?? ".");
      return this.env.mkSentinel(dot);
    });
  }

  /** #1748 — hand a core value this pass substitutes to the engine's structure check. */
  private coreValue(start: number, value: string, field: string): void {
    if (value.length > 0) this.env.coreValue?.(start, value, field);
  }

  /**
   * #1748 — the name a failure gives the value of tag `t`: `<list
   * field>[<entry id>].<key>` for a list entry's, the tag's name for a
   * `page.*`, `site_text.*` or module link path.
   */
  private coreFieldName(t: Token, st: RenderState): string {
    if (isContextHead(t.name) || st.chain.length === 0) return t.name.toLowerCase();
    const head = (t.name.split(".")[0] as string).toLowerCase();
    const entry = this.entryOf(head, st);
    return entry === undefined
      ? t.name.toLowerCase()
      : `${this.listField(st)}[${entry.id}].${t.name.toLowerCase()}`;
  }

  /**
   * #1748 — the core value Mustache substitutes for the module field of
   * tag `t` (outside entries, or in an entry that does not answer it).
   */
  coreModuleValue(t: Token): void {
    if (this.env.coreValue === undefined || t.name.includes(".")) return;
    if (this.modulePluginValue(t.name) !== null) return;
    const name = t.name.toLowerCase();
    const value = this.env.moduleText?.(name);
    if (value !== null && value !== undefined) this.coreValue(t.start, value, name);
  }

  /** {@link moduleValue}, and a core value's check where it is no plugin's. */
  private moduleTag(t: Token, source: string): string {
    const owned = this.moduleValue(t, source);
    if (owned !== null) return owned;
    this.coreModuleValue(t);
    return source;
  }

  private raw(source: string, marker: string | null): string {
    if (marker !== null) this.env.missing.push(marker);
    return this.env.mkSentinel(source);
  }

  /** The module field a list entry's markers name: the outermost iterated field. */
  private listField(st: RenderState): string {
    return st.chain[0]?.name ?? "";
  }

  // ── Lookups ──

  /**
   * Look `name` (possibly dotted) up in the entry chain, innermost
   * first, then `page`. `undefined` = not an entry key (a module-level
   * name, or unknown); `{ missing }` = the head exists but a dotted part
   * does not. A part that resolves to a failure ends the path with that
   * failure, so `{{page.props.typo.href}}` names the unknown property, not
   * the `href` after it (#1561).
   */
  private lookup(name: string, st: RenderState): ScopeValue | Miss | undefined {
    const parts = name.split(".");
    const head = (parts[0] as string).toLowerCase();
    let v: ScopeValue | undefined;
    let entry: ScopeEntry | undefined;
    if (head === "page") {
      v = this.env.lists?.pageScope() ?? undefined;
      if (v === undefined)
        return parts.length > 1 || st.chain.length > 0 ? { missing: true } : undefined;
    } else if (head === "site_text") {
      v = this.env.lists?.siteTextScope();
      if (v === undefined) return { missing: true };
    } else {
      entry = this.entryOf(head, st);
      v = entry?.get(head);
      if (v === undefined) return undefined;
    }
    let resolved = 1;
    for (const p of parts.slice(1)) {
      if (v.kind === "failed") return v;
      if (v.kind !== "record") return { missing: true, resolved, last: v, entry };
      const next: ScopeValue | undefined = v.get(p.toLowerCase());
      if (next === undefined) return { missing: true, resolved, last: v, entry };
      v = next;
      resolved += 1;
    }
    return v;
  }

  /**
   * A module field of kind `link` as a scope value, the shape a link in a
   * list entry has (#1433): `undefined` when `head` is no such field, a
   * `failed` value when its stored value is no link.
   */
  private moduleLink(head: string): ScopeValue | undefined {
    const field = this.env.fields.get(head);
    if (field?.kind !== "link") return undefined;
    const stored = Object.hasOwn(this.env.values, head) ? this.env.values[head] : field.default;
    const owned = pluginValueOf(stored);
    const link = parseLinkFieldValue(owned ? owned.value : stored);
    if (link === null) return { kind: "failed", marker: `field-value-malformed:${head}` };
    return this.env.lists?.linkScope(link, owned?.origin) ?? linkValue(link, null, owned?.origin);
  }

  /** `name` (`f` or `f.key`) read from a module `link` field; `undefined` when it is none. */
  private linkPath(name: string): ScopeValue | Miss | undefined {
    const [head, ...path] = name.toLowerCase().split(".");
    const root = this.moduleLink(head as string);
    if (root === undefined || root.kind !== "record" || path.length === 0) return root;
    const key = path.length === 1 ? (path[0] as string) : "";
    return root.get(key) ?? { missing: true };
  }

  /** True when `name`'s head is a module `link` field with no value. */
  private linkUnset(name: string): boolean {
    const v = this.moduleLink((name.split(".")[0] as string).toLowerCase());
    return v?.kind === "record" && !v.present;
  }

  /**
   * #1729 — a module field a plugin filled (a content variant), placed by
   * its tag's context; null for a core value or a link field (a link reads
   * through {@link moduleLink}), which keep their path.
   */
  private moduleValue(t: Token, source: string): string | null {
    if (t.name.includes(".") || this.fieldKind(t.name) === "link") return null;
    const owned = this.modulePluginValue(t.name);
    if (owned === null) return null;
    return this.pluginText(t.start, owned.origin, scalarSectionString(owned.value), source);
  }

  /** Whether the module field `name` (or the head of `name.path`) holds a plugin's value. */
  private pluginOwnedHead(name: string): boolean {
    return this.modulePluginValue(name.split(".")[0] as string) !== null;
  }

  /** The plugin's value of module field `name`, if a plugin filled it. */
  private modulePluginValue(name: string): ReturnType<typeof pluginValueOf> {
    const key = Object.hasOwn(this.env.values, name) ? name : name.toLowerCase();
    return Object.hasOwn(this.env.values, key) ? pluginValueOf(this.env.values[key]) : null;
  }

  private fieldKind(name: string): string | undefined {
    return (this.env.fields.get(name) ?? this.env.fields.get(name.toLowerCase()))?.kind;
  }

  private isModuleLevel(name: string): boolean {
    const lower = name.toLowerCase();
    return (
      this.env.fields.has(name) || this.env.fields.has(lower) || this.env.moduleLevelKeys.has(lower)
    );
  }

  private notDeclared(name: string, st: RenderState): string {
    const field = this.listField(st);
    return field.length > 0 ? `field-not-declared:${field}.${name}` : `field-not-declared:${name}`;
  }

  /**
   * The marker of a dotted path whose head exists and whose rest does not.
   * Unlike an unknown `{{name}}`, which can be literal copy, this is a
   * broken placeholder, so its marker stops a Stage (#1433). `page.*` gets
   * a marker of its own (#1717, `lists/page-paths.ts`); `site_text.*`
   * keeps `field-not-declared`.
   */
  private unknownPath(name: string, st: RenderState, miss?: Miss): string {
    if (isContextHead(name)) {
      if (this.env.lists === undefined) return `list-context-unavailable:${contextHead(name)}`;
      const page =
        miss?.resolved !== undefined && miss.last !== undefined
          ? this.pageMarker(name, miss.resolved, miss.last)
          : null;
      return page ?? this.notDeclared(name, st);
    }
    const props =
      miss?.entry !== undefined && miss.resolved !== undefined && miss.last !== undefined
        ? this.entryPropsMarker(name, miss.entry, miss.resolved, miss.last)
        : null;
    if (props !== null) return props;
    const field = this.listField(st);
    return `field-path-unknown:${field.length > 0 ? `${field}.` : ""}${name}`;
  }

  /** The innermost list entry of the chain that answers `head`, if any. */
  private entryOf(head: string, st: RenderState): ScopeEntry | undefined {
    for (let k = st.chain.length - 1; k >= 0; k -= 1) {
      const entry = st.chain[k]?.entry;
      if (entry?.get(head) !== undefined) return entry;
    }
    return undefined;
  }

  /**
   * #1727 — `{{props.<name>…}}` on a page-shaped list entry (a query, the
   * breadcrumbs, the children) that its value cannot answer: the same
   * `page-path-unknown` marker, and so the same type-aware repair, as
   * `{{page.props.<name>…}}` on the rendering page. Null for any other
   * name or entry, which keeps `field-path-unknown` (a list entry's link
   * field, `{{link.label}}`).
   */
  private entryPropsMarker(
    name: string,
    entry: ScopeEntry,
    resolved: number,
    value: ScopeValue,
  ): string | null {
    const parts = name.toLowerCase().split(".");
    if (parts[0] !== "props" || entry.propertyType === undefined || resolved < 1) return null;
    const base = parts.slice(0, resolved);
    return pagePathUnknownMarker(base.join("."), propsValueType(base, value, entry.propertyType));
  }

  /**
   * #1717 — the marker of a `{{page.*}}` name the page cannot answer, when
   * its first `resolved` parts were found and `value` is the last of them:
   * an unknown key of the page, or a path (or a tag) the value at the
   * found part cannot answer. Null for any other name.
   */
  private pageMarker(name: string, resolved: number, value: ScopeValue): string | null {
    const parts = name.toLowerCase().split(".");
    if (parts[0] !== "page" || parts.length < 2 || resolved < 1) return null;
    if (resolved === 1) return pageKeyUnknownMarker(parts[1] as string);
    const base = parts.slice(1, resolved);
    return pagePathUnknownMarker(base.join("."), this.pageValueType(base, value));
  }

  /** What the value at `page.<base>` is, as {@link pageMarker} names it. */
  private pageValueType(base: readonly string[], value: ScopeValue): string {
    const key = base[0] as string;
    const lists = this.env.lists;
    if (key === "props" && lists !== undefined) {
      return propsValueType(base, value, (n) => lists.pagePropertyType(n));
    }
    if (base.length === 1) return PAGE_KEY_TYPES[key] ?? scopeKindName(value);
    if (base.length === 2 && key === "terms") return "term";
    return scopeKindName(value);
  }

  /**
   * The marker of a found value that cannot render as a tag (`{{page.props}}`,
   * a list), and of `{{props}}` / a term property on a page-shaped entry.
   */
  private unrenderable(name: string, st: RenderState, v: ScopeValue): string {
    const parts = name.split(".").length;
    const page = this.env.lists === undefined ? null : this.pageMarker(name, parts, v);
    if (page !== null) return page;
    const head = (name.split(".")[0] as string).toLowerCase();
    const entry = head === "props" ? this.entryOf(head, st) : undefined;
    const props = entry === undefined ? null : this.entryPropsMarker(name, entry, parts, v);
    return props ?? this.notDeclared(name, st);
  }

  // ── Plain tags ──

  private tag(t: Token, st: RenderState): string {
    const source = this.html.slice(t.start, t.end);
    if (this.pluginOnly && (t.sigil === ">" || !this.pluginOwnedHead(t.name))) return source;
    if (t.sigil === ">") return this.partial(t, source, st);
    // `{{&f}}` never reads a list entry: a module field, Mustache's unless a
    // plugin filled it.
    if (t.sigil === "&") return this.moduleTag(t, source);
    if (t.sigil !== "") return source;
    if (st.dot !== null && t.name === "item" && st.chain.length === 0) {
      if (st.dotPlugin) return this.pluginText(t.start, st.dotPlugin, st.dot, source);
      this.coreValue(t.start, st.dot, st.dotField ?? "item");
      return this.env.mkSentinel(st.dot);
    }
    const dotted = t.name.includes(".");
    const linkField = this.env.fields.get(t.name.toLowerCase())?.kind === "link";
    if (st.chain.length === 0 && !dotted && !linkField) return this.moduleTag(t, source);
    const entryValue = this.lookup(t.name, st);
    const v = entryValue ?? this.linkPath(t.name);
    if (v === undefined) {
      if (dotted) {
        const head = t.name.slice(0, t.name.indexOf("."));
        if (this.isModuleLevel(head)) return this.raw(source, this.unknownPath(t.name, st));
        if (st.chain.length === 0) return source;
        return this.raw(source, this.notDeclared(t.name, st));
      }
      // No entry answers it: the module field's value, as Mustache would read it.
      if (this.isModuleLevel(t.name)) return this.moduleTag(t, source);
      return this.raw(source, this.notDeclared(t.name, st));
    }
    if ("missing" in v) return this.raw(source, this.unknownPath(t.name, st, v));
    if (entryValue === undefined && this.linkUnset(t.name)) {
      // A bare `{{f}}` with no value stays raw like any declared field; a
      // path into it is a broken link in the page, so it stops a Stage.
      return dotted ? this.raw(source, `field-value-empty:${t.name}`) : source;
    }
    return this.valueText(v, source, t, st);
  }

  private valueText(v: ScopeValue, source: string, t: Token, st: RenderState): string {
    const name = t.name;
    switch (v.kind) {
      case "text":
        if (v.plugin) return this.pluginText(t.start, v.plugin, v.text, source);
        this.coreValue(t.start, v.text, this.coreFieldName(t, st));
        return v.text.length === 0 ? "" : this.env.mkSentinel(v.text);
      case "bool":
        if (v.plugin) return this.pluginText(t.start, v.plugin, String(v.value), source);
        return String(v.value);
      case "record":
        if (v.text === null) return this.raw(source, this.unrenderable(name, st, v));
        if (v.plugin) return this.pluginText(t.start, v.plugin, v.text, source);
        this.coreValue(t.start, v.text, this.coreFieldName(t, st));
        return v.text.length === 0 ? "" : this.env.mkSentinel(v.text);
      case "failed":
        return this.raw(source, v.marker);
      default:
        return this.raw(source, this.unrenderable(name, st, v));
    }
  }

  // ── Partials ──

  private partial(t: Token, source: string, st: RenderState): string {
    if (st.chain.length === 0) return source;
    if (t.name === "recurse") return this.recurse(st);
    const v = this.lookup(t.name, st);
    if (v === undefined) {
      return this.isModuleLevel(t.name) ? source : this.raw(source, this.notDeclared(t.name, st));
    }
    if ("missing" in v) return this.raw(source, this.notDeclared(t.name, st));
    if (v.kind === "module") {
      const frame = st.chain[st.chain.length - 1] as Frame;
      const field = this.listField(st);
      const key = `list:${field}/${frame.entry.id}/${t.name}`;
      const html = this.env.partials(key, v.ref);
      if (html === undefined) {
        this.env.missing.push(`nested-renderer-unavailable:${field}[${frame.entry.id}].${t.name}`);
        return `<!-- caelo:module ${field}[${frame.entry.id}].${t.name} needs recursive renderer (compose path) -->`;
      }
      return this.env.mkSentinel(html);
    }
    if (v.kind === "text" && v.text.length === 0) return "";
    if (v.kind === "failed") return this.raw(source, v.marker);
    const reason = `kind-mismatch:${this.listField(st)}.${t.name} expected=module actual=${v.kind}`;
    this.env.missing.push(reason);
    return `<!-- caelo:missing reason=${reason} -->`;
  }

  /** `{{>recurse}}`: the current entry's children with the enclosing section's block. */
  private recurse(st: RenderState): string {
    const frame = st.chain[st.chain.length - 1] as Frame;
    const key = frame.entry.childrenKey;
    if (key === null) return "";
    const kids = frame.entry.get(key);
    if (kids?.kind !== "list") return "";
    return this.iterate(kids.entries, frame.name, frame.block, st);
  }

  // ── Sections ──

  private section(t: Token, block: Frame["block"], source: string, st: RenderState): string {
    const inverted = t.sigil === "^";
    const v = this.lookup(t.name, st) ?? (t.name.includes(".") ? this.linkPath(t.name) : undefined);
    if (v !== undefined) {
      if ("missing" in v) return this.raw(source, this.unknownPath(t.name, st, v));
      return this.scopeSection(v, t.name, inverted, block, source, st);
    }
    if (t.name.includes(".")) return this.raw(source, this.notDeclared(t.name, st));
    return this.moduleSection(t.name, inverted, block, source, st);
  }

  /** A section over a value found in the entry chain or `page`. */
  private scopeSection(
    v: ScopeValue,
    name: string,
    inverted: boolean,
    block: Frame["block"],
    source: string,
    st: RenderState,
  ): string {
    if (v.kind === "failed") return this.raw(source, v.marker);
    if (v.kind === "list") {
      if (inverted) return v.entries.length === 0 ? this.body(block, st, null) : "";
      return this.iterate(v.entries, name, block, st);
    }
    const present =
      v.kind === "bool"
        ? v.value
        : v.kind === "text"
          ? v.text.trim().length > 0
          : v.kind === "record"
            ? v.present
            : true;
    return present !== inverted ? this.body(block, st, st.dot, st.dotPlugin, st.dotField) : "";
  }

  /** A section over a module field (or an undeclared plugin source name). */
  private moduleSection(
    name: string,
    inverted: boolean,
    block: Frame["block"],
    source: string,
    st: RenderState,
  ): string {
    const env = this.env;
    const field = env.fields.get(name);
    if (!field) {
      // No declared field — a plugin may still offer this name as a list
      // source. Module fields are looked up FIRST, so a plugin can never
      // shadow something the module's author declared.
      const plugin = env.lists?.pluginSource(name) ?? null;
      if (plugin !== null) {
        if (!plugin.ok) return this.raw(source, plugin.marker);
        if (inverted) return plugin.entries.length === 0 ? this.body(block, st, null) : "";
        return this.iterate(plugin.entries, name, block, st);
      }
      return this.raw(source, this.notDeclared(name, st));
    }
    const raw = Object.hasOwn(env.values, name) ? env.values[name] : field.default;
    if (field.kind === "module-list") {
      if (inverted) return Array.isArray(raw) && raw.length > 0 ? "" : this.body(block, st, null);
      return env.renderModuleList(name, field);
    }
    if (field.kind === "list") {
      if (!env.lists) return this.raw(source, `list-context-unavailable:${name}`);
      const spec: ListFieldSpec = {
        name: field.name,
        listType: field.listType ?? "",
        ...(field.bind !== undefined ? { bind: field.bind } : {}),
        ...(field.list !== undefined ? { list: field.list } : {}),
        ...(field.source !== undefined ? { source: field.source } : {}),
        ...(field.default !== undefined ? { default: field.default } : {}),
        ...(field.paginate !== undefined ? { paginate: field.paginate } : {}),
      };
      const value = Object.hasOwn(env.values, name) ? env.values[name] : undefined;
      const res = env.lists.resolveField(spec, value, env.holder);
      if (!res.ok) return this.raw(source, res.marker);
      if (inverted) return res.entries.length === 0 ? this.body(block, st, null) : "";
      return this.iterate(res.entries, name, block, st);
    }
    // Any other field used as a section is a CONDITIONAL (Mustache
    // semantics): the block once when the field has a present, non-empty
    // value, dropped when empty — never a kind-mismatch, which used to
    // silently drop real scalar content. `{{.}}` / `{{item}}` inside it
    // read the scalar. An empty conditional is intentional, not missing.
    const link = field.kind === "link" ? this.moduleLink(name) : undefined;
    if (link?.kind === "failed") return this.raw(source, link.marker);
    const plain = plainValue(raw);
    const present = link?.kind === "record" ? link.present : isPresentSectionValue(plain);
    if (present === inverted) return "";
    const dot = !present
      ? ""
      : link?.kind === "record"
        ? (link.text ?? "")
        : scalarSectionString(plain);
    // `{{.}}` of a plugin's value is checked where it lands, like the field.
    const dotPlugin =
      link?.kind === "record" ? link.plugin : (pluginValueOf(raw)?.origin ?? undefined);
    if (dot.length === 0) return this.body(block, st, st.dot, st.dotPlugin, st.dotField);
    return this.body(block, st, dot, dotPlugin, name.toLowerCase());
  }

  private body(
    block: Frame["block"],
    st: RenderState,
    dot: string | null,
    dotPlugin?: PluginValueOrigin,
    dotField?: string,
  ): string {
    return this.range(block.from, block.to, block.textFrom, block.textTo, {
      chain: st.chain,
      dot,
      ...(dot !== null && dotPlugin ? { dotPlugin } : {}),
      ...(dot !== null && dotField !== undefined ? { dotField } : {}),
    });
  }

  private iterate(
    entries: readonly ScopeEntry[],
    name: string,
    block: Frame["block"],
    st: RenderState,
  ): string {
    // The empty-restoring sentinel in front claims the iteration's first
    // element for its own entries: an enclosing entry whose block starts
    // with this iteration (`{{#items}}<p>…`) must not stamp a GENERATED
    // entry's element as its own root.
    let out = entries.length > 0 ? this.env.mkSentinel("") : "";
    for (const entry of entries) {
      const chain = [...st.chain, { entry, block, name }];
      const rendered = this.range(block.from, block.to, block.textFrom, block.textTo, {
        chain,
        dot: null,
      });
      out += entry.itemAttr === null ? rendered : stampListItem(rendered, entry.itemAttr);
    }
    return out;
  }
}

/**
 * What the value at `props[.<name>[.…]]` (`base`) is: `props` itself, the
 * property's declared type (`propertyType`), or the kind of a value
 * further down.
 */
function propsValueType(
  base: readonly string[],
  value: ScopeValue,
  propertyType: (name: string) => string | null,
): string {
  if (base.length === 1) return "props";
  if (base.length === 2) return propertyType(base[1] as string) ?? scopeKindName(value);
  return scopeKindName(value);
}

/** A scope value's kind as a marker names it (`page-path-unknown:<path>:<kind>`). */
function scopeKindName(v: ScopeValue): string {
  return v.kind === "bool" ? "boolean" : v.kind;
}

/**
 * Mustache-style truthiness for a conditional section value. Empty string,
 * null/undefined, `false`, and an empty array/object are absent; everything
 * else (incl. a numeric 0 — a real content value, not a control flag) is
 * present.
 */
export function isPresentSectionValue(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === false) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (typeof raw === "number") return !Number.isNaN(raw);
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === "object") return Object.keys(raw as object).length > 0;
  return true;
}

/** String form for `{{.}}`/`{{item}}` inside a scalar conditional; objects stringify to "". */
function scalarSectionString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

/** A dotted placeholder a module's fields cannot answer ({@link fieldPathProblems}). */
export interface FieldPathProblem {
  /** The tag as written, e.g. `{{primary_cta.label}}`. */
  readonly tag: string;
  readonly field: string;
  readonly kind: string;
}

/**
 * The dotted placeholders in `html` whose head is a field of this module
 * and whose path that field cannot answer: every path into a field other
 * than `link`, and a `link` path past {@link LINK_VALUE_KEYS}. The inside of
 * a list section is skipped: its keys belong to the entries, which only the
 * render knows. Read at write time so a broken placeholder is refused where
 * it is authored, instead of surfacing at the Stage.
 */
export function fieldPathProblems(
  html: string,
  fields: readonly { readonly name: string; readonly kind?: string }[],
): FieldPathProblem[] {
  const byName = new Map(fields.map((f) => [f.name, f.kind ?? "text"]));
  // `{{&…}}` reads a module field as Mustache does, never a list entry: no path to check.
  const tokens = tokenize(html).filter((t) => t.sigil !== "&");
  const pairs = matchSections(tokens);
  const out: FieldPathProblem[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    const close = pairs.get(i);
    if (close !== undefined) {
      // A section over no field of this module (a plugin list source,
      // `page.terms.*`) opens entries too.
      const kind = byName.get((t.name.split(".")[0] as string).toLowerCase());
      if (kind === undefined || (ENTRY_SCOPE_KINDS.has(kind) && !t.name.includes("."))) {
        i = close;
        continue;
      }
    }
    if (t.sigil === "/" || t.sigil === ">" || !t.name.includes(".") || isContextHead(t.name)) {
      continue;
    }
    const [head, ...path] = t.name.toLowerCase().split(".") as [string, ...string[]];
    const kind = byName.get(head);
    if (kind === undefined) continue;
    const linkPath =
      path.length === 1 && (LINK_VALUE_KEYS as readonly string[]).includes(path[0] as string);
    if (kind === "link" && linkPath) continue;
    out.push({ tag: html.slice(t.start, t.end), field: head, kind });
  }
  return out;
}

/** The field kinds whose section opens entries, with keys of their own. */
const ENTRY_SCOPE_KINDS: ReadonlySet<string> = new Set(["list", "module-list"]);

/**
 * #1748 — the value tags inside every `{{#name}}` section of `html` (a list
 * field's entries' keys, dotted link paths included; `page.*`,
 * `site_text.*` and `{{&f}}`, which reads the module field, left out), by
 * offset: where a list's entries render.
 */
export function sectionValueTags(html: string, name: string): ModuleValueTag[] {
  const tokens = tokenize(html);
  const pairs = matchSections(tokens);
  const lower = name.toLowerCase();
  const seen = new Set<number>();
  const out: ModuleValueTag[] = [];
  for (const [i, t] of tokens.entries()) {
    const close = pairs.get(i);
    if (close === undefined || t.sigil !== "#" || t.name.toLowerCase() !== lower) continue;
    for (let k = i + 1; k < close; k += 1) {
      const inner = tokens[k] as Token;
      // `{{&f}}` reads the module field, never the entry (moduleValueTags has it).
      if (inner.sigil !== "" || isContextHead(inner.name)) continue;
      if (seen.has(inner.start)) continue;
      seen.add(inner.start);
      out.push({ start: inner.start, name: inner.name.toLowerCase() });
    }
  }
  return out;
}

/** #1748 — every `{{<head>.…}}` value tag of `html` (`site_text`, `page`), wherever it stands. */
export function contextValueTags(html: string, head: "page" | "site_text"): ModuleValueTag[] {
  return tokenize(html)
    .filter((t) => (t.sigil === "" || t.sigil === "&") && contextHead(t.name) === head)
    .map((t) => ({ start: t.start, name: t.name.toLowerCase() }));
}

/** A module field's value tag Mustache substitutes ({@link moduleValueTags}). */
export interface ModuleValueTag {
  /** Offset of the tag's `{{` in the template (the inner one of `{{{…}}}`). */
  readonly start: number;
  /** The field name, lowercased. */
  readonly name: string;
}

/**
 * #1748 — the tags where Mustache substitutes a module field's value (or
 * its default), for a write's check: the plain `{{name}}` / `{{{name}}}`
 * tags outside list entries and every `{{&name}}`. Inside a `{{#…}}`
 * section that opens entries (a list, a module list, a plugin source,
 * `page.*`) a plain tag reads the entries first, which only the render
 * knows; the render checks what it substitutes there.
 */
export function moduleValueTags(
  html: string,
  fields: ReadonlyMap<string, { readonly kind: string }>,
  /** Also a link field's paths (`{{cta.href}}`, `{{cta.title}}`), which the section pass substitutes. */
  withPaths = false,
): ModuleValueTag[] {
  const tokens = tokenize(html);
  if (tokens.length === 0) return [];
  const pairs = matchSections(tokens);
  const kindOf = (name: string) => (fields.get(name) ?? fields.get(name.toLowerCase()))?.kind;
  const out: ModuleValueTag[] = [];
  // The close token of every entry section the walk is inside.
  const inEntries: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    while (inEntries.length > 0 && i >= (inEntries[inEntries.length - 1] as number)) {
      inEntries.pop();
    }
    const close = pairs.get(i);
    if (close !== undefined) {
      // An inverted section renders its body without entries: module fields.
      const kind = kindOf((t.name.split(".")[0] as string).toLowerCase());
      const entries = kind === undefined || (ENTRY_SCOPE_KINDS.has(kind) && !t.name.includes("."));
      if (t.sigil === "#" && entries) inEntries.push(close);
      continue;
    }
    // Inside entries only `{{&f}}` surely reads the module field.
    const reads = t.sigil === "&" || (t.sigil === "" && inEntries.length === 0);
    if (!reads) continue;
    if (t.name.includes(".") && (!withPaths || isContextHead(t.name))) continue;
    out.push({ start: t.start, name: t.name.toLowerCase() });
  }
  return out;
}

/** What the author does about `problems` (non-empty): names the forms that work. */
export function describeFieldPathProblems(problems: readonly FieldPathProblem[]): string {
  const lines = problems.map(({ tag, field, kind }) => {
    if (kind === "link") {
      return `${tag}: \`${field}\` is a link field with the paths href, target and title. Use {{${field}}} or {{${field}.href}} for the URL; text beside the link, like its label, is a text field of its own (\`${field}_label\`).`;
    }
    if (ENTRY_SCOPE_KINDS.has(kind)) {
      return `${tag}: \`${field}\` is a ${kind} field. Iterate it with {{#${field}}}…{{/${field}}} and use the entry's keys inside.`;
    }
    return `${tag}: \`${field}\` is a ${kind} field and has no paths. Use {{${field}}}.`;
  });
  return `Placeholder(s) this module's fields cannot answer, nothing was saved. ${lines.join(" ")}`;
}

/** The attribute a rendered list entry's root element carries (`docs/lists.md` §13). */
export const LIST_ITEM_ATTRIBUTE = "data-caelo-list-item";

/**
 * Stamp `data-caelo-list-item` on a rendered entry's root element: the
 * first opening tag, when the entry's markup STARTS with one (leading
 * whitespace and comments allowed). An entry that starts with text
 * (`{{name}}, `) has no root element and stays unstamped, rather than
 * attributing the entry to some inner `<b>`. Idempotent.
 */
export function stampListItem(html: string, attr: string): string {
  let i = 0;
  for (;;) {
    while (i < html.length && /\s/.test(html[i] as string)) i += 1;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) return html;
      i = end + 3;
      continue;
    }
    break;
  }
  if (html[i] !== "<" || !/[a-zA-Z]/.test(html[i + 1] ?? "")) return html;
  let quote: string | null = null;
  let j = i + 1;
  for (; j < html.length; j += 1) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") break;
  }
  if (j >= html.length) return html;
  const tag = html.slice(i, j);
  if (tag.includes(`${LIST_ITEM_ATTRIBUTE}=`)) return html;
  const insertAt = tag.endsWith("/") ? j - 1 : j;
  return `${html.slice(0, insertAt)} ${LIST_ITEM_ATTRIBUTE}="${attr.replace(/"/g, "&quot;")}"${html.slice(insertAt)}`;
}
