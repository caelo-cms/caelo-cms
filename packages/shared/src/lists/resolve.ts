// SPDX-License-Identifier: MPL-2.0

/**
 * The list resolver (epic #1107, `docs/lists.md` §6, §7, §10). Turns a
 * module's `list` field — local entries, a shared list, a page query, a
 * system source or a plugin source — into the entry scopes the template
 * engine iterates, for ONE rendering page.
 *
 * Built once per preview / per build from batch-loaded
 * {@link ListRenderData} and cut per page with `forPage`, the same split
 * as `SiteLinkIndex`: everything after loading is pure and synchronous,
 * and the editor preview and the static generator get byte-identical
 * output from the same input.
 *
 * Per page it also records what the render read ({@link ListRenderDeps}),
 * which the generator writes to `render-deps.json` so an incremental
 * build can rebuild exactly the pages a change reaches.
 *
 * Loud, never silently empty (CLAUDE.md §2): an unbound shared field, a
 * deleted list, an unknown type, a plugin source whose plugin is off and
 * a malformed entry all resolve to a failure marker the engine renders
 * raw.
 */

import type { LinkResolver } from "../link-refs.js";
import { parseLinkRef } from "../link-refs.js";
import { type FieldDef, TERM_REF_RE, validateFieldValue } from "./fields.js";
import type { ListItem } from "./items.js";
import {
  effectiveMaxDepth,
  LIST_QUERY_MAX_LIMIT,
  type ListTypeDef,
  type NodeDef,
  type PageQuery,
  pageQuerySchema,
  type QueryKnob,
  type SourceDef,
  type SystemSourceName,
} from "./list-type.js";
import { parseListRef } from "./refs.js";
import type {
  ListPageRecord,
  ListRenderData,
  ListRenderDeps,
  LoadedList,
  PluginSourceEntry,
} from "./render-data.js";
import {
  bool,
  dateValue,
  EMPTY_LIST,
  EMPTY_TEXT,
  fieldValue,
  linkValue,
  listValue,
  mediaValue,
  positionValue,
  selectFlag,
  text,
  untypedValue,
  type ValueEnv,
} from "./resolve-values.js";
import type { ScopeEntry, ScopeValue } from "./scope.js";

/** Prefixes of the list failure markers (`docs/lists.md` §8). */
const LIST_MARKER_PREFIXES = [
  "list-unbound:",
  "list-missing:",
  "list-type-missing:",
  "list-source-unavailable:",
  "list-malformed:",
  "list-context-unavailable:",
] as const;

/** True for a list failure marker — the editor's missing-content surface shows these. */
export function isListFailureMarker(marker: string): boolean {
  return LIST_MARKER_PREFIXES.some((p) => marker.startsWith(p));
}

/** What the resolver needs from a module `list` field (`docs/lists.md` §7). */
export interface ListFieldSpec {
  readonly name: string;
  readonly listType: string;
  readonly bind?: "local" | "shared" | "source";
  readonly list?: string;
  readonly source?: SourceDef;
  readonly default?: unknown;
}

/** Result of resolving one list field for one page. */
export type ListFieldResolution =
  | { readonly ok: true; readonly entries: readonly ScopeEntry[] }
  | { readonly ok: false; readonly marker: string };

/**
 * Where a local list is stored: the content instance holding the module
 * field's value. Null for module field defaults (site chrome renders
 * from defaults) — then entries cannot be addressed by a plugin overlay
 * and carry `local/<field>/<itemId>` as their item attribute.
 */
export interface ListHolder {
  readonly contentInstanceId: string | null;
}

/** An overlay entry the resolver refused (unknown address, structural or invalid value). */
export interface ListOverlayIssue {
  readonly variant: string;
  readonly address: string;
  readonly reason: string;
}

/** Per-page options of {@link ListRenderContext.forPage}. */
export interface ListPageOptions {
  /** The page's link resolver; drives `is_current` URL comparison. */
  readonly linkResolver?: LinkResolver;
  /** Entries of every ACTIVE plugin list source for this page, keyed by source name. */
  readonly pluginSources?: Readonly<Record<string, readonly PluginSourceEntry[]>>;
}

/** The list view of ONE rendering page, handed to the template engine. */
export interface ListPageContext {
  /** The rendering page, or null for a render outside any page. */
  readonly pageId: string | null;
  /** Resolve a module list field with its placement value. */
  resolveField(field: ListFieldSpec, value: unknown, holder: ListHolder): ListFieldResolution;
  /** `{{page.*}}`: the rendering page as a record scope; null outside a page. */
  pageScope(): ScopeValue | null;
  /**
   * A section name no module field declares, read as a plugin list
   * source (`{{#language_links}}` written before the field kind existed).
   * Null when no installed plugin declares the name.
   */
  pluginSource(name: string): ListFieldResolution | null;
  /** What this page's render read so far. */
  deps(): ListRenderDeps;
  /** Overlay values this page's render refused (also the render-wide ones). */
  overlayIssues(): readonly ListOverlayIssue[];
}

/** Render-wide options of {@link createListRenderContext}. */
export interface ListRenderContextOptions {
  /** Source names declared by installed-but-inactive plugins → plugin slug. */
  readonly dormantPluginSources?: Readonly<Record<string, string>>;
}

