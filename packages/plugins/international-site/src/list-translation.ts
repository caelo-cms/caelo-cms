// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G — translating LISTS, the pure half.
 *
 * Core has no locale concept (epic #380). It gives this plugin neutral
 * hooks (docs/lists.md §9): every stored value has an ADDRESS
 * (`list/<listId>/item/<itemId>/<field>`,
 * `instance/<ciId>/<field>/item/<itemId>/<itemField>`,
 * `page/<pageId>/props/<field>`), a field may carry this plugin's
 * attribute `ext["international-site"].translate`, and the `list-resolve`
 * composition point applies an OVERLAY per output variant — values by
 * address, hidden entries — that this plugin computes from its own
 * storage. An overlay never adds, removes or reorders entries: the
 * structure is the site's, the plugin only supplies the language.
 *
 * What is translated (a "unit"):
 *   - shared lists (menus, footer links, categories, tags): every entry's
 *     translatable fields. Vocabulary entries' `name` and `slug` are
 *     terms (stored in `term_translations`, slug unique per locale);
 *   - local lists inside content instances (a module's `list` field):
 *     the same, for the languages of the pages the instance is placed on;
 *   - page properties of a language version of a page: the source page's
 *     value is the source text.
 * A field is translatable when it is text or rich text and its attribute
 * does not say `translate: false` (text and rich text default to true —
 * the plugin's default suggestion; the AI sets the attribute in the same
 * type upsert when a field should stay as it is, e.g. a SKU).
 *
 * Change handling (the README's table), computed from the current source
 * and the stored rows — the same on every render, so a chat's preview,
 * the build and the worker agree:
 *   - added entry / translate switched on → `missing`; an entry whose
 *     REQUIRED translatable field is missing is hidden in that language
 *     (never shown in the source language); a missing optional field
 *     renders empty;
 *   - source text changed → `needs_update`; the old translation stays
 *     visible until it is redone;
 *   - moved → nothing (addresses do not change);
 *   - removed entry / deleted list / dropped field → `orphaned`, kept (an
 *     undo restores it) and garbage-collected once a production build
 *     after the removal succeeded;
 *   - translate switched off → the translation is kept but not applied;
 *   - a link to a page without a version in that language → the entry is
 *     hidden there, and a finding names it;
 *   - query / system source nodes store nothing: core already scopes
 *     queries by variant; only a source node's own fields (a heading)
 *     are units.
 */

import type { FieldDef, ListItem, ListTypeDef } from "@caelo-cms/plugin-sdk";

/** This plugin's slug: the key of its attributes under `ext`. */
export const PLUGIN_SLUG = "international-site";

/** Field types whose value is language: the only ones a translation replaces. */
export const TRANSLATABLE_FIELD_TYPES: ReadonlySet<string> = new Set(["text", "richtext"]);

/**
 * The plugin's `listExt` declaration: one boolean per field. Core
 * validates `ext["international-site"]` against it and never reads it.
 */
export const LIST_EXT_FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    translate: {
      type: "boolean",
      description:
        "Whether this field's value differs per language. Text and rich text default to true; set false for values that stay the same in every language (SKUs, codes, brand names).",
    },
  },
} as const;

/** A field's `translate` attribute as stored, or undefined. */
export function translateAttribute(field: FieldDef): boolean | undefined {
  const ext = field.ext?.[PLUGIN_SLUG] as { translate?: unknown } | undefined;
  return typeof ext?.translate === "boolean" ? ext.translate : undefined;
}

/** True when the field's value is translated per language. */
export function isTranslatableField(field: FieldDef): boolean {
  return TRANSLATABLE_FIELD_TYPES.has(field.type) && (translateAttribute(field) ?? true);
}

/** Change detector of a source text (djb2 — not a security boundary). */
export function textHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `djb2:${(h >>> 0).toString(16)}:${text.length}`;
}

/** Where a unit's translation is stored. */
export type UnitStore = "value" | "term" | "pageProp";

/** One translatable source value. */
export interface SourceUnit {
  /** The value address (also the key of the overlay and of the work item path). */
  readonly address: string;
  /** The entry the value belongs to (hidden as a whole), null for a page property. */
  readonly entry: string | null;
  /** The group it is offered in (one per list / local list / page). */
  readonly target: string;
  readonly store: UnitStore;
  readonly text: string;
  /** Change detector the stored translation is compared with. */
  readonly hash: string;
  readonly required: boolean;
  readonly field: FieldDef;
  /** Languages the unit is translated into; null = every non-default language. */
  readonly locales: ReadonlySet<string> | null;
  /** term units: the vocabulary list and entry. */
  readonly term?: {
    readonly listId: string;
    readonly itemId: string;
    readonly part: "name" | "slug";
  };
  /** pageProp units: the language version and the property. */
  readonly pageProp?: { readonly pageId: string; readonly field: string };
}

