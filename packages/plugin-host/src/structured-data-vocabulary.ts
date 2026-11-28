// SPDX-License-Identifier: MPL-2.0

/**
 * #1753 — the check of one structured-data answer against the vocabulary
 * (plugin SDK `structured-data.ts`), for every plugin, shipped or
 * installed. Pure: the caller resolves the page and media ids the accepted
 * parts name and builds the JSON (structured-data.ts).
 *
 * Every part outside the vocabulary is refused with the rule it broke, and
 * the rest of the answer stands: one bad property does not take a page's
 * other nodes with it. A page whose answer is over its size or node cap
 * gets none of it, because a cut answer would claim a graph the plugin did
 * not mean. A refusal is never silent: the caller records it as a render
 * failure.
 */

import {
  CORE_NODE_REFS,
  type CoreNodeRef,
  NODE_FRAGMENT_RE,
  RESERVED_NODE_FRAGMENTS,
  STRUCTURED_DATA_ARRAY_MAX,
  STRUCTURED_DATA_INLINE_DEPTH,
  STRUCTURED_DATA_NODES_PER_PAGE,
  STRUCTURED_DATA_PAGE_MAX_BYTES,
  STRUCTURED_DATA_PROPERTIES_PER_NODE,
  STRUCTURED_DATA_TEXT_MAX,
  WEB_PAGE_PROPERTIES,
  WEB_PAGE_TYPES,
} from "@caelo-cms/plugin-sdk";
import { isSchemaOrgType } from "@caelo-cms/shared";

/** One refused part: the page, the part (a property name, `node`, `answer`) and the rule. */
export interface StructuredDataRefusal {
  readonly pageId: string;
  readonly field: string;
  readonly rule: string;
}

/** A reference after the check: a core node, or a node of a page. */
export type CheckedRef =
  | { readonly core: CoreNodeRef }
  | { readonly page: string | null; readonly fragment: string };

/** One checked scalar value, kept typed until its ids are resolved. */
export type CheckedScalar =
  | { readonly k: "text"; readonly v: string }
  | { readonly k: "number"; readonly v: number }
  | { readonly k: "bool"; readonly v: boolean }
  | { readonly k: "date"; readonly v: string }
  | { readonly k: "duration"; readonly v: string }
  | { readonly k: "live"; readonly v: "published" | "modified" }
  | { readonly k: "page"; readonly id: string }
  | { readonly k: "media"; readonly id: string }
  | { readonly k: "url"; readonly v: string }
  | { readonly k: "schema"; readonly v: string }
  | { readonly k: "ref"; readonly ref: CheckedRef }
  | {
      readonly k: "node";
      readonly types: readonly string[];
      readonly props: ReadonlyMap<string, CheckedValue>;
    };

/** A checked property value: one scalar or a list of them. */
export type CheckedValue = CheckedScalar | { readonly k: "list"; readonly items: CheckedScalar[] };

/** A checked node of a page's graph. */
export interface CheckedNode {
  readonly types: readonly string[];
  /** Its id: a fragment of the asked page (`page: null`) or of another page. */
  readonly id: { readonly page: string | null; readonly fragment: string };
  readonly props: ReadonlyMap<string, CheckedValue>;
}

/** What of one page's answer may reach the page. */
export interface CheckedPageAnswer {
  readonly webPageType?: string;
  readonly webPage: ReadonlyMap<string, CheckedValue>;
  readonly nodes: readonly CheckedNode[];
}