/** The render-wide list context; cut per page with {@link ListRenderContext.forPage}. */
export interface ListRenderContext {
  forPage(pageId: string | null, opts?: ListPageOptions): ListPageContext;
  /** Overlay entries refused while preparing the render (shared lists, page props). */
  readonly overlayIssues: readonly ListOverlayIssue[];
}

/** Resolve one list field for a page (thin wrapper, `docs/lists.md` §10). */
export function resolveListField(
  field: ListFieldSpec,
  value: unknown,
  page: ListPageContext,
  holder: ListHolder = { contentInstanceId: null },
): ListFieldResolution {
  return page.resolveField(field, value, holder);
}

// ─── Overlays ────────────────────────────────────────────────────────

const SEG = "[a-z0-9_-]+";
const LIST_VALUE_RE = new RegExp(`^list/(${SEG})/item/(${SEG})/(${SEG})$`);
const INSTANCE_VALUE_RE = new RegExp(`^instance/(${SEG})/(${SEG})/item/(${SEG})/(${SEG})$`);
const PAGE_PROP_RE = new RegExp(`^page/(${SEG})/props/(${SEG})$`);
const LIST_HIDDEN_RE = new RegExp(`^list/(${SEG})/item/(${SEG})$`);
const INSTANCE_HIDDEN_RE = new RegExp(`^instance/(${SEG})/(${SEG})/item/(${SEG})$`);

/** One variant's overlay, validated where the render data allows it up front. */
interface PreparedOverlay {
  /** `<listId>/<itemId>` → field → value. */
  readonly listValues: Map<string, Map<string, unknown>>;
  readonly listHidden: Set<string>;
  /** `<ciId>/<field>/<itemId>` → item field → value (validated when the field renders). */
  readonly instanceValues: Map<string, Map<string, unknown>>;
  readonly instanceHidden: Set<string>;
  /** pageId → property → value. */
  readonly pageProps: Map<string, Map<string, unknown>>;
}

/** Field types an overlay may not replace: they change structure, not text. */
const STRUCTURAL_TYPES = new Set(["module", "term"]);

function setIn(m: Map<string, Map<string, unknown>>, k: string, f: string, v: unknown): void {
  const inner = m.get(k) ?? new Map<string, unknown>();
  inner.set(f, v);
  m.set(k, inner);
}

function prepareOverlays(
  data: ListRenderData,
  issues: ListOverlayIssue[],
): Map<string, PreparedOverlay> {
  const out = new Map<string, PreparedOverlay>();
  if (!data.overlays) return out;
  const itemIndex = new Map<string, { list: LoadedList; item: ListItem }>();
  for (const list of data.lists.values()) {
    const go = (items: readonly ListItem[]): void => {
      for (const it of items) {
        itemIndex.set(`${list.id}/${it.id}`, { list, item: it });
        if (it.children) go(it.children);
      }
    };
    go(list.items);
  }
  for (const [variant, overlay] of data.overlays) {
    const prepared: PreparedOverlay = {
      listValues: new Map(),
      listHidden: new Set(),
      instanceValues: new Map(),
      instanceHidden: new Set(),
      pageProps: new Map(),
    };
    const refuse = (address: string, reason: string): void => {
      issues.push({ variant, address, reason });
    };
    for (const [address, value] of overlay.values) {
      const lm = LIST_VALUE_RE.exec(address);
      if (lm) {
        const [, listId, itemId, fieldName] = lm as unknown as [string, string, string, string];
        const hit = itemIndex.get(`${listId}/${itemId}`);
        if (!hit) {
          refuse(address, "no such list entry");
          continue;
        }
        const field = fieldOf(data, hit.list.typeSlug, hit.item.node, fieldName);
        const problem = overlayValueProblem(field, value, address);
        if (problem) refuse(address, problem);
        else setIn(prepared.listValues, `${listId}/${itemId}`, fieldName, value);
        continue;
      }
      const im = INSTANCE_VALUE_RE.exec(address);
      if (im) {
        const [, ci, f, itemId, itemField] = im as unknown as [
          string,
          string,
          string,
          string,
          string,
        ];
        setIn(prepared.instanceValues, `${ci}/${f}/${itemId}`, itemField, value);
        continue;
      }
      const pm = PAGE_PROP_RE.exec(address);
      if (pm) {
        const [, pageId, prop] = pm as unknown as [string, string, string];
        const page = data.pages.get(pageId);
        const def = page
          ? data.pageTypes.get(page.pageTypeSlug)?.def.properties.find((p) => p.name === prop)
          : undefined;
        if (!page) refuse(address, "no such page");
        else {
          const problem = overlayValueProblem(def, value, address);
          if (problem) refuse(address, problem);
          else setIn(prepared.pageProps, pageId, prop, value);
        }
        continue;
      }
      refuse(address, "not a rendered value address");
    }
    for (const address of overlay.hidden) {
      const lh = LIST_HIDDEN_RE.exec(address);
      if (lh) {
        const key = `${lh[1]}/${lh[2]}`;
        if (itemIndex.has(key)) prepared.listHidden.add(key);
        else refuse(address, "no such list entry");
        continue;
      }
      const ih = INSTANCE_HIDDEN_RE.exec(address);
      if (ih) {
        prepared.instanceHidden.add(`${ih[1]}/${ih[2]}/${ih[3]}`);
        continue;
      }
      refuse(address, "not an entry address");
    }
    out.set(variant, prepared);
  }
  return out;
}