/** One stored entry, for hiding and link checks. */
export interface SourceEntry {
  readonly address: string;
  readonly target: string;
  /** Link hrefs of the entry's link fields, as read (references or paths). */
  readonly links: readonly string[];
  readonly label: string;
  readonly locales: ReadonlySet<string> | null;
}

/** A group of units the translator and the operator see together. */
export interface SourceTarget {
  readonly key: string;
  readonly label: string;
}

/** Everything translatable in the site's lists, as one value. */
export interface ListSourceSnapshot {
  readonly units: readonly SourceUnit[];
  readonly entries: readonly SourceEntry[];
  readonly targets: ReadonlyMap<string, SourceTarget>;
  /** Every stored value address (translatable or not) — tells "gone" from "not translated". */
  readonly existing: ReadonlySet<string>;
}

/** A shared list as the plugin reads it (`lists.list` with items). */
export interface SourceList {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly type: string;
  readonly items: readonly ListItem[];
}

/** A content instance holding local lists. */
export interface SourceInstance {
  readonly id: string;
  readonly label: string;
  /** The module's local list fields with their list type slug and default. */
  readonly listFields: readonly { name: string; listType: string; default?: unknown }[];
  readonly values: Readonly<Record<string, unknown>>;
  /** Non-default languages of the pages the instance is placed on. */
  readonly locales: ReadonlySet<string>;
}

/** A language version of a page whose properties are translated. */
export interface SourcePageProps {
  readonly pageId: string;
  readonly label: string;
  readonly locale: string;
  readonly properties: readonly FieldDef[];
  /** The group's source page's values (the text to translate). */
  readonly source: Readonly<Record<string, unknown>>;
}

/** Inputs of {@link collectSources}. */
export interface SourceInput {
  readonly listTypes: ReadonlyMap<string, ListTypeDef>;
  readonly lists: readonly SourceList[];
  readonly instances: readonly SourceInstance[];
  readonly pageProps: readonly SourcePageProps[];
}

function hrefOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { href?: unknown }).href === "string") {
    return (v as { href: string }).href;
  }
  return null;
}

function entryLabel(item: ListItem, node: { fields: readonly FieldDef[] } | undefined): string {
  for (const f of node?.fields ?? []) {
    const v = item.values[f.name];
    if (TRANSLATABLE_FIELD_TYPES.has(f.type) && typeof v === "string" && v.trim() !== "") {
      return v.length > 60 ? `${v.slice(0, 57)}…` : v;
    }
  }
  return item.id;
}

/**
 * Walk one entry tree and collect its units and entries.
 *
 * @param valueAddress address of one field of one entry.
 * @param entryAddress address of one entry.
 */
function walkTree(
  type: ListTypeDef,
  items: readonly ListItem[],
  ctx: {
    readonly target: string;
    readonly locales: ReadonlySet<string> | null;
    readonly valueAddress: (itemId: string, field: string) => string;
    readonly entryAddress: (itemId: string) => string;
    readonly vocabularyListId: string | null;
  },
  out: { units: SourceUnit[]; entries: SourceEntry[]; existing: Set<string> },
): void {
  for (const item of items) {
    const node = type.nodes[item.node];
    const entry = ctx.entryAddress(item.id);
    const links: string[] = [];
    for (const f of node?.fields ?? []) {
      const address = ctx.valueAddress(item.id, f.name);
      const v = item.values[f.name];
      if (v !== undefined && v !== null) out.existing.add(address);
      if (f.type === "link") {
        const href = hrefOf(v);
        if (href) links.push(href);
        continue;
      }
      if (!isTranslatableField(f) || typeof v !== "string" || v.trim() === "") continue;
      const part = ctx.vocabularyListId !== null && (f.name === "name" || f.name === "slug");
      out.units.push({
        address,
        entry,
        target: ctx.target,
        store: part ? "term" : "value",
        text: v,
        hash: textHash(v),
        required: f.required === true,
        field: f,
        locales: ctx.locales,
        ...(part && ctx.vocabularyListId !== null
          ? {
              term: {
                listId: ctx.vocabularyListId,
                itemId: item.id,
                part: f.name as "name" | "slug",
              },
            }
          : {}),
      });
    }
    out.entries.push({
      address: entry,
      target: ctx.target,
      links,
      label: entryLabel(item, node),
      locales: ctx.locales,
    });
    if (item.children) walkTree(type, item.children, ctx, out);
  }
}

