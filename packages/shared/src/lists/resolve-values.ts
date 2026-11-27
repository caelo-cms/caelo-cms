// SPDX-License-Identifier: MPL-2.0

/**
 * Field values as template scopes (epic #1107, `docs/lists.md` §2): how
 * a stored value of each field type reads in a template. Shared by list
 * entries, page properties (`{{page.props.x}}`, `{{props.x}}` on query
 * results) and plugin source entries, so every value renders the same
 * way wherever it comes from.
 *
 * Internal references stay references here (`caelo:page/<id>`,
 * `caelo:media/<id>`): the template engine resolves every reference in
 * the finished HTML through the page's link resolver, so a link inside a
 * list entry follows a page move exactly like a link in module HTML.
 */

import { parseLinkRef } from "../link-refs.js";
import type { FieldDef } from "./fields.js";
import {
  type PluginValueOrigin,
  pluginValueOf,
  refusedPluginValueMarker,
} from "./plugin-values.js";
import type { ListRenderData } from "./render-data.js";
import type { ScopeEntry, ScopeValue } from "./scope.js";

export const EMPTY_TEXT: ScopeValue = { kind: "text", text: "" };
export const FALSE: ScopeValue = { kind: "bool", value: false };
export const TRUE: ScopeValue = { kind: "bool", value: true };
export const EMPTY_LIST: ScopeValue = { kind: "list", entries: [] };

/** A text scope value; `plugin` when a plugin supplied it. */
export function text(s: string, plugin?: PluginValueOrigin): ScopeValue {
  return plugin ? { kind: "text", text: s, plugin } : { kind: "text", text: s };
}

/** A boolean scope value. */
export function bool(v: boolean): ScopeValue {
  return v ? TRUE : FALSE;
}

/** A record scope value over a fixed key map; `plugin` when a plugin supplied the bare value. */
export function record(
  bare: string | null,
  present: boolean,
  parts: Readonly<Record<string, ScopeValue>>,
  plugin?: PluginValueOrigin,
): ScopeValue {
  return {
    kind: "record",
    text: bare,
    present,
    ...(plugin ? { plugin } : {}),
    get: (key) => (Object.hasOwn(parts, key) ? parts[key] : undefined),
  };
}

/** `raw` without its plugin wrapper (`pluginValue`), for code that reads a value rather than renders it. */
export function plainValue(raw: unknown): unknown {
  const owned = pluginValueOf(raw);
  return owned ? owned.value : raw;
}

/** What value scopes need from the render: data plus lazy hooks into the page context. */
export interface ValueEnv {
  readonly data: ListRenderData;
  /** Format an ISO date in the site language (cached formatter). */
  formatDate(iso: string): string;
  /**
   * Resolve term references to vocabulary entries. `field` names the
   * field for markers; the vocabulary lists are recorded as deps.
   */
  termEntries(refs: readonly string[], field: string): ScopeValue;
  /**
   * #1754 — resolve a `page` field's references to page-shaped entries,
   * in stored order. `field` names the field for markers; the pages are
   * recorded as deps.
   */
  pageRefEntries(refs: readonly string[], field: string): ScopeValue;
}

/** The empty value of a declared field — declared-but-unset never falls through to outer scopes. */
export function emptyValueOf(field: FieldDef): ScopeValue {
  switch (field.type) {
    case "boolean":
      return FALSE;
    case "link":
      return linkValue({ href: "" }, null);
    case "media":
      return record("", false, {
        url: EMPTY_TEXT,
        alt: EMPTY_TEXT,
        width: EMPTY_TEXT,
        height: EMPTY_TEXT,
      });
    case "date":
      return record("", false, { formatted: EMPTY_TEXT });
    case "term":
    case "page":
      return EMPTY_LIST;
    default:
      return EMPTY_TEXT;
  }
}

/** The dot paths of a link value ({@link linkValue}): `{{f.href}}`, `{{f.target}}`, `{{f.title}}`. */
export const LINK_VALUE_KEYS = ["href", "target", "title"] as const;

/**
 * A module `link` field's stored value (a URL string or `{ href, target? }`)
 * as a link; no value reads as an empty href. Null for anything else: a
 * shape the field cannot render, which the engine reports.
 */
export function parseLinkFieldValue(
  raw: unknown,
): { readonly href: string; readonly target?: string } | null {
  if (raw === undefined || raw === null) return { href: "" };
  if (typeof raw === "string") return { href: raw };
  if (typeof raw !== "object") return null;
  const { href, target } = raw as { href?: unknown; target?: unknown };
  if (typeof href !== "string") return null;
  return typeof target === "string" ? { href, target } : { href };
}

/**
 * Scope value of a link: bare = href, plus `href`, `target`, `title`
 * (internal page title). With `plugin`, the parts the plugin supplied
 * (href, target) carry it; the title is the site's own.
 */
export function linkValue(
  v: { readonly href: string; readonly target?: string },
  data: ListRenderData | null,
  plugin?: PluginValueOrigin,
): ScopeValue {
  const ref = v.href.length > 0 ? parseLinkRef(v.href) : null;
  const title =
    ref?.kind === "page" && data !== null ? (data.pages.get(ref.pageId)?.title ?? "") : "";
  return record(
    v.href,
    v.href.length > 0,
    {
      href: text(v.href, plugin),
      target: text(v.target ?? "", plugin),
      title: text(title),
    },
    plugin,
  );
}

/**
 * Scope value of a media reference: bare = url (the reference, resolved
 * later), alt/width/height. With `plugin`, the reference carries it; the
 * library's alt and size are the site's own.
 */
