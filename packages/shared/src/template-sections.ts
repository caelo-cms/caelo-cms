// SPDX-License-Identifier: MPL-2.0

/**
 * Section pass of the template engine (`template-engine.ts`): every
 * `{{#name}}…{{/name}}` and `{{^name}}…{{/name}}`, list iteration with
 * entry scopes, `{{>recurse}}`, `{{>f}}` for an entry's embedded module,
 * dot access and `{{page.*}}` (epic #1107, `docs/lists.md` §8).
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

import type { ListFieldSpec, ListHolder, ListPageContext } from "./lists/resolve.js";
import type { ScopeEntry, ScopeValue } from "./lists/scope.js";

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
const TAG_RE = /\{\{\s*([#^/>]\s*)?([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\s*\}\}/g;
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

interface RenderState {
  readonly chain: readonly Frame[];
  /** `{{.}}` / `{{item}}` value inside a scalar conditional; null elsewhere. */
  readonly dot: string | null;
}

/**
 * Run the section pass over `html`. Returns the HTML with every matched
 * section rendered and every tag inside list entries resolved.
 */
export function renderSections(html: string, env: SectionEnv): string {
  const tokens = tokenize(html);
  if (tokens.length === 0) return html;
  const pairs = matchSections(tokens);
  if (pairs.size === 0 && !tokens.some((t) => t.name.includes("."))) return html;
  const r = new SectionRenderer(html, tokens, pairs, env);
  return r.range(0, tokens.length, 0, html.length, { chain: [], dot: null });
}

class SectionRenderer {
  constructor(
    private readonly html: string,
    private readonly tokens: readonly Token[],
    private readonly pairs: ReadonlyMap<number, number>,
    private readonly env: SectionEnv,
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
      out += this.tag(t, st);
      cursor = t.end;
      i += 1;
    }
    return out + this.text(cursor, textTo, st);
  }

  private text(from: number, to: number, st: RenderState): string {
    const s = this.html.slice(from, to);
    if (st.dot === null || s.length === 0) return s;
    const dot = st.dot;
    return s.replace(DOT_RE, () => this.env.mkSentinel(dot));
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
   * does not.
   */
  private lookup(name: string, st: RenderState): ScopeValue | { missing: true } | undefined {
    const parts = name.split(".");
    const head = (parts[0] as string).toLowerCase();
    let v: ScopeValue | undefined;
    if (head === "page") {
      v = this.env.lists?.pageScope() ?? undefined;
      if (v === undefined)
        return parts.length > 1 || st.chain.length > 0 ? { missing: true } : undefined;
    } else if (head === "site_text") {
      v = this.env.lists?.siteTextScope();
      if (v === undefined) return { missing: true };
    } else {
      for (let k = st.chain.length - 1; k >= 0 && v === undefined; k -= 1) {
        v = st.chain[k]?.entry.get(head);
      }
      if (v === undefined) return undefined;
    }
    for (const p of parts.slice(1)) {
      if (v.kind !== "record") return { missing: true };
      const next: ScopeValue | undefined = v.get(p.toLowerCase());
      if (next === undefined) return { missing: true };
      v = next;
    }
    return v;
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

  // ── Plain tags ──

  private tag(t: Token, st: RenderState): string {
    const source = this.html.slice(t.start, t.end);
    if (t.sigil === ">") return this.partial(t, source, st);
    if (t.sigil !== "") return source;
    if (st.dot !== null && t.name === "item" && st.chain.length === 0) {
      return this.env.mkSentinel(st.dot);
    }
    const dotted = t.name.includes(".");
    if (st.chain.length === 0 && !dotted) return source;
    const v = this.lookup(t.name, st);
    if (v === undefined) {
      if (dotted) {
        const head = t.name.slice(0, t.name.indexOf("."));
        if (st.chain.length === 0 && !this.isModuleLevel(head)) return source;
        return this.raw(source, this.notDeclared(t.name, st));
      }
      if (this.isModuleLevel(t.name)) return source;
      return this.raw(source, this.notDeclared(t.name, st));
    }
    if ("missing" in v) {
      const marker =
        isContextHead(t.name) && this.env.lists === undefined
          ? `list-context-unavailable:${contextHead(t.name)}`
          : this.notDeclared(t.name, st);
      return this.raw(source, marker);
    }
    return this.valueText(v, source, t.name, st);
  }

  private valueText(v: ScopeValue, source: string, name: string, st: RenderState): string {
    switch (v.kind) {
      case "text":
        return v.text.length === 0 ? "" : this.env.mkSentinel(v.text);
      case "bool":
        return String(v.value);
      case "record":
        if (v.text === null) return this.raw(source, this.notDeclared(name, st));
        return v.text.length === 0 ? "" : this.env.mkSentinel(v.text);
      case "failed":
        return this.raw(source, v.marker);
      default:
        return this.raw(source, this.notDeclared(name, st));
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
    const v = this.lookup(t.name, st);
    if (v !== undefined) {
      if ("missing" in v) {
        const marker =
          isContextHead(t.name) && this.env.lists === undefined
            ? `list-context-unavailable:${contextHead(t.name)}`
            : this.notDeclared(t.name, st);
        return this.raw(source, marker);
      }
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
    return present !== inverted ? this.body(block, st, st.dot) : "";
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
    const present = isPresentSectionValue(raw);
    if (present === inverted) return "";
    const dot = present ? scalarSectionString(raw) : "";
    return this.body(block, st, dot.length > 0 ? dot : st.dot);
  }

  private body(block: Frame["block"], st: RenderState, dot: string | null): string {
    return this.range(block.from, block.to, block.textFrom, block.textTo, { chain: st.chain, dot });
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