/**
 * Everything translatable, from the source state. Throws when a list
 * names a type the site does not have — translating against a guessed
 * shape would write translations for fields that do not exist.
 */
export function collectSources(input: SourceInput): ListSourceSnapshot {
  const out = {
    units: [] as SourceUnit[],
    entries: [] as SourceEntry[],
    existing: new Set<string>(),
  };
  const targets = new Map<string, SourceTarget>();
  for (const list of input.lists) {
    const type = input.listTypes.get(list.type);
    if (!type) {
      throw new Error(
        `international-site: list "${list.slug}" has type "${list.type}", which list_types.list does not return`,
      );
    }
    const key = `list:${list.id}`;
    targets.set(key, { key, label: `${type.name} "${list.name}" (list ${list.slug})` });
    walkTree(
      type,
      list.items,
      {
        target: key,
        locales: null,
        valueAddress: (itemId, field) => `list/${list.id}/item/${itemId}/${field}`,
        entryAddress: (itemId) => `list/${list.id}/item/${itemId}`,
        vocabularyListId: type.role === "vocabulary" ? list.id : null,
      },
      out,
    );
  }
  for (const ci of input.instances) {
    if (ci.locales.size === 0) continue;
    for (const lf of ci.listFields) {
      const type = input.listTypes.get(lf.listType);
      if (!type) {
        throw new Error(
          `international-site: content "${ci.label}" field "${lf.name}" uses list type "${lf.listType}", which list_types.list does not return`,
        );
      }
      const raw = ci.values[lf.name] ?? lf.default;
      if (!Array.isArray(raw)) continue;
      const key = `instance:${ci.id}:${lf.name}`;
      targets.set(key, { key, label: `${ci.label}, list "${lf.name}"` });
      walkTree(
        type,
        raw as ListItem[],
        {
          target: key,
          locales: ci.locales,
          valueAddress: (itemId, field) => `instance/${ci.id}/${lf.name}/item/${itemId}/${field}`,
          entryAddress: (itemId) => `instance/${ci.id}/${lf.name}/item/${itemId}`,
          vocabularyListId: null,
        },
        out,
      );
    }
  }
  for (const p of input.pageProps) {
    const key = `page:${p.pageId}`;
    let any = false;
    for (const f of p.properties) {
      const address = `page/${p.pageId}/props/${f.name}`;
      const v = p.source[f.name];
      if (v !== undefined && v !== null) out.existing.add(address);
      if (!isTranslatableField(f) || typeof v !== "string" || v.trim() === "") continue;
      any = true;
      out.units.push({
        address,
        entry: null,
        target: key,
        store: "pageProp",
        text: v,
        hash: textHash(v),
        required: f.required === true,
        field: f,
        locales: new Set([p.locale]),
        pageProp: { pageId: p.pageId, field: f.name },
      });
    }
    if (any) targets.set(key, { key, label: `page properties of ${p.label}` });
  }
  // A term's name and slug are stored together and checked against one
  // change detector, so a changed name re-offers the slug too.
  const termParts = new Map<string, SourceUnit[]>();
  for (const u of out.units) {
    if (!u.term) continue;
    const k = `${u.term.listId}/${u.term.itemId}`;
    termParts.set(k, [...(termParts.get(k) ?? []), u]);
  }
  const units = out.units.map((u) => {
    if (!u.term) return u;
    const parts = termParts.get(`${u.term.listId}/${u.term.itemId}`) ?? [u];
    const combined = parts
      .map((p) => `${p.term?.part}=${p.text}`)
      .sort()
      .join("\n");
    return { ...u, hash: textHash(combined) };
  });
  return { units, entries: out.entries, targets, existing: out.existing };
}

/** True when a unit / entry is translated into `locale`. */
export function appliesTo(
  x: { readonly locales: ReadonlySet<string> | null },
  locale: string,
): boolean {
  return x.locales === null || x.locales.has(locale);
}

/** A stored translation, as the index holds it. */
export interface StoredTranslation {
  readonly value: string | null;
  readonly hash: string | null;
}

