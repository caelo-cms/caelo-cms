// SPDX-License-Identifier: MPL-2.0

/**
 * #1748 — the write-time walks of the core value structure rule
 * (`core-value-structure.ts`): which values a write would store that break
 * the markup where a module's HTML places them, with the path of each in
 * what the write stored. The admin's write paths refuse them
 * (admin-core `ops/content/value-structure.ts`).
 */

import { type CoreValueProblem, coreValueProblemAt } from "./core-value-structure.js";
import type { ListItem } from "./lists/items.js";
import { stripCdataGuards } from "./strip-cdata.js";
import {
  contextValueTags,
  type ModuleValueTag,
  moduleValueTags,
  sectionValueTags,
} from "./template-sections.js";

/** A stored value that breaks the markup where a module places it. */
export interface StoredValueProblem {
  /** Where the value is in what the write stored (`["title"]`, `["nav", 2, "values", "label"]`). */
  readonly path: readonly (string | number)[];
  /** The value's name in the caller's terms (`title`, `label` of entry 2 of `nav`). */
  readonly where: string;
  readonly problem: CoreValueProblem;
}

/** The string a value renders as at a `{{name}}` (`path` `href`/`title` of a link), or null. */
function renderedString(value: unknown, key: "" | "href" | "title"): string | null {
  if (key === "" && typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = (value as Record<string, unknown>)[key === "" ? "href" : key];
  return typeof v === "string" ? v : null;
}

/** The first problem `value` has at any of `tags`, or null. */
function firstProblem(html: string, tags: readonly ModuleValueTag[], value: string) {
  for (const t of tags) {
    const problem = coreValueProblemAt(html, t.start, value);
    if (problem !== null) return problem;
  }
  return null;
}

/** Tags by the name they read (`label`; `link` and `link.href` both read a link's href). */
function tagsByName(tags: readonly ModuleValueTag[]): Map<string, ModuleValueTag[]> {
  const out = new Map<string, ModuleValueTag[]>();
  for (const t of tags) out.set(t.name, [...(out.get(t.name) ?? []), t]);
  return out;
}

/**
 * #1748 — the entries of a list (local or shared) that break the markup
 * where module `html` renders them: the value tags of every
 * `{{#field}}…{{/field}}` section, the entries' children included. An
 * entry `previous` holds with the same value is not this write's doing and
 * passes (a Stage still reports it).
 *
 * @param at the path of the list's entries in what the write stored.
 * @param label the list in the caller's terms (default: `list "<field>"`).
 */
export function listEntryValueProblems(
  moduleHtml: string,
  field: string,
  items: readonly ListItem[],
  at: readonly (string | number)[],
  previous?: readonly ListItem[],
  label = `list "${field}"`,
): StoredValueProblem[] {
  // Read as the engine reads it (template-engine.ts unwraps CDATA guards first).
  const html = stripCdataGuards(moduleHtml);
  const tags = tagsByName(sectionValueTags(html, field));
  if (tags.size === 0) return [];
  const before = new Map<string, ListItem>();
  const index = (list: readonly ListItem[] | undefined) => {
    for (const item of list ?? []) {
      before.set(item.id, item);
      index(item.children);
    }
  };
  index(previous);
  const out: StoredValueProblem[] = [];
  const visit = (list: readonly ListItem[], path: readonly (string | number)[]) => {
    for (const [i, item] of list.entries()) {
      const old = before.get(item.id);
      for (const [key, value] of Object.entries(item.values ?? {})) {
        if (old !== undefined && JSON.stringify(old.values?.[key]) === JSON.stringify(value))
          continue;
        const k = key.toLowerCase();
        for (const [name, part] of [
          [k, ""],
          [`${k}.href`, "href"],
          [`${k}.title`, "title"],
        ] as const) {
          const at = tags.get(name);
          const text = at ? renderedString(value, part) : null;
          const problem = at && text !== null ? firstProblem(html, at, text) : null;
          if (problem === null) continue;
          out.push({
            path: [...path, i, "values", key],
            where: `"${key}" of entry ${item.id} of ${label}`,
            problem,
          });
          break;
        }
      }
      if (item.children) visit(item.children, [...path, i, "children"]);
    }
  };
  visit(items, at);
  return out;
}

/**
 * #1748 — the values of a module's fields (a content instance's values, or
 * the fields' defaults) that break the markup where its HTML places them:
 * a field's value at every `{{field}}` outside list entries, a local
 * list's entries at the tags of its section. A list value that names a
 * shared list (`caelo:list/<id>`) is that list's to check. A value
 * `previous` holds unchanged passes (see {@link listEntryValueProblems}).
 */
export function moduleValueProblems(
  moduleHtml: string,
  fields: readonly { readonly name: string; readonly kind?: string }[],
  values: Readonly<Record<string, unknown>>,
  previous?: Readonly<Record<string, unknown>>,
): StoredValueProblem[] {
  const html = stripCdataGuards(moduleHtml);
  const kinds = new Map(fields.map((f) => [f.name.toLowerCase(), { kind: f.kind ?? "text" }]));
  const byName = tagsByName(moduleValueTags(html, kinds, true));
  const out: StoredValueProblem[] = [];
  for (const [key, value] of Object.entries(values)) {
    const was = previous?.[key];
    if (Array.isArray(value)) {
      if (kinds.get(key.toLowerCase())?.kind !== "list") continue;
      const items = value.filter(isListItem);
      const old = Array.isArray(was) ? was.filter(isListItem) : undefined;
      out.push(...listEntryValueProblems(moduleHtml, key, items, [key], old));
      continue;
    }
    if (previous !== undefined && JSON.stringify(was) === JSON.stringify(value)) continue;
    const k = key.toLowerCase();
    for (const [name, part] of [
      [k, ""],
      [`${k}.href`, "href"],
      [`${k}.title`, "title"],
    ] as const) {
      const tags = byName.get(name);
      const text = tags ? renderedString(value, part) : null;
      const problem = tags && text !== null ? firstProblem(html, tags, text) : null;
      if (problem === null) continue;
      out.push({ path: part === "" ? [key] : [key, part], where: `field "${key}"`, problem });
      break;
    }
  }
  return out;
}

/**
 * #1748 — the site texts (`key` → text) that break the markup where
 * module `html` reads them with `{{site_text.<key>}}`.
 */
export function siteTextValueProblems(
  moduleHtml: string,
  texts: ReadonlyMap<string, string>,
): { readonly key: string; readonly problem: CoreValueProblem }[] {
  const html = stripCdataGuards(moduleHtml);
  const out: { key: string; problem: CoreValueProblem }[] = [];
  const seen = new Set<string>();
  for (const t of contextValueTags(html, "site_text")) {
    const key = t.name.slice("site_text.".length);
    const text = texts.get(key);
    if (text === undefined || seen.has(key)) continue;
    const problem = coreValueProblemAt(html, t.start, text);
    if (problem === null) continue;
    seen.add(key);
    out.push({ key, problem });
  }
  return out;
}

function isListItem(v: unknown): v is ListItem {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { values?: unknown }).values === "object"
  );
}