/** What of one answer may reach the pages, and what was refused. */
export interface CheckedStructuredDataAnswer {
  readonly pages: ReadonlyMap<string, CheckedPageAnswer>;
  readonly refusals: readonly StructuredDataRefusal[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROPERTY_RE = /^[a-z][A-Za-z0-9]{0,63}$/;
const SCHEMA_TERM_RE = /^[A-Z][A-Za-z0-9]{1,63}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const DURATION_RE =
  /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
/** Markup in a text value: a tag, an end tag, a comment, a declaration. */
const MARKUP_RE = /<[A-Za-z/!?]/;
/** A text value that is an address: an address is a page, media or `{url}` value. */
const TEXT_URL_RE = /^\s*(?:https?:|\/\/|javascript:|data:|vbscript:)/i;
const URL_MAX = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The only key of `value`, or null when it has none or several. */
function soleKey(value: Record<string, unknown>): string | null {
  const keys = Object.keys(value);
  return keys.length === 1 ? (keys[0] as string) : null;
}

/** Whether `y-m-d` names a day of the calendar. */
function isCalendarDay(y: string, m: string, d: string): boolean {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/** The rule a date breaks, or null for `YYYY-MM-DD` or an ISO date-time with its offset. */
function dateRule(raw: unknown): string | null {
  if (typeof raw !== "string") return "date-format";
  const m = DATE_RE.exec(raw) ?? DATE_TIME_RE.exec(raw);
  if (!m) return "date-format";
  return isCalendarDay(m[1] as string, m[2] as string, m[3] as string) ? null : "date-format";
}

/** The types of a node: one schema.org type, or up to three. */
function typesOf(raw: unknown): { types: string[] } | { rule: string } {
  if (raw === undefined) return { rule: "type-missing" };
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0 || list.length > 3) return { rule: "type-shape" };
  const types: string[] = [];
  for (const t of list) {
    if (typeof t !== "string" || !isSchemaOrgType(t)) return { rule: "type-unknown" };
    if (!types.includes(t)) types.push(t);
  }
  return { types };
}

/** A node id or reference target: a fragment, of the asked page or of another page. */
function nodeTarget(
  raw: unknown,
):
  | { page: string | null; fragment: string }
  | { rule: "fragment-invalid" | "page-id-invalid" | "id-shape" } {
  if (!isRecord(raw)) return { rule: "id-shape" };
  const keys = Object.keys(raw);
  if (keys.some((k) => k !== "page" && k !== "fragment")) return { rule: "id-shape" };
  if (typeof raw.fragment !== "string" || !NODE_FRAGMENT_RE.test(raw.fragment)) {
    return { rule: "fragment-invalid" };
  }
  if (raw.page === undefined) return { page: null, fragment: raw.fragment };
  if (typeof raw.page !== "string" || !UUID_RE.test(raw.page)) return { rule: "page-id-invalid" };
  return { page: raw.page.toLowerCase(), fragment: raw.fragment };
}

/** Check one scalar; `depth` is how many `{node}` values it already sits in. */
function checkScalar(raw: unknown, depth: number): CheckedScalar | { rule: string } {
  if (typeof raw === "string") {
    if (raw.length > STRUCTURED_DATA_TEXT_MAX) return { rule: "text-too-long" };
    if (MARKUP_RE.test(raw)) return { rule: "text-markup" };
    if (TEXT_URL_RE.test(raw)) return { rule: "text-url" };
    return { k: "text", v: raw };
  }
  if (typeof raw === "number")
    return Number.isFinite(raw) ? { k: "number", v: raw } : { rule: "number-not-finite" };
  if (typeof raw === "boolean") return { k: "bool", v: raw };
  if (Array.isArray(raw)) return { rule: "array-nested" };
  if (!isRecord(raw)) return { rule: "value-shape" };
  const key = soleKey(raw);
  const v = key === null ? undefined : raw[key];
  switch (key) {
    case "date": {
      const rule = dateRule(v);
      return rule ? { rule } : { k: "date", v: v as string };
    }
    case "duration":
      return typeof v === "string" && DURATION_RE.test(v)
        ? { k: "duration", v }
        : { rule: "duration-format" };
    case "live":
      return v === "published" || v === "modified" ? { k: "live", v } : { rule: "live-unknown" };
    case "page":
      return typeof v === "string" && UUID_RE.test(v)
        ? { k: "page", id: v.toLowerCase() }
        : { rule: "page-id-invalid" };
    case "media":
      return typeof v === "string" && UUID_RE.test(v)
        ? { k: "media", id: v.toLowerCase() }
        : { rule: "media-id-invalid" };
    case "url": {
      if (typeof v !== "string" || v.length > URL_MAX) return { rule: "url-invalid" };
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return { rule: "url-invalid" };
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return { rule: "url-scheme" };
      if (url.username !== "" || url.password !== "") return { rule: "url-credentials" };
      return { k: "url", v: url.href };
    }
    case "schema":
      return typeof v === "string" && SCHEMA_TERM_RE.test(v)
        ? { k: "schema", v }
        : { rule: "schema-term" };
    case "ref": {
      if (typeof v === "string") {
        return (CORE_NODE_REFS as readonly string[]).includes(v)
          ? { k: "ref", ref: { core: v as CoreNodeRef } }
          : { rule: "ref-unknown" };
      }
      const target = nodeTarget(v);
      return "rule" in target
        ? { rule: target.rule === "id-shape" ? "ref-unknown" : target.rule }
        : { k: "ref", ref: target };
    }
    case "node": {
      if (depth >= STRUCTURED_DATA_INLINE_DEPTH) return { rule: "inline-too-deep" };
      if (!isRecord(v) || Object.keys(v).some((k) => k !== "type" && k !== "properties")) {
        return { rule: "node-shape" };
      }
      const types = typesOf(v.type);
      if ("rule" in types) return types;
      const props = checkProperties(v.properties, depth + 1);
      return "rule" in props ? props : { k: "node", types: types.types, props: props.props };
    }
    default:
      return { rule: "value-shape" };
  }
}

/** Check one property value: a scalar or an array of them. */
function checkValue(raw: unknown, depth: number): CheckedValue | { rule: string } {
  if (!Array.isArray(raw)) return checkScalar(raw, depth);
  if (raw.length > STRUCTURED_DATA_ARRAY_MAX) return { rule: "array-too-long" };
  const items: CheckedScalar[] = [];
  for (const entry of raw) {
    const checked = checkScalar(entry, depth);
    if ("rule" in checked) return checked;
    items.push(checked);
  }
  return { k: "list", items };
}

/**
 * Check a property's value. `{live: "modified"}` is the page's modified
 * date, which the build re-dates in the written graph as the string value
 * of a `dateModified` (`setArticleModifiedTime`), so it may only stand as
 * the one value of a `dateModified`: under another name, or in a list, it
 * would ship undated.
 */
function checkNamed(name: string, raw: unknown, depth: number): CheckedValue | { rule: string } {
  const checked = checkValue(raw, depth);
  if ("rule" in checked) return checked;
  const liveModified = (v: CheckedScalar) => v.k === "live" && v.v === "modified";
  const misplaced =
    checked.k === "list"
      ? checked.items.some(liveModified)
      : name !== "dateModified" && liveModified(checked);
  return misplaced ? { rule: "live-modified-property" } : checked;
}

/**
 * The properties of a nested node, all or nothing: a nested node with a
 * bad property is refused whole, so a half address never reaches a page.
 */
function checkProperties(
  raw: unknown,
  depth: number,
): { props: Map<string, CheckedValue> } | { rule: string } {
  if (!isRecord(raw)) return { rule: "properties-shape" };
  const entries = Object.entries(raw);
  if (entries.length > STRUCTURED_DATA_PROPERTIES_PER_NODE)
    return { rule: "properties-over-limit" };
  const props = new Map<string, CheckedValue>();
  for (const [name, value] of entries) {
    if (!PROPERTY_RE.test(name)) return { rule: "property-name" };
    const checked = checkNamed(name, value, depth);
    if ("rule" in checked) return checked;
    props.set(name, checked);
  }
  return { props };
}

/** A property name as a refusal names it (`plugin-value-refused:<plugin>.structured-data.<field>:<rule>`). */
function fieldName(name: string): string {
  return PROPERTY_RE.test(name) ? name : "property";
}

/**
 * Check one plugin's answer for the pages it was asked about.
 *
 * @param asked the pages of this call. An answer for any other page is
 *   refused on every asked page (`answer.page-not-asked`): the plugin's
 *   answer to this call cannot be trusted to be about these pages.
 */
export function checkStructuredDataAnswer(
  raw: unknown,
  asked: ReadonlySet<string>,
): CheckedStructuredDataAnswer {
  const pages = new Map<string, CheckedPageAnswer>();
  const refusals: StructuredDataRefusal[] = [];
  const refuse = (pageId: string, field: string, rule: string) =>
    refusals.push({ pageId, field, rule });

  if (!isRecord(raw) || soleKey(raw) !== "pages" || !isRecord(raw.pages)) {
    for (const pageId of asked) refuse(pageId, "answer", "answer-shape");
    return { pages, refusals };
  }
  const answered = Object.entries(raw.pages);
  if (answered.some(([pageId]) => !asked.has(pageId))) {
    for (const pageId of asked) refuse(pageId, "answer", "page-not-asked");
    return { pages, refusals };
  }

  for (const [pageId, rawPage] of answered) {
    if (!isRecord(rawPage) || Object.keys(rawPage).some((k) => k !== "webPage" && k !== "nodes")) {
      refuse(pageId, "page", "page-shape");
      continue;
    }
    if (Buffer.byteLength(JSON.stringify(rawPage)) > STRUCTURED_DATA_PAGE_MAX_BYTES) {
      refuse(pageId, "page", "page-too-large");
      continue;
    }
    const rawNodes = rawPage.nodes ?? [];
    if (!Array.isArray(rawNodes)) {
      refuse(pageId, "page", "nodes-shape");
      continue;
    }
    if (rawNodes.length > STRUCTURED_DATA_NODES_PER_PAGE) {
      refuse(pageId, "page", "nodes-over-limit");
      continue;
    }

    let webPageType: string | undefined;
    const webPage = new Map<string, CheckedValue>();
    if (rawPage.webPage !== undefined) {
      const wp = rawPage.webPage;
      if (!isRecord(wp) || Object.keys(wp).some((k) => k !== "type" && k !== "properties")) {
        refuse(pageId, "webpage", "webpage-shape");
      } else {
        if (wp.type !== undefined) {
          if (
            typeof wp.type === "string" &&
            (WEB_PAGE_TYPES as readonly string[]).includes(wp.type)
          ) {
            webPageType = wp.type;
          } else refuse(pageId, "webpage", "type-not-webpage");
        }
        if (wp.properties !== undefined && !isRecord(wp.properties)) {
          refuse(pageId, "webpage", "properties-shape");
        }
        for (const [name, value] of Object.entries(isRecord(wp.properties) ? wp.properties : {})) {
          if (!(WEB_PAGE_PROPERTIES as readonly string[]).includes(name)) {
            refuse(pageId, fieldName(name), "property-not-allowed");
            continue;
          }
          const checked = checkNamed(name, value, 0);
          if ("rule" in checked) refuse(pageId, name, checked.rule);
          else webPage.set(name, checked);
        }
      }
    }

    const nodes: CheckedNode[] = [];
    const ids = new Set<string>();
    for (const rawNode of rawNodes) {
      if (
        !isRecord(rawNode) ||
        Object.keys(rawNode).some((k) => k !== "type" && k !== "id" && k !== "properties")
      ) {
        refuse(pageId, "node", "node-shape");
        continue;
      }
      const types = typesOf(rawNode.type);
      if ("rule" in types) {
        refuse(pageId, "type", types.rule);
        continue;
      }
      if (rawNode.id === undefined) {
        refuse(pageId, "id", "id-missing");
        continue;
      }
      const id = nodeTarget(rawNode.id);
      if ("rule" in id) {
        refuse(pageId, "id", id.rule);
        continue;
      }
      if (RESERVED_NODE_FRAGMENTS.includes(id.fragment)) {
        refuse(pageId, "id", "id-reserved");
        continue;
      }
      const key = `${id.page ?? ""}#${id.fragment}`;
      if (ids.has(key)) {
        refuse(pageId, "id", "id-taken");
        continue;
      }
      if (!isRecord(rawNode.properties)) {
        refuse(pageId, "node", "properties-shape");
        continue;
      }
      const entries = Object.entries(rawNode.properties);
      if (entries.length > STRUCTURED_DATA_PROPERTIES_PER_NODE) {
        refuse(pageId, "node", "properties-over-limit");
        continue;
      }
      const props = new Map<string, CheckedValue>();
      for (const [name, value] of entries) {
        if (!PROPERTY_RE.test(name)) {
          refuse(pageId, "property", "property-name");
          continue;
        }
        const checked = checkNamed(name, value, 0);
        if ("rule" in checked) refuse(pageId, name, checked.rule);
        else props.set(name, checked);
      }
      ids.add(key);
      nodes.push({ types: types.types, id, props });
    }
    if (webPageType !== undefined || webPage.size > 0 || nodes.length > 0) {
      pages.set(pageId, { ...(webPageType ? { webPageType } : {}), webPage, nodes });
    }
  }
  return { pages, refusals };
}

/** Every page id a checked value names (a `{page}` value or a reference to another page's node). */
export function pagesNamedBy(value: CheckedValue, out: Set<string>): void {
  if (value.k === "list") {
    for (const item of value.items) pagesNamedBy(item, out);
    return;
  }
  if (value.k === "page") out.add(value.id);
  else if (value.k === "ref" && "fragment" in value.ref && value.ref.page !== null)
    out.add(value.ref.page);
  else if (value.k === "node") for (const v of value.props.values()) pagesNamedBy(v, out);
}

/** Every media id a checked value names. */
export function mediaNamedBy(value: CheckedValue, out: Set<string>): void {
  if (value.k === "list") {
    for (const item of value.items) mediaNamedBy(item, out);
    return;
  }
  if (value.k === "media") out.add(value.id);
  else if (value.k === "node") for (const v of value.props.values()) mediaNamedBy(v, out);
}