/** Stored translations keyed `<locale>|<address>`. */
export type TranslationIndex = ReadonlyMap<string, StoredTranslation>;

/** Index key of a translation. */
export function indexKey(locale: string, address: string): string {
  return `${locale}|${address}`;
}

/** What a language has for one unit. */
export type UnitStatus = "translated" | "needs_update" | "missing";

/** The status of `unit` in `locale`, from the stored row (or its absence). */
export function unitStatus(unit: SourceUnit, locale: string, index: TranslationIndex): UnitStatus {
  const row = index.get(indexKey(locale, unit.address));
  if (!row || row.value === null) return "missing";
  return row.hash === unit.hash ? "translated" : "needs_update";
}

/** The `list-resolve` answer for one language (plain JSON). */
export interface LocaleOverlay {
  readonly values: Record<string, unknown>;
  readonly hidden: string[];
}

/**
 * The overlay of one language: translations by address, entries hidden
 * because a required field is not translated, because a link points at
 * a page without a version in the language, or because the operator hid
 * them there.
 *
 * @param linkHasVersion whether an entry's link resolves in `locale`
 *   (internal page links need a version of the target; external ones
 *   always pass).
 * @param hiddenByOperator entry addresses hidden in `locale`.
 */
export function overlayFor(
  snapshot: ListSourceSnapshot,
  locale: string,
  index: TranslationIndex,
  linkHasVersion: (href: string) => boolean,
  hiddenByOperator: ReadonlySet<string>,
): LocaleOverlay {
  const values: Record<string, unknown> = {};
  const hidden = new Set<string>();
  for (const u of snapshot.units) {
    if (!appliesTo(u, locale)) continue;
    const status = unitStatus(u, locale, index);
    if (status !== "missing") {
      values[u.address] = index.get(indexKey(locale, u.address))?.value ?? "";
      continue;
    }
    // A page cannot be hidden by a list overlay; a missing property
    // renders as stored and is reported as a finding.
    if (u.store === "pageProp" || u.entry === null) continue;
    if (u.required) hidden.add(u.entry);
    else values[u.address] = "";
  }
  for (const e of snapshot.entries) {
    if (!appliesTo(e, locale)) continue;
    if (hiddenByOperator.has(e.address)) hidden.add(e.address);
    else if (e.links.some((h) => !linkHasVersion(h))) hidden.add(e.address);
  }
  return { values, hidden: [...hidden].sort() };
}

/** One problem a language has with lists — a Stage-audit finding. */
export interface ListTranslationFinding {
  readonly code: "list-translation-missing" | "list-link-variant-missing" | "page-property-missing";
  readonly severity: "warning";
  readonly localeCode: string;
  readonly target: string;
  readonly address: string;
  readonly message: string;
  readonly nextStep: string;
}

/**
 * What blocks a language from showing its lists completely: untranslated
 * texts (grouped per list) and entries hidden because their link has no
 * version in the language.
 */
export function findingsFor(
  snapshot: ListSourceSnapshot,
  locale: { readonly code: string; readonly display_name: string },
  index: TranslationIndex,
  linkHasVersion: (href: string) => boolean,
  hiddenByOperator: ReadonlySet<string>,
): ListTranslationFinding[] {
  const out: ListTranslationFinding[] = [];
  const missingByTarget = new Map<string, SourceUnit[]>();
  for (const u of snapshot.units) {
    if (!appliesTo(u, locale.code)) continue;
    if (u.entry !== null && hiddenByOperator.has(u.entry)) continue;
    if (unitStatus(u, locale.code, index) !== "missing") continue;
    missingByTarget.set(u.target, [...(missingByTarget.get(u.target) ?? []), u]);
  }
  for (const [target, units] of missingByTarget) {
    const label = snapshot.targets.get(target)?.label ?? target;
    const isPage = units[0]?.store === "pageProp";
    out.push({
      code: isPage ? "page-property-missing" : "list-translation-missing",
      severity: "warning",
      localeCode: locale.code,
      target,
      address: units[0]?.address ?? target,
      message: `translation missing in ${locale.display_name} (${locale.code}): ${label} — ${units.length} text${units.length === 1 ? "" : "s"}${isPage ? "" : "; entries whose required text is missing are hidden on that language's pages"}.`,
      nextStep: `translate_chrome({ localeCode: "${locale.code}" }) translates it, or apply_translations with kind "addresses" writes given texts.`,
    });
  }
  for (const e of snapshot.entries) {
    if (!appliesTo(e, locale.code) || hiddenByOperator.has(e.address)) continue;
    const bad = e.links.find((h) => !linkHasVersion(h));
    if (bad === undefined) continue;
    const label = snapshot.targets.get(e.target)?.label ?? e.target;
    out.push({
      code: "list-link-variant-missing",
      severity: "warning",
      localeCode: locale.code,
      target: e.target,
      address: e.address,
      message: `link target has no ${locale.display_name} (${locale.code}) version: entry "${e.label}" in ${label} links ${bad}, so the entry is hidden on ${locale.code} pages.`,
      nextStep: `create_variant for the linked page in ${locale.code}, or set_list_item_visibility({ items: [{ localeCode: "${locale.code}", address: "${e.address}", hidden: true }] }) to hide it there on purpose.`,
    });
  }
  return out;
}