function fieldOf(
  data: ListRenderData,
  typeSlug: string,
  node: string,
  fieldName: string,
): FieldDef | undefined {
  return data.listTypes.get(typeSlug)?.def.nodes[node]?.fields.find((f) => f.name === fieldName);
}

/** Why an overlay value cannot replace a stored one; null when it can. */
function overlayValueProblem(
  field: FieldDef | undefined,
  value: unknown,
  address: string,
): string | null {
  if (!field) return "the entry's node declares no such field";
  if (STRUCTURAL_TYPES.has(field.type)) {
    return `a ${field.type} field changes structure, an overlay may only replace values`;
  }
  const bad = validateFieldValue({ ...field, required: false }, value, address);
  return bad.length > 0 ? (bad[0]?.message ?? "invalid value") : null;
}

// ─── Context ─────────────────────────────────────────────────────────

/** Build the render-wide list context from loaded data. */
export function createListRenderContext(
  data: ListRenderData,
  opts: ListRenderContextOptions = {},
): ListRenderContext {
  const overlayIssues: ListOverlayIssue[] = [];
  const overlays = prepareOverlays(data, overlayIssues);
  const dateFormat = makeDateFormatter(data.siteLanguage);
  const collator = new Intl.Collator(data.siteLanguage);
  const pageList = [...data.pages.values()];
  const listItemIndex = new Map<string, Map<string, { item: ListItem; depth: number }>>();
  const itemsOf = (list: LoadedList): Map<string, { item: ListItem; depth: number }> => {
    let idx = listItemIndex.get(list.id);
    if (!idx) {
      idx = new Map();
      const go = (items: readonly ListItem[], depth: number): void => {
        for (const it of items) {
          idx?.set(it.id, { item: it, depth });
          if (it.children) go(it.children, depth + 1);
        }
      };
      go(list.items, 1);
      listItemIndex.set(list.id, idx);
    }
    return idx;
  };
  const shared: SharedState = {
    data,
    overlays,
    dateFormat,
    collator,
    pageList,
    itemsOf,
    dormant: opts.dormantPluginSources ?? {},
  };
  return {
    overlayIssues,
    forPage: (pageId, pageOpts = {}) => createPageContext(shared, pageId, pageOpts, overlayIssues),
  };
}

interface SharedState {
  readonly data: ListRenderData;
  readonly overlays: ReadonlyMap<string, PreparedOverlay>;
  readonly dateFormat: (iso: string) => string;
  readonly collator: Intl.Collator;
  readonly pageList: readonly ListPageRecord[];
  readonly itemsOf: (list: LoadedList) => Map<string, { item: ListItem; depth: number }>;
  readonly dormant: Readonly<Record<string, string>>;
}

function makeDateFormatter(language: string): (iso: string) => string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" });
  } catch {
    // An invalid BCP-47 tag in site_settings is caught on write; the
    // render must not crash on stored data, so format in the root locale.
    fmt = new Intl.DateTimeFormat("und", { dateStyle: "long", timeZone: "UTC" });
  }
  const cache = new Map<string, string>();
  return (iso) => {
    let out = cache.get(iso);
    if (out === undefined) {
      const t = Date.parse(iso);
      out = Number.isNaN(t) ? iso : fmt.format(new Date(t));
      cache.set(iso, out);
    }
    return out;
  };
}

/** Where a stored tree lives — decides item attributes, overlays and markers. */
interface TreeCtx {
  readonly type: ListTypeDef;
  /** The module field (for markers) or the vocabulary slug for term entries. */
  readonly field: string;
  /** Prefix of `data-caelo-list-item` values; null = entries carry none. */
  readonly attrPrefix: string;
  /** Overlay values for an entry id. */
  readonly overlayValues: (itemId: string) => ReadonlyMap<string, unknown> | undefined;
  readonly hidden: (itemId: string) => boolean;
  /** Validate an overlay value lazily (instance overlays); returns the value to use. */
  readonly checkOverlay?: (item: ListItem, field: FieldDef, value: unknown) => boolean;
  /** Term entries alias `link` to `landing_page`. */
  readonly termLink: boolean;
}

interface Position {
  readonly index: number;
  readonly count: number;
  readonly depth: number;
}