export function mediaValue(
  ref: string,
  data: ListRenderData,
  plugin?: PluginValueOrigin,
): ScopeValue {
  const parsed = parseLinkRef(ref);
  const meta = parsed?.kind === "media" ? data.media.get(parsed.mediaId) : undefined;
  return record(
    ref,
    ref.length > 0,
    {
      url: text(ref, plugin),
      alt: text(meta?.alt ?? ""),
      width: text(meta?.width === null || meta?.width === undefined ? "" : String(meta.width)),
      height: text(meta?.height === null || meta?.height === undefined ? "" : String(meta.height)),
    },
    plugin,
  );
}

/** Scope value of a date or timestamp: bare = the stored ISO string, `formatted` in the site language. */
export function dateValue(
  iso: string,
  env: Pick<ValueEnv, "formatDate">,
  plugin?: PluginValueOrigin,
): ScopeValue {
  return record(iso, iso.length > 0, { formatted: text(env.formatDate(iso), plugin) }, plugin);
}

/**
 * Scope value of one stored field value. `undefined` / `null` read as the
 * field's empty value; a value of the wrong shape (data drift after a
 * type change that skipped validation) reads as the raw string form when
 * it has one — validation happens on write, rendering never invents data.
 */
export function fieldValue(field: FieldDef, stored: unknown, env: ValueEnv): ScopeValue {
  if (stored === undefined || stored === null) return emptyValueOf(field);
  // #1729 — a plugin value the host refused (§4.5) stays raw and fails.
  const refused = refusedPluginValueMarker(stored);
  if (refused !== null) return { kind: "failed", marker: refused };
  // A plugin's value keeps its origin, so the engine checks it where it lands.
  const owned = pluginValueOf(stored);
  const raw = owned ? owned.value : stored;
  const plugin = owned?.origin;
  if (raw === undefined || raw === null) return emptyValueOf(field);
  switch (field.type) {
    case "text":
    case "richtext":
    case "icon":
    case "select":
      return typeof raw === "string" ? text(raw, plugin) : text(String(raw), plugin);
    case "number":
      return text(String(raw), plugin);
    case "boolean":
      return plugin ? { kind: "bool", value: raw === true, plugin } : bool(raw === true);
    case "link": {
      if (typeof raw === "object" && typeof (raw as { href?: unknown }).href === "string") {
        return linkValue(raw as { href: string; target?: string }, env.data, plugin);
      }
      return typeof raw === "string"
        ? linkValue({ href: raw }, env.data, plugin)
        : emptyValueOf(field);
    }
    case "media":
      return typeof raw === "string" ? mediaValue(raw, env.data, plugin) : emptyValueOf(field);
    case "date":
      return typeof raw === "string" ? dateValue(raw, env, plugin) : emptyValueOf(field);
    case "module": {
      const r = raw as { moduleId?: unknown; contentInstanceId?: unknown };
      if (typeof r.moduleId === "string" && typeof r.contentInstanceId === "string") {
        return {
          kind: "module",
          ref: { moduleId: r.moduleId, contentInstanceId: r.contentInstanceId },
        };
      }
      return { kind: "failed", marker: `list-malformed:${field.name}[module]` };
    }
    case "term":
      return Array.isArray(raw)
        ? env.termEntries(
            raw.filter((x): x is string => typeof x === "string"),
            field.name,
          )
        : EMPTY_LIST;
    case "page":
      return Array.isArray(raw)
        ? env.pageRefEntries(
            raw.filter((x): x is string => typeof x === "string"),
            field.name,
          )
        : EMPTY_LIST;
  }
}

/**
 * Lookup for a `select` field's option flag: `{{#f_<option>}}` is true
 * when `f` holds `<option>`. Returns undefined when `key` is no option
 * flag of any select field.
 */
export function selectFlag(
  fields: readonly FieldDef[],
  values: Readonly<Record<string, unknown>>,
  key: string,
): ScopeValue | undefined {
  for (const f of fields) {
    if (f.type !== "select" || !key.startsWith(`${f.name}_`)) continue;
    const option = key.slice(f.name.length + 1);
    if (f.options.includes(option)) return bool(plainValue(values[f.name]) === option);
  }
  return undefined;
}

/**
 * Generic scope of an untyped value map (plugin source entries, whose
 * node definition the host does not hand over yet): strings and numbers
 * as text, booleans as flags, `{ href }` objects as links.
 */
export function untypedValue(stored: unknown): ScopeValue | undefined {
  const owned = pluginValueOf(stored);
  const raw = owned ? owned.value : stored;
  const plugin = owned?.origin;
  if (typeof raw === "string") return text(raw, plugin);
  if (typeof raw === "number" && Number.isFinite(raw)) return text(String(raw), plugin);
  if (typeof raw === "boolean") return plugin ? { kind: "bool", value: raw, plugin } : bool(raw);
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { href?: unknown }).href === "string"
  ) {
    return linkValue(raw as { href: string; target?: string }, null, plugin);
  }
  return undefined;
}

/** Position keys every entry carries: `index` (0-based), `first`, `last`, `depth` (1-based). */
export function positionValue(
  key: string,
  pos: { readonly index: number; readonly count: number; readonly depth: number },
): ScopeValue | undefined {
  switch (key) {
    case "index":
      return text(String(pos.index));
    case "first":
      return bool(pos.index === 0);
    case "last":
      return bool(pos.index === pos.count - 1);
    case "depth":
      return text(String(pos.depth));
    default:
      return undefined;
  }
}

/** A list of entries as a scope value, with `has_`/`count_` helpers derived by the caller. */
export function listValue(entries: readonly ScopeEntry[]): ScopeValue {
  return { kind: "list", entries };
}