/** Per target and language: counts of each status, for intl_status. */
export function statusSummary(
  snapshot: ListSourceSnapshot,
  locales: readonly string[],
  index: TranslationIndex,
): { target: string; label: string; locales: Record<string, Record<UnitStatus, number>> }[] {
  const out = new Map<string, Record<string, Record<UnitStatus, number>>>();
  for (const u of snapshot.units) {
    for (const l of locales) {
      if (!appliesTo(u, l)) continue;
      const perTarget = out.get(u.target) ?? {};
      const counts = perTarget[l] ?? { translated: 0, needs_update: 0, missing: 0 };
      counts[unitStatus(u, l, index)] += 1;
      perTarget[l] = counts;
      out.set(u.target, perTarget);
    }
  }
  return [...out.entries()].map(([target, perLocale]) => ({
    target,
    label: snapshot.targets.get(target)?.label ?? target,
    locales: perLocale,
  }));
}

/** A stored row as reconciliation sees it. */
export interface ReconcileRow {
  readonly id: string;
  readonly locale: string;
  readonly address: string;
  readonly hasValue: boolean;
  readonly hash: string | null;
  readonly status: "translated" | "needs_update" | "missing" | "orphaned";
  readonly orphanedAt: string | null;
}

/** A status change reconciliation decided. */
export interface ReconcileUpdate {
  readonly id: string;
  readonly status: ReconcileRow["status"];
  /** Set when the row becomes orphaned; null clears it (restored). */
  readonly orphanedAt: string | null;
}

/**
 * Bring stored statuses in line with the source (the worker's half; the
 * render computes the same from hashes). A row whose address is gone is
 * `orphaned` (kept; an undo restores it); one whose address still exists
 * but is no longer translatable (translate off) is left as it is.
 *
 * @returns the rows to update and the `missing` rows to insert.
 */
export function reconcile(
  snapshot: ListSourceSnapshot,
  locales: readonly string[],
  rows: readonly ReconcileRow[],
  now: string,
): { updates: ReconcileUpdate[]; inserts: { locale: string; unit: SourceUnit }[] } {
  const unitByAddress = new Map(snapshot.units.map((u) => [u.address, u]));
  const updates: ReconcileUpdate[] = [];
  const have = new Set<string>();
  for (const r of rows) {
    have.add(indexKey(r.locale, r.address));
    const unit = unitByAddress.get(r.address);
    let next: ReconcileRow["status"] = r.status;
    if (!snapshot.existing.has(r.address)) next = "orphaned";
    else if (unit && appliesTo(unit, r.locale)) {
      next = !r.hasValue ? "missing" : r.hash === unit.hash ? "translated" : "needs_update";
    } else if (r.status === "orphaned") {
      // Back (an undo), but not translatable now: keep it, not orphaned.
      next = r.hasValue ? "needs_update" : "missing";
    }
    const orphanedAt = next === "orphaned" ? (r.orphanedAt ?? now) : null;
    if (next !== r.status || orphanedAt !== r.orphanedAt) {
      updates.push({ id: r.id, status: next, orphanedAt });
    }
  }
  const inserts: { locale: string; unit: SourceUnit }[] = [];
  for (const u of snapshot.units) {
    for (const l of locales) {
      if (!appliesTo(u, l) || have.has(indexKey(l, u.address))) continue;
      // A term's two parts share one row: insert it once.
      if (
        u.term &&
        u.term.part === "slug" &&
        unitByAddress.has(u.address.replace(/\/slug$/, "/name"))
      ) {
        continue;
      }
      have.add(indexKey(l, u.address));
      inserts.push({ locale: l, unit: u });
    }
  }
  return { updates, inserts };
}