function createPageContext(
  s: SharedState,
  pageId: string | null,
  opts: ListPageOptions,
  renderIssues: readonly ListOverlayIssue[],
): ListPageContext {
  const { data } = s;
  const current = pageId === null ? null : (data.pages.get(pageId) ?? null);
  const variant = pageId === null ? null : (data.pageVariants?.get(pageId)?.variant ?? null);
  const overlay = variant === null ? undefined : s.overlays.get(variant);
  const resolver = opts.linkResolver;
  const pageIssues: ListOverlayIssue[] = [];
  const depLists = new Set<string>();
  const depTypes = new Set<string>();
  const depQueries = new Map<
    string,
    { pageType: string | null; terms: readonly string[]; parent: string | null }
  >();
  let depTree = false;

  const urlOf = (href: string): string | null => {
    const ref = parseLinkRef(href);
    if (ref === null) return href.startsWith("/") ? normaliseUrl(href) : null;
    if (!resolver) return null;
    const r = resolver.resolve(ref);
    return r.status === "resolved" || r.status === "unpublished" ? normaliseUrl(r.url) : null;
  };
  let currentUrlMemo: string | null | undefined;
  const currentUrl = (): string | null => {
    if (currentUrlMemo === undefined) {
      currentUrlMemo = pageId === null ? null : urlOf(`caelo:page/${pageId}`);
    }
    return currentUrlMemo;
  };
  /** True when `href` points at the rendering page. */
  const isCurrentHref = (href: string): boolean => {
    if (href.length === 0 || pageId === null) return false;
    const ref = parseLinkRef(href);
    if (ref?.kind === "page" && ref.pageId === pageId) return true;
    if (ref?.kind === "media") return false;
    const here = currentUrl();
    return here !== null && urlOf(href) === here;
  };
  /** True when the rendering page sits below page `ancestorId` in the page tree. */
  const isPageAncestor = (ancestorId: string): boolean => {
    let p = current?.parentId ?? null;
    const seen = new Set<string>();
    while (p !== null && !seen.has(p)) {
      if (p === ancestorId) return true;
      seen.add(p);
      p = data.pages.get(p)?.parentId ?? null;
    }
    return false;
  };

  const valueEnv: ValueEnv = {
    data,
    formatDate: s.dateFormat,
    termEntries: (refs, field) => termEntries(refs, field),
  };

  // ── Stored trees ──

  /** Structural check of a stored tree before any entry renders. */
  const checkTree = (
    type: ListTypeDef,
    items: unknown,
    field: string,
  ): { ok: true; items: readonly ListItem[] } | { ok: false; marker: string } => {
    if (!Array.isArray(items)) return { ok: false, marker: `list-malformed:${field}[items]` };
    const max = effectiveMaxDepth(type);
    const walk = (level: readonly unknown[], depth: number, path: string): string | null => {
      for (let i = 0; i < level.length; i += 1) {
        const it = level[i] as Partial<ListItem> | null;
        const at = `${path}[${i}]`;
        if (
          typeof it !== "object" ||
          it === null ||
          typeof it.id !== "string" ||
          typeof it.node !== "string" ||
          typeof it.values !== "object" ||
          it.values === null
        ) {
          return at;
        }
        if (!type.nodes[it.node]) return `${at}.node`;
        if (depth > max) return at;
        if (it.children !== undefined) {
          if (!Array.isArray(it.children)) return `${at}.children`;
          const bad = walk(it.children, depth + 1, `${at}.children`);
          if (bad) return bad;
        }
      }
      return null;
    };
    const bad = walk(items, 1, "items");
    return bad === null
      ? { ok: true, items: items as ListItem[] }
      : { ok: false, marker: `list-malformed:${field}[${bad}]` };
  };

  const entriesOf = (items: readonly ListItem[], tree: TreeCtx, depth: number): ScopeEntry[] => {
    const visible = items.filter((it) => !tree.hidden(it.id));
    return visible.map((it, index) =>
      storedEntry(it, tree, { index, count: visible.length, depth }),
    );
  };

  const storedEntry = (item: ListItem, tree: TreeCtx, pos: Position): ScopeEntry => {
    const node = tree.type.nodes[item.node] as NodeDef;
    const overlayValues = tree.overlayValues(item.id);
    const memo = new Map<string, ScopeValue | undefined>();
    const storedValue = (f: FieldDef): unknown => {
      if (overlayValues?.has(f.name)) {
        const v = overlayValues.get(f.name);
        if (!tree.checkOverlay || tree.checkOverlay(item, f, v)) return v;
      }
      return item.values[f.name];
    };
    const children = (): ScopeEntry[] =>
      item.children ? entriesOf(item.children, tree, pos.depth + 1) : [];
    let isCurrentMemo: boolean | undefined;
    const isCurrent = (): boolean => {
      if (isCurrentMemo === undefined) {
        const f = node.current_from ? node.fields.find((x) => x.name === node.current_from) : null;
        const v = f ? storedValue(f) : undefined;
        const href =
          typeof (v as { href?: unknown })?.href === "string" ? (v as { href: string }).href : "";
        isCurrentMemo = isCurrentHref(href);
      }
      return isCurrentMemo;
    };
    const isAncestor = (): boolean => {
      const f = node.current_from ? node.fields.find((x) => x.name === node.current_from) : null;
      const v = f ? storedValue(f) : undefined;
      const href =
        typeof (v as { href?: unknown })?.href === "string" ? (v as { href: string }).href : "";
      const ref = href ? parseLinkRef(href) : null;
      if (ref?.kind === "page" && ref.pageId !== pageId && isPageAncestor(ref.pageId)) return true;
      const anyBelow = (entries: readonly ScopeEntry[]): boolean =>
        entries.some((e) => {
          const c = e.get("is_current");
          const a = e.get("is_ancestor");
          return (c?.kind === "bool" && c.value) || (a?.kind === "bool" && a.value);
        });
      return anyBelow(children());
    };
    const items = (): ScopeValue =>
      node.source ? sourceItems(node.source, item, node, tree.field) : EMPTY_LIST;
    const compute = (key: string): ScopeValue | undefined => {
      const field = node.fields.find((f) => f.name === key);
      if (field) return fieldValue(field, storedValue(field), valueEnv);
      if (key === "id") return text(item.id);
      if (key === "node") return text(item.node);
      const p = positionValue(key, pos);
      if (p) return p;
      if (key === "is_current") return bool(node.current_from ? isCurrent() : false);
      // Descendant-based, so a node without its own link (a column) is
      // still an ancestor of the current entry below it.
      if (key === "is_ancestor") return bool(isAncestor());
      const kids = node.children?.name;
      if (kids !== undefined && key === kids) return listValue(children());
      // `items` is reserved: a node without a source simply has none, so
      // a block shared by mixed node kinds needs no `is_<node>` guard.
      if (key === "items") return items();
      if (key.startsWith("has_") || key.startsWith("count_")) {
        const target = key.startsWith("has_") ? key.slice(4) : key.slice(6);
        let n: number | null = null;
        if (kids !== undefined && target === kids) n = children().length;
        else if (target === "items") {
          const v = items();
          n = v.kind === "list" ? v.entries.length : 0;
        }
        if (n === null) return undefined;
        return key.startsWith("has_") ? bool(n > 0) : text(String(n));
      }
      if (key.startsWith("is_") && tree.type.nodes[key.slice(3)]) {
        return bool(key.slice(3) === item.node);
      }
      const flag = selectFlag(node.fields, item.values, key);
      if (flag) return flag;
      if (tree.termLink && key === "link") {
        const lp = node.fields.find((f) => f.name === "landing_page" && f.type === "link");
        return lp ? fieldValue(lp, storedValue(lp), valueEnv) : linkValue({ href: "" }, null);
      }
      return undefined;
    };
    return {
      id: item.id,
      itemAttr: `${tree.attrPrefix}${item.id}`,
      childrenKey: node.children?.name ?? null,
      depth: pos.depth,
      get(key) {
        if (!memo.has(key)) memo.set(key, compute(key));
        return memo.get(key);
      },
    };
  };

  const sharedTree = (
    list: LoadedList,
    type: ListTypeDef,
    field: string,
    termLink: boolean,
  ): TreeCtx => ({
    type,
    field,
    attrPrefix: `${list.id}/`,
    overlayValues: (itemId) => overlay?.listValues.get(`${list.id}/${itemId}`),
    hidden: (itemId) => overlay?.listHidden.has(`${list.id}/${itemId}`) ?? false,
    termLink,
  });

  // ── Terms ──

  const termEntries = (refs: readonly string[], field: string): ScopeValue => {
    const out: ScopeEntry[] = [];
    const found: { list: LoadedList; type: ListTypeDef; item: ListItem; depth: number }[] = [];
    for (const ref of refs) {
      const m = TERM_REF_RE.exec(ref);
      if (!m) return { kind: "failed", marker: `list-malformed:${field}[${ref}]` };
      const [, listId, itemId] = m as unknown as [string, string, string];
      depLists.add(listId);
      const list = data.lists.get(listId);
      if (!list) return { kind: "failed", marker: `list-missing:${listId}` };
      const type = data.listTypes.get(list.typeSlug);
      if (!type) return { kind: "failed", marker: `list-type-missing:${list.typeSlug}` };
      depTypes.add(list.typeSlug);
      const hit = s.itemsOf(list).get(itemId);
      if (!hit) return { kind: "failed", marker: `list-missing:${listId}/item/${itemId}` };
      if (overlay?.listHidden.has(`${listId}/${itemId}`)) continue;
      found.push({ list, type: type.def, item: hit.item, depth: hit.depth });
    }
    found.forEach((t, index) => {
      out.push(
        storedEntry(t.item, sharedTree(t.list, t.type, field, true), {
          index,
          count: found.length,
          depth: t.depth,
        }),
      );
    });
    return listValue(out);
  };

  // ── Pages ──

  const propsValue = (p: ListPageRecord): ScopeValue => {
    const defs = data.pageTypes.get(p.pageTypeSlug)?.def.properties ?? [];
    const propOverlay = overlay?.pageProps.get(p.id);
    const memo = new Map<string, ScopeValue | undefined>();
    return {
      kind: "record",
      text: null,
      present: true,
      get(key) {
        if (!memo.has(key)) {
          const def = defs.find((d) => d.name === key);
          const raw = propOverlay?.has(key) ? propOverlay.get(key) : p.properties[key];
          memo.set(key, def ? fieldValue(def, raw, valueEnv) : undefined);
        }
        return memo.get(key);
      },
    };
  };

  /** `terms.<vocabulary slug>` of a page. */
  const pageTermsValue = (p: ListPageRecord): ScopeValue => ({
    kind: "record",
    text: null,
    present: p.terms.length > 0,
    get(slug) {
      const lists = [...data.lists.values()].filter((l) => l.slug === slug);
      if (lists.length === 0) return undefined;
      const ids = new Set(lists.map((l) => l.id));
      return termEntries(
        p.terms.filter((t) => ids.has(TERM_REF_RE.exec(t)?.[1] ?? "")),
        `terms.${slug}`,
      );
    },
  });

  const pageValue = (p: ListPageRecord): ((key: string) => ScopeValue | undefined) => {
    const memo = new Map<string, ScopeValue | undefined>();
    const compute = (key: string): ScopeValue | undefined => {
      switch (key) {
        case "id":
          return text(p.id);
        case "title":
          return text(p.title);
        case "link":
          return linkValue({ href: `caelo:page/${p.id}` }, data);
        case "published_at":
          return p.firstPublishedAt === null
            ? dateValue("", valueEnv)
            : dateValue(p.firstPublishedAt, valueEnv);
        case "updated_at":
          return dateValue(p.updatedAt, valueEnv);
        case "summary":
          return text(p.summary ?? "");
        case "image":
          return p.image === null ? mediaValue("", data) : mediaValue(p.image, data);
        case "page_type":
          return text(p.pageTypeSlug);
        case "props":
          return propsValue(p);
        case "terms":
          return pageTermsValue(p);
        case "is_current":
          return bool(p.id === pageId);
        case "is_ancestor":
          return bool(p.id !== pageId && isPageAncestor(p.id));
        default:
          return undefined;
      }
    };
    return (key) => {
      if (!memo.has(key)) memo.set(key, compute(key));
      return memo.get(key);
    };
  };

  const pageEntries = (pages: readonly ListPageRecord[]): ScopeEntry[] =>
    pages.map((p, index) => {
      const get = pageValue(p);
      const pos = { index, count: pages.length, depth: 1 };
      return {
        id: p.id,
        itemAttr: null,
        childrenKey: null,
        depth: 1,
        get: (key) => get(key) ?? positionValue(key, pos),
      };
    });

  const sameVariant = (p: ListPageRecord): boolean =>
    variant === null || data.pageVariants?.get(p.id)?.variant === variant;

  const runQuery = (q: PageQuery): ScopeValue => {
    const parent = q.parent
      ? ((parseLinkRef(q.parent) as { pageId: string } | null)?.pageId ?? null)
      : null;
    const terms = q.terms ?? [];
    const key = JSON.stringify([q.page_type ?? null, [...terms].sort(), parent]);
    if (!depQueries.has(key)) {
      depQueries.set(key, { pageType: q.page_type ?? null, terms: [...terms].sort(), parent });
    }
    const excludeCurrent = q.exclude_current ?? true;
    const mode = q.terms_mode ?? "any";
    const hits = s.pageList.filter(
      (p) =>
        p.inBuild &&
        sameVariant(p) &&
        (q.page_type === undefined || p.pageTypeSlug === q.page_type) &&
        (parent === null || p.parentId === parent) &&
        (!excludeCurrent || p.id !== pageId) &&
        (terms.length === 0 ||
          (mode === "all"
            ? terms.every((t) => p.terms.includes(t))
            : terms.some((t) => p.terms.includes(t)))),
    );
    hits.sort(pageOrder(q.order, s.collator));
    return listValue(pageEntries(hits.slice(0, q.limit)));
  };

  const byTitle = (a: ListPageRecord, b: ListPageRecord): number =>
    s.collator.compare(a.title, b.title) || compareIds(a.id, b.id);

  const systemSource = (
    name: SystemSourceName,
    terms: readonly string[],
    vocabularyIds: readonly string[] | null,
    field: string,
  ): ScopeValue => {
    switch (name) {
      case "breadcrumbs": {
        depTree = true;
        if (!current) return EMPTY_LIST;
        const chain: ListPageRecord[] = [];
        const seen = new Set<string>();
        let p: ListPageRecord | undefined = current;
        while (p && !seen.has(p.id)) {
          chain.unshift(p);
          seen.add(p.id);
          p = p.parentId === null ? undefined : data.pages.get(p.parentId);
        }
        return listValue(pageEntries(chain));
      }
      case "children": {
        depTree = true;
        if (!current) return EMPTY_LIST;
        return listValue(
          pageEntries(
            s.pageList.filter((p) => p.inBuild && p.parentId === current.id).sort(byTitle),
          ),
        );
      }
      case "siblings": {
        depTree = true;
        if (!current) return EMPTY_LIST;
        return listValue(
          pageEntries(
            s.pageList.filter((p) => p.inBuild && p.parentId === current.parentId).sort(byTitle),
          ),
        );
      }
      case "page_terms": {
        if (!current) return EMPTY_LIST;
        const ids = vocabularyIds === null ? null : new Set(vocabularyIds);
        for (const id of vocabularyIds ?? []) depLists.add(id);
        return termEntries(
          current.terms.filter((t) => ids === null || ids.has(TERM_REF_RE.exec(t)?.[1] ?? "")),
          field,
        );
      }
      case "term_pages": {
        depTree = true;
        if (terms.length === 0) return EMPTY_LIST;
        const sorted = [...terms].sort();
        const key = JSON.stringify([null, sorted, null]);
        if (!depQueries.has(key))
          depQueries.set(key, { pageType: null, terms: sorted, parent: null });
        const hits = s.pageList
          .filter(
            (p) =>
              p.inBuild &&
              sameVariant(p) &&
              p.id !== pageId &&
              terms.some((t) => p.terms.includes(t)),
          )
          .sort(byTitle);
        return listValue(pageEntries(hits.slice(0, LIST_QUERY_MAX_LIMIT)));
      }
    }
  };

  const pluginEntries = (name: string): ScopeValue => {
    const entries = opts.pluginSources?.[name];
    if (entries === undefined) {
      const owner = s.dormant[name] ?? "unknown";
      return { kind: "failed", marker: `list-source-unavailable:${name} plugin=${owner}` };
    }
    return listValue(
      entries.map((e, index) => {
        const pos = { index, count: entries.length, depth: 1 };
        return {
          id: e.id,
          itemAttr: null,
          childrenKey: null,
          depth: 1,
          get: (key: string) => {
            if (key === "id") return text(e.id);
            if (Object.hasOwn(e.values, key)) return untypedValue(e.values[key]) ?? EMPTY_TEXT;
            return positionValue(key, pos);
          },
        };
      }),
    );
  };

  /** Merge a source's query defaults with the knobs an entry / placement may set. */
  const mergedQuery = (
    source: Extract<SourceDef, { kind: "query" }>,
    overrides: unknown,
    field: string,
    path: string,
  ): PageQuery | { marker: string } => {
    const merged: Record<string, unknown> = { ...source.defaults };
    if (overrides !== undefined && overrides !== null) {
      if (typeof overrides !== "object" || Array.isArray(overrides)) {
        return { marker: `list-malformed:${field}[${path}]` };
      }
      for (const [k, v] of Object.entries(overrides)) {
        if (!(source.editable as readonly string[]).includes(k as QueryKnob)) {
          return { marker: `list-malformed:${field}[${path}.${k}]` };
        }
        merged[k] = v;
      }
    }
    const parsed = pageQuerySchema.safeParse(merged);
    return parsed.success ? parsed.data : { marker: `list-malformed:${field}[${path}]` };
  };

  /** Generated entries of a source node (`{{#items}}`). */
  const sourceItems = (
    source: SourceDef,
    item: ListItem,
    node: NodeDef,
    field: string,
  ): ScopeValue => {
    switch (source.kind) {
      case "query": {
        const q = mergedQuery(source, item.query, field, `${item.id}.query`);
        return "marker" in q ? { kind: "failed", marker: q.marker } : runQuery(q);
      }
      case "system": {
        const termFields = node.fields.filter((f) => f.type === "term");
        const terms = termFields.flatMap((f) => {
          const v = item.values[f.name];
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        });
        const vocabSlugs = termFields.map((f) => (f.type === "term" ? f.list : ""));
        const vocabIds =
          vocabSlugs.length === 0
            ? null
            : [...data.lists.values()].filter((l) => vocabSlugs.includes(l.slug)).map((l) => l.id);
        return systemSource(source.name, terms, vocabIds, field);
      }
      case "plugin":
        return pluginEntries(source.name);
    }
  };

  const fromValue = (v: ScopeValue): ListFieldResolution =>
    v.kind === "failed"
      ? { ok: false, marker: v.marker }
      : { ok: true, entries: v.kind === "list" ? v.entries : [] };

  const resolveField = (
    field: ListFieldSpec,
    value: unknown,
    holder: ListHolder,
  ): ListFieldResolution => {
    const bind = field.bind ?? "local";
    if (bind === "source") {
      const source = field.source;
      if (!source) return { ok: false, marker: `list-malformed:${field.name}[source]` };
      switch (source.kind) {
        case "query": {
          const q = mergedQuery(source, value, field.name, "query");
          return "marker" in q ? { ok: false, marker: q.marker } : fromValue(runQuery(q));
        }
        case "system": {
          const overrides = (value ?? {}) as { terms?: unknown };
          const terms = Array.isArray(overrides.terms)
            ? overrides.terms.filter((t): t is string => typeof t === "string")
            : [];
          const vocab = field.list === undefined ? null : parseListRef(field.list);
          return fromValue(
            systemSource(source.name, terms, vocab === null ? null : [vocab], field.name),
          );
        }
        case "plugin":
          return fromValue(pluginEntries(source.name));
      }
    }
    const typeRow = data.listTypes.get(field.listType);
    if (!typeRow) return { ok: false, marker: `list-type-missing:${field.listType}` };
    depTypes.add(field.listType);
    const type = typeRow.def;
    if (bind === "shared") {
      const raw = field.list ?? (typeof value === "string" ? value : undefined) ?? field.default;
      if (raw === undefined || raw === null || raw === "") {
        return { ok: false, marker: `list-unbound:${field.name}` };
      }
      const listId = typeof raw === "string" ? parseListRef(raw) : null;
      if (listId === null) return { ok: false, marker: `list-malformed:${field.name}[list]` };
      depLists.add(listId);
      const list = data.lists.get(listId);
      if (!list) return { ok: false, marker: `list-missing:${listId}` };
      if (list.typeSlug !== field.listType) {
        return { ok: false, marker: `list-malformed:${field.name}[listType]` };
      }
      const checked = checkTree(type, list.items, field.name);
      if (!checked.ok) return checked;
      return {
        ok: true,
        entries: entriesOf(checked.items, sharedTree(list, type, field.name, false), 1),
      };
    }
    const raw = value === undefined || value === null ? field.default : value;
    if (raw === undefined || raw === null) return { ok: true, entries: [] };
    const checked = checkTree(type, raw, field.name);
    if (!checked.ok) return checked;
    const ci = holder.contentInstanceId;
    const local: TreeCtx = {
      type,
      field: field.name,
      attrPrefix: ci === null ? `local/${field.name}/` : `instance/${ci}/${field.name}/`,
      overlayValues: (itemId) =>
        ci === null ? undefined : overlay?.instanceValues.get(`${ci}/${field.name}/${itemId}`),
      hidden: (itemId) =>
        ci !== null && (overlay?.instanceHidden.has(`${ci}/${field.name}/${itemId}`) ?? false),
      checkOverlay: (item, f, v) => {
        const address = `instance/${ci}/${field.name}/item/${item.id}/${f.name}`;
        const problem = overlayValueProblem(f, v, address);
        if (problem && variant !== null && !pageIssues.some((i) => i.address === address)) {
          pageIssues.push({ variant, address, reason: problem });
        }
        return problem === null;
      },
      termLink: false,
    };
    if (ci !== null && overlay) {
      // Instance overlay addresses naming an entry or field this list
      // does not have can only be found here, where the stored entries
      // are known.
      const ids = new Set<string>();
      const fieldsByItem = new Map<string, NodeDef>();
      const go = (items: readonly ListItem[]): void => {
        for (const it of items) {
          ids.add(it.id);
          fieldsByItem.set(it.id, type.nodes[it.node] as NodeDef);
          if (it.children) go(it.children);
        }
      };
      go(checked.items);
      const prefix = `${ci}/${field.name}/`;
      for (const [key, values] of overlay.instanceValues) {
        if (!key.startsWith(prefix) || variant === null) continue;
        const itemId = key.slice(prefix.length);
        const node = fieldsByItem.get(itemId);
        for (const f of values.keys()) {
          const address = `instance/${ci}/${field.name}/item/${itemId}/${f}`;
          if (!node?.fields.some((x) => x.name === f)) {
            if (!pageIssues.some((i) => i.address === address)) {
              pageIssues.push({
                variant,
                address,
                reason: node ? "the entry's node declares no such field" : "no such list entry",
              });
            }
          }
        }
      }
    }
    return { ok: true, entries: entriesOf(checked.items, local, 1) };
  };

  let pageScopeMemo: ScopeValue | null | undefined;
  return {
    pageId,
    resolveField,
    pageScope: () => {
      if (pageScopeMemo === undefined) {
        if (current === null) pageScopeMemo = null;
        else {
          const get = pageValue(current);
          pageScopeMemo = { kind: "record", text: null, present: true, get };
        }
      }
      return pageScopeMemo;
    },
    pluginSource: (name) => {
      if (opts.pluginSources?.[name] === undefined && s.dormant[name] === undefined) return null;
      return fromValue(pluginEntries(name));
    },
    deps: () => ({
      lists: [...depLists].sort(),
      listTypes: [...depTypes].sort(),
      queries: [...depQueries.values()],
      pageTree: depTree,
    }),
    overlayIssues: () => [...renderIssues, ...pageIssues],
  };
}

function normaliseUrl(url: string): string {
  const cut = url.split(/[?#]/, 1)[0] ?? url;
  return cut.length > 1 && cut.endsWith("/") ? cut.slice(0, -1) : cut;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order of a query. Pages without the sort key sort last; ties break by id (deterministic). */
function pageOrder(
  order: PageQuery["order"],
  collator: Intl.Collator,
): (a: ListPageRecord, b: ListPageRecord) => number {
  const nullsLast = <T>(
    a: T | null | undefined,
    b: T | null | undefined,
    cmp: (x: T, y: T) => number,
  ): number => {
    const an = a === null || a === undefined;
    const bn = b === null || b === undefined;
    if (an || bn) return an === bn ? 0 : an ? 1 : -1;
    return cmp(a as T, b as T);
  };
  const cmpValue = (x: unknown, y: unknown): number => {
    if (typeof x === "number" && typeof y === "number") return x - y;
    return collator.compare(String(x), String(y));
  };
  switch (order) {
    case "published_desc":
      return (a, b) =>
        nullsLast(a.firstPublishedAt, b.firstPublishedAt, (x, y) => compareIds(y, x)) ||
        compareIds(b.updatedAt, a.updatedAt) ||
        compareIds(a.id, b.id);
    case "published_asc":
      return (a, b) =>
        nullsLast(a.firstPublishedAt, b.firstPublishedAt, compareIds) ||
        compareIds(a.updatedAt, b.updatedAt) ||
        compareIds(a.id, b.id);
    case "title_asc":
      return (a, b) => collator.compare(a.title, b.title) || compareIds(a.id, b.id);
    default: {
      const desc = order.startsWith("prop_desc:");
      const prop = order.slice(order.indexOf(":") + 1);
      return (a, b) =>
        nullsLast(a.properties[prop], b.properties[prop], (x, y) =>
          desc ? cmpValue(y, x) : cmpValue(x, y),
        ) || compareIds(a.id, b.id);
    }
  }
}

/** Every embedded module a set of shared lists references (`module` fields), for batch loading. */
export function collectListModuleRefs(
  data: Pick<ListRenderData, "lists" | "listTypes">,
): { moduleId: string; contentInstanceId: string }[] {
  const out: { moduleId: string; contentInstanceId: string }[] = [];
  for (const list of data.lists.values()) {
    const type = data.listTypes.get(list.typeSlug)?.def;
    if (!type) continue;
    const go = (items: readonly ListItem[]): void => {
      for (const it of items) {
        for (const f of type.nodes[it.node]?.fields ?? []) {
          if (f.type !== "module") continue;
          const v = it.values[f.name] as
            | { moduleId?: unknown; contentInstanceId?: unknown }
            | undefined;
          if (typeof v?.moduleId === "string" && typeof v.contentInstanceId === "string") {
            out.push({ moduleId: v.moduleId, contentInstanceId: v.contentInstanceId });
          }
        }
        if (it.children) go(it.children);
      }
    };
    go(list.items);
  }
  return out;
}
