// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G — translating LISTS, the I/O half: reading the
 * source through core's named `lists` / content / page ops (never a
 * table — CLAUDE.md §2 data zones), this plugin's branch-aware storage,
 * the `list-resolve` answer, the writes behind translate_chrome /
 * apply_translations / set_list_item_visibility, and the worker's
 * reconciliation and garbage collection. The model is in
 * ./list-translation.ts.
 *
 * Storage (private, `plugin_international_site`, branch-aware #508 — a
 * write from a chat lands on the chat's branch and reaches live with
 * the chat's Stage):
 *   list_value_translations  (locale_code, address, value, source_hash, status, orphaned_at)
 *   term_translations        (locale_code, list_id, item_id, name, slug, source_hash, status, orphaned_at)
 *   page_prop_translations   (locale_code, page_id, field, value, source_hash, status, orphaned_at)
 *   list_item_visibility     (locale_code, address, hidden)
 */

import {
  type ListItem,
  type ListTypeDef,
  type PageTypeDef,
  validateFieldValue,
  z,
} from "@caelo-cms/plugin-sdk";
import type { ChromeDeps } from "./chrome-ops.js";
import type { LocaleRow, PageVariantRow } from "./index.js";
import {
  appliesTo,
  collectSources,
  findingsFor,
  indexKey,
  type ListSourceSnapshot,
  type ListTranslationFinding,
  type LocaleOverlay,
  overlayFor,
  type ReconcileRow,
  reconcile,
  type SourceInstance,
  type SourcePageProps,
  type SourceUnit,
  type StoredTranslation,
  statusSummary,
  type TranslationIndex,
  unitStatus,
} from "./list-translation.js";

/** A stored list value translation. */
export interface ValueTranslationRow {
  id: string;
  locale_code: string;
  address: string;
  value: string | null;
  source_hash: string | null;
  status: "translated" | "needs_update" | "missing" | "orphaned";
  orphaned_at: string | null;
}

/** A stored vocabulary entry translation (name + slug, slug unique per locale and list). */
export interface TermTranslationRow {
  id: string;
  locale_code: string;
  list_id: string;
  item_id: string;
  name: string | null;
  slug: string | null;
  source_hash: string | null;
  status: ValueTranslationRow["status"];
  orphaned_at: string | null;
}

/** A stored page property translation. */
export interface PagePropTranslationRow {
  id: string;
  locale_code: string;
  page_id: string;
  field: string;
  value: string | null;
  source_hash: string | null;
  status: ValueTranslationRow["status"];
  orphaned_at: string | null;
}

/** An entry hidden in one language by the operator. */
export interface VisibilityRow {
  id: string;
  locale_code: string;
  address: string;
  hidden: boolean;
}

/** Page fields the list translation reads (`pages.list`). */
interface PageInfo {
  id: string;
  title: string;
  currentPath: string;
  pageType: string;
  properties: Record<string, unknown>;
}

/** Everything a list translation decision is made from, loaded once. */
export interface ListTranslationState {
  readonly snapshot: ListSourceSnapshot;
  readonly index: TranslationIndex;
  readonly hiddenByOperator: ReadonlyMap<string, ReadonlySet<string>>;
  readonly values: readonly ValueTranslationRow[];
  readonly terms: readonly TermTranslationRow[];
  readonly props: readonly PagePropTranslationRow[];
  readonly visibility: readonly VisibilityRow[];
  /** Whether `href` (as read) resolves to a page that has a version in `locale`. */
  readonly linkHasVersion: (href: string, locale: string) => boolean;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_REF_RE = new RegExp(`^caelo:page/(${UUID})`);

/**
 * Read every row of a private table, past the store's 1000-row read: the
 * store pages by `orderBy` + a `since`-free cursor is not offered, so the
 * plugin refuses beyond one read rather than plan with half the rows.
 */
async function readAll<T>(deps: ChromeDeps, table: string): Promise<T[]> {
  const rows = await deps.q.list(table, { limit: 1000 });
  if (rows.length >= 1000) {
    throw new Error(
      `international-site: ${table} holds 1000+ rows, more than one read returns; paged reads are not implemented yet (file an issue)`,
    );
  }
  return rows as unknown as T[];
}

/** A stored timestamp as an ISO string (the store may hand back a Date). */
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalisePath(href: string): string {
  const bare = href.split(/[?#]/)[0] ?? href;
  return bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
}

/**
 * Load the source state and the stored translations as the caller sees
 * them (a chat sees its branch's lists, instance values and its own
 * translation rows; pages-to-instance placement and page variants are
 * main-line data).
 */
export async function loadListTranslationState(deps: ChromeDeps): Promise<ListTranslationState> {
  const { cms } = deps;
  const def = [...deps.locales.values()].find((l) => l.is_default) ?? null;
  const nonDefault = [...deps.locales.values()].filter((l) => !l.is_default).map((l) => l.code);

  const [types, lists, modules, instances, shared, pages, pageTypes] = await Promise.all([
    cms.call<{ listTypes: { slug: string; definition: ListTypeDef }[] }>("list_types.list", {}),
    cms.call<{
      lists: { id: string; slug: string; name: string; type: string; items?: ListItem[] }[];
    }>("lists.list", { includeItems: true }),
    cms.call<{ modules: { id: string; displayName: string; fields: unknown[] }[] }>(
      "modules.list",
      {},
    ),
    cms.call<{
      instances: {
        id: string;
        moduleId: string;
        moduleDisplayName: string;
        slug: string | null;
        displayName: string | null;
        values: Record<string, unknown>;
      }[];
    }>("content_instances.list", {}),
    cms.call<{ listInstances: { contentInstanceId: string; pageIds: string[] }[] }>(
      "pages.list_shared_content",
      {},
    ),
    cms.call<{ pages: PageInfo[] }>("pages.list", {}),
    cms.call<{ pageTypes: { slug: string; definition: PageTypeDef }[] }>("page_types.list", {}),
  ]);
  const listTypes = new Map(types.listTypes.map((t) => [t.slug, t.definition]));
  const variants = (await readAll<PageVariantRow>(deps, "page_variants")).filter((v) =>
    deps.locales.has(v.locale_code),
  );
  const variantByPage = new Map(variants.map((v) => [v.page_id, v]));
  const localeOfPage = (pageId: string): string | null =>
    variantByPage.get(pageId)?.locale_code ?? def?.code ?? null;
  const pageById = new Map(pages.pages.map((p) => [p.id, p]));
  const pageIdByPath = new Map(pages.pages.map((p) => [normalisePath(p.currentPath), p.id]));
  const groupLocales = new Map<string, Set<string>>();
  for (const v of variants) {
    const set = groupLocales.get(v.group_id) ?? new Set<string>();
    set.add(v.locale_code);
    groupLocales.set(v.group_id, set);
  }

  // Local lists: the instances placed on pages of a non-default language.
  const pagesOfInstance = new Map(
    shared.listInstances.map((r) => [r.contentInstanceId, r.pageIds]),
  );
  const moduleById = new Map(modules.modules.map((m) => [m.id, m]));
  const sourceInstances: SourceInstance[] = [];
  for (const ci of instances.instances) {
    const pageIds = pagesOfInstance.get(ci.id);
    if (!pageIds) continue;
    const locales = new Set(
      pageIds.map(localeOfPage).filter((l): l is string => l !== null && nonDefault.includes(l)),
    );
    if (locales.size === 0) continue;
    const listFields = (moduleById.get(ci.moduleId)?.fields ?? []).flatMap((f) => {
      const o = f as {
        name?: unknown;
        kind?: unknown;
        listType?: unknown;
        bind?: unknown;
        default?: unknown;
      };
      return o.kind === "list" &&
        typeof o.name === "string" &&
        typeof o.listType === "string" &&
        (o.bind === undefined || o.bind === "local")
        ? [{ name: o.name, listType: o.listType, default: o.default }]
        : [];
    });
    if (listFields.length === 0) continue;
    sourceInstances.push({
      id: ci.id,
      label: `${ci.moduleDisplayName}${ci.displayName ? ` "${ci.displayName}"` : ci.slug ? ` "${ci.slug}"` : ""}`,
      listFields,
      values: ci.values,
      locales,
    });
  }

  // Page properties of language versions: the source page's value is the text.
  const typeBySlug = new Map(pageTypes.pageTypes.map((t) => [t.slug, t.definition]));
  const sourceByGroup = new Map(
    variants.filter((v) => v.translation_status === "source").map((v) => [v.group_id, v.page_id]),
  );
  const pageProps: SourcePageProps[] = [];
  for (const v of variants) {
    if (v.translation_status === "source" || !nonDefault.includes(v.locale_code)) continue;
    const page = pageById.get(v.page_id);
    const source = pageById.get(sourceByGroup.get(v.group_id) ?? "");
    const pageType = page ? typeBySlug.get(page.pageType) : undefined;
    if (!page || !source || !pageType || pageType.properties.length === 0) continue;
    pageProps.push({
      pageId: page.id,
      label: `"${page.title}" (${page.currentPath})`,
      locale: v.locale_code,
      properties: pageType.properties,
      source: source.properties,
    });
  }

  const snapshot = collectSources({
    listTypes,
    lists: lists.lists
      .filter((l) => listTypes.has(l.type))
      .map((l) => ({ id: l.id, slug: l.slug, name: l.name, type: l.type, items: l.items ?? [] })),
    instances: sourceInstances,
    pageProps,
  });

  const [values, terms, props, visibility] = await Promise.all([
    readAll<ValueTranslationRow>(deps, "list_value_translations"),
    readAll<TermTranslationRow>(deps, "term_translations"),
    readAll<PagePropTranslationRow>(deps, "page_prop_translations"),
    readAll<VisibilityRow>(deps, "list_item_visibility"),
  ]);
  const index = new Map<string, StoredTranslation>();
  for (const r of values)
    index.set(indexKey(r.locale_code, r.address), { value: r.value, hash: r.source_hash });
  for (const r of terms) {
    const base = `list/${r.list_id}/item/${r.item_id}`;
    index.set(indexKey(r.locale_code, `${base}/name`), { value: r.name, hash: r.source_hash });
    index.set(indexKey(r.locale_code, `${base}/slug`), { value: r.slug, hash: r.source_hash });
  }
  for (const r of props) {
    index.set(indexKey(r.locale_code, `page/${r.page_id}/props/${r.field}`), {
      value: r.value,
      hash: r.source_hash,
    });
  }
  const hiddenByOperator = new Map<string, Set<string>>();
  for (const r of visibility) {
    if (!r.hidden) continue;
    const set = hiddenByOperator.get(r.locale_code) ?? new Set<string>();
    set.add(r.address);
    hiddenByOperator.set(r.locale_code, set);
  }

  const linkHasVersion = (href: string, locale: string): boolean => {
    const ref = PAGE_REF_RE.exec(href);
    const pageId = ref
      ? ref[1]
      : href.startsWith("/")
        ? pageIdByPath.get(normalisePath(href))
        : undefined;
    // Not a page of this site (external URL, mail, anchor): nothing to map.
    if (!pageId) return true;
    if (localeOfPage(pageId) === locale) return true;
    const group = variantByPage.get(pageId)?.group_id;
    return group !== undefined && (groupLocales.get(group)?.has(locale) ?? false);
  };

  return { snapshot, index, hiddenByOperator, values, terms, props, visibility, linkHasVersion };
}

const EMPTY = new Set<string>();

/** The `list-resolve` answer: one overlay per requested non-default language. */
export async function resolveListOverlays(
  deps: ChromeDeps,
  rawArgs: unknown,
): Promise<{ overlays: Record<string, LocaleOverlay> }> {
  const { variants } = z
    .object({ variants: z.array(z.string().min(1).max(64)) })
    .strict()
    .parse(rawArgs);
  const overlays: Record<string, LocaleOverlay> = {};
  const wanted = variants.filter((v) => deps.locales.get(v)?.is_default === false);
  if (wanted.length === 0) return { overlays };
  const state = await loadListTranslationState(deps);
  for (const code of wanted) {
    overlays[code] = overlayFor(
      state.snapshot,
      code,
      state.index,
      (h) => state.linkHasVersion(h, code),
      state.hiddenByOperator.get(code) ?? EMPTY,
    );
  }
  return { overlays };
}

/** The list texts a language still needs, grouped per list / local list / page. */
export function listWorkTargets(
  state: ListTranslationState,
  locale: string,
): { key: string; label: string; units: SourceUnit[] }[] {
  const hidden = state.hiddenByOperator.get(locale) ?? EMPTY;
  const byTarget = new Map<string, SourceUnit[]>();
  for (const u of state.snapshot.units) {
    if (!appliesTo(u, locale)) continue;
    if (u.entry !== null && hidden.has(u.entry)) continue;
    if (unitStatus(u, locale, state.index) === "translated") continue;
    byTarget.set(u.target, [...(byTarget.get(u.target) ?? []), u]);
  }
  // A term is answered as a whole (one stored row, one change detector).
  const unitByAddress = new Map(state.snapshot.units.map((u) => [u.address, u]));
  for (const units of byTarget.values()) {
    for (const u of [...units]) {
      if (!u.term) continue;
      const other = unitByAddress.get(
        u.address.replace(/\/(name|slug)$/, u.term.part === "name" ? "/slug" : "/name"),
      );
      if (other && !units.includes(other)) units.push(other);
    }
  }
  return [...byTarget.entries()].map(([key, units]) => ({
    key,
    label: state.snapshot.targets.get(key)?.label ?? key,
    units,
  }));
}

/** Upsert by the given match columns; returns nothing (rows are re-read on demand). */
async function upsertRow(
  deps: ChromeDeps,
  table: string,
  match: Record<string, unknown>,
  row: Record<string, unknown>,
): Promise<void> {
  const existing = (await deps.q.list(table, { ...match, limit: 2 })) as unknown as {
    id: string;
  }[];
  if (existing.length > 1) {
    throw new Error(
      `international-site: ${table} holds two rows for ${JSON.stringify(match)} — a write race; delete one and retry`,
    );
  }
  if (existing[0]) await deps.q.update(table, existing[0].id, row);
  else await deps.q.insert(table, { ...match, ...row });
}

/** What {@link checkListTranslations} hands the write. */
interface CheckedListTranslations {
  readonly unitByAddress: ReadonlyMap<string, SourceUnit>;
  readonly termWrites: ReadonlyMap<string, { unit: SourceUnit; name?: string; slug?: string }>;
}

/**
 * Check translations by address for one language without writing: every
 * address must be a current unit of that language and every value valid
 * for its field (length, required); a vocabulary slug must stay unique
 * among the list's slugs in that language.
 *
 * @throws one error listing every problem.
 */
export function checkListTranslations(
  state: ListTranslationState,
  locale: LocaleRow,
  answers: ReadonlyMap<string, string>,
): CheckedListTranslations {
  const unitByAddress = new Map(state.snapshot.units.map((u) => [u.address, u]));
  const problems: string[] = [];
  const termWrites = new Map<string, { unit: SourceUnit; name?: string; slug?: string }>();
  for (const [address, value] of answers) {
    const unit = unitByAddress.get(address);
    if (!unit || !appliesTo(unit, locale.code)) {
      problems.push(
        `${address}: not a translatable list value of ${locale.code} (call translate_chrome or intl_status for the current addresses)`,
      );
      continue;
    }
    const bad = validateFieldValue(unit.field, value, address);
    if (bad.length > 0) {
      problems.push(bad.map((b) => `${b.path}: ${b.message}`).join("; "));
      continue;
    }
    if (unit.term) {
      const k = `${unit.term.listId}/${unit.term.itemId}`;
      const w = termWrites.get(k) ?? { unit };
      termWrites.set(k, { ...w, [unit.term.part]: value });
    }
  }
  // Slugs: unique per list and language, among stored and written ones.
  const slugOwner = new Map<string, string>();
  for (const r of state.terms) {
    if (r.locale_code === locale.code && r.slug !== null && r.status !== "orphaned") {
      slugOwner.set(`${r.list_id}|${r.slug}`, r.item_id);
    }
  }
  for (const [k, w] of termWrites) {
    if (w.slug === undefined || !w.unit.term) continue;
    const key = `${w.unit.term.listId}|${w.slug}`;
    const owner = slugOwner.get(key);
    if (owner !== undefined && owner !== w.unit.term.itemId) {
      problems.push(
        `${k}: slug "${w.slug}" is already used by another entry of this list in ${locale.code} — pick another slug`,
      );
    }
    slugOwner.set(key, w.unit.term.itemId);
  }
  if (problems.length > 0) {
    throw new Error(`list translation refused — nothing was written. ${problems.join(" | ")}`);
  }
  return { unitByAddress, termWrites };
}

/**
 * Write translations by address for one language, after
 * {@link checkListTranslations} (run again here, so a caller can never
 * write an unchecked batch).
 *
 * @returns how many values were written.
 */
export async function writeListTranslations(
  deps: ChromeDeps,
  state: ListTranslationState,
  locale: LocaleRow,
  answers: ReadonlyMap<string, string>,
): Promise<number> {
  const { unitByAddress, termWrites } = checkListTranslations(state, locale, answers);
  let written = 0;
  for (const [address, value] of answers) {
    const unit = unitByAddress.get(address) as SourceUnit;
    if (unit.store === "value") {
      await upsertRow(
        deps,
        "list_value_translations",
        { locale_code: locale.code, address },
        { value, source_hash: unit.hash, status: "translated", orphaned_at: null },
      );
      written += 1;
    } else if (unit.store === "pageProp" && unit.pageProp) {
      await upsertRow(
        deps,
        "page_prop_translations",
        { locale_code: locale.code, page_id: unit.pageProp.pageId, field: unit.pageProp.field },
        { value, source_hash: unit.hash, status: "translated", orphaned_at: null },
      );
      written += 1;
    }
  }
  for (const w of termWrites.values()) {
    if (!w.unit.term) continue;
    const stored = state.terms.find(
      (r) =>
        r.locale_code === locale.code &&
        r.list_id === w.unit.term?.listId &&
        r.item_id === w.unit.term?.itemId,
    );
    const name = w.name ?? stored?.name ?? null;
    const slug = w.slug ?? stored?.slug ?? null;
    await upsertRow(
      deps,
      "term_translations",
      { locale_code: locale.code, list_id: w.unit.term.listId, item_id: w.unit.term.itemId },
      {
        name,
        slug,
        source_hash: w.unit.hash,
        status: name !== null && slug !== null ? "translated" : "missing",
        orphaned_at: null,
      },
    );
    written += (w.name !== undefined ? 1 : 0) + (w.slug !== undefined ? 1 : 0);
  }
  return written;
}

const visibilityArgs = z
  .object({
    items: z
      .array(
        z
          .object({
            localeCode: z.string().min(2).max(35),
            /** Entry address: `list/<listId>/item/<itemId>` or `instance/<ciId>/<field>/item/<itemId>`. */
            address: z.string().min(1).max(400),
            hidden: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

/**
 * Hide (or show again) list entries in one language — "the German menu
 * has no Careers link". Hiding is a decision about that language only;
 * the entry stays in every other one. All items are checked first.
 */
export async function setListItemVisibility(
  deps: ChromeDeps,
  rawArgs: unknown,
): Promise<{ updated: { localeCode: string; address: string; hidden: boolean }[] }> {
  const args = visibilityArgs.parse(rawArgs);
  const state = await loadListTranslationState(deps);
  const entryByAddress = new Map(state.snapshot.entries.map((e) => [e.address, e]));
  const problems: string[] = [];
  for (const it of args.items) {
    const locale = deps.locales.get(it.localeCode);
    if (!locale)
      problems.push(`${it.localeCode}: not a registered locale (intl_status lists them)`);
    else if (locale.is_default) {
      problems.push(
        `${it.localeCode} is the default language — remove the entry from the list itself (patch_list_items_many) instead`,
      );
    }
    const entry = entryByAddress.get(it.address);
    if (!entry) {
      problems.push(
        `${it.address}: no such list entry (use the entry address list/<listId>/item/<itemId> from intl_status.lists or get_list)`,
      );
    } else if (!appliesTo(entry, it.localeCode)) {
      problems.push(`${it.address}: this entry does not show on ${it.localeCode} pages`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `set_list_item_visibility refused — nothing was changed. ${problems.join(" | ")}`,
    );
  }
  for (const it of args.items) {
    const existing = state.visibility.find(
      (r) => r.locale_code === it.localeCode && r.address === it.address,
    );
    if (it.hidden) {
      if (existing) await deps.q.update("list_item_visibility", existing.id, { hidden: true });
      else {
        await deps.q.insert("list_item_visibility", {
          locale_code: it.localeCode,
          address: it.address,
          hidden: true,
        });
      }
    } else if (existing) {
      // Shown again = no decision left: the default rules apply.
      await deps.q.delete("list_item_visibility", existing.id);
    }
  }
  return { updated: args.items.map((i) => ({ ...i })) };
}

/** Stage-audit findings of every non-default language. */
export function listFindings(
  deps: ChromeDeps,
  state: ListTranslationState,
): ListTranslationFinding[] {
  return [...deps.locales.values()]
    .filter((l) => !l.is_default)
    .flatMap((l) =>
      findingsFor(
        state.snapshot,
        l,
        state.index,
        (h) => state.linkHasVersion(h, l.code),
        state.hiddenByOperator.get(l.code) ?? EMPTY,
      ),
    );
}

/** Per list / local list / page and language: status counts (intl_status). */
export function listStatus(
  deps: ChromeDeps,
  state: ListTranslationState,
): ReturnType<typeof statusSummary> {
  return statusSummary(
    state.snapshot,
    [...deps.locales.values()].filter((l) => !l.is_default).map((l) => l.code),
    state.index,
  );
}

/**
 * The worker's half: persist the statuses the source implies (added →
 * `missing` rows, changed → `needs_update`, gone → `orphaned`, back →
 * restored) and garbage-collect orphaned rows once a production build
 * that started after the removal succeeded. Runs on the main line.
 *
 * @param lastLiveAt start of the newest succeeded production build, or null.
 * @returns how many rows changed.
 */
export async function reconcileListTranslations(
  deps: ChromeDeps,
  lastLiveAt: string | null,
): Promise<{ updated: number; inserted: number; collected: number }> {
  const state = await loadListTranslationState(deps);
  const locales = [...deps.locales.values()].filter((l) => !l.is_default).map((l) => l.code);
  const rows: (ReconcileRow & { table: string })[] = [
    ...state.values.map((r) => ({
      table: "list_value_translations",
      id: r.id,
      locale: r.locale_code,
      address: r.address,
      hasValue: r.value !== null,
      hash: r.source_hash,
      status: r.status,
      orphanedAt: iso(r.orphaned_at),
    })),
    ...state.terms.map((r) => ({
      table: "term_translations",
      id: r.id,
      locale: r.locale_code,
      address: `list/${r.list_id}/item/${r.item_id}/name`,
      hasValue: r.name !== null && r.slug !== null,
      hash: r.source_hash,
      status: r.status,
      orphanedAt: iso(r.orphaned_at),
    })),
    ...state.props.map((r) => ({
      table: "page_prop_translations",
      id: r.id,
      locale: r.locale_code,
      address: `page/${r.page_id}/props/${r.field}`,
      hasValue: r.value !== null,
      hash: r.source_hash,
      status: r.status,
      orphanedAt: iso(r.orphaned_at),
    })),
  ];
  const tableOf = new Map(rows.map((r) => [r.id, r.table]));
  const now = new Date().toISOString();
  const plan = reconcile(state.snapshot, locales, rows, now);
  const liveAt = lastLiveAt === null ? null : Date.parse(lastLiveAt);
  const isLive = (orphanedAt: string | null): boolean =>
    liveAt !== null && orphanedAt !== null && Date.parse(orphanedAt) < liveAt;
  let collected = 0;
  for (const u of plan.updates) {
    const table = tableOf.get(u.id) as string;
    const row = rows.find((r) => r.id === u.id);
    // Removed AND live: the removal reached production after it happened.
    const orphanedAt = u.orphanedAt ?? row?.orphanedAt ?? null;
    if (u.status === "orphaned" && isLive(orphanedAt)) {
      await deps.q.delete(table, u.id);
      collected += 1;
      continue;
    }
    await deps.q.update(table, u.id, { status: u.status, orphaned_at: u.orphanedAt });
  }
  // Rows already orphaned (no update this round) are collected too.
  if (liveAt !== null) {
    const updated = new Set(plan.updates.map((u) => u.id));
    for (const r of rows) {
      if (updated.has(r.id) || r.status !== "orphaned") continue;
      if (isLive(r.orphanedAt)) {
        await deps.q.delete(r.table, r.id);
        collected += 1;
      }
    }
  }
  for (const ins of plan.inserts) {
    const u = ins.unit;
    if (u.store === "value") {
      await deps.q.insert("list_value_translations", {
        locale_code: ins.locale,
        address: u.address,
        value: null,
        source_hash: null,
        status: "missing",
        orphaned_at: null,
      });
    } else if (u.store === "term" && u.term) {
      await deps.q.insert("term_translations", {
        locale_code: ins.locale,
        list_id: u.term.listId,
        item_id: u.term.itemId,
        name: null,
        slug: null,
        source_hash: null,
        status: "missing",
        orphaned_at: null,
      });
    } else if (u.store === "pageProp" && u.pageProp) {
      await deps.q.insert("page_prop_translations", {
        locale_code: ins.locale,
        page_id: u.pageProp.pageId,
        field: u.pageProp.field,
        value: null,
        source_hash: null,
        status: "missing",
        orphaned_at: null,
      });
    }
  }
  return { updated: plan.updates.length - collected, inserted: plan.inserts.length, collected };
}

/** Start of the newest succeeded production build, or null (deploy.list_runs). */
export async function lastLiveBuildAt(deps: ChromeDeps): Promise<string | null> {
  const r = await deps.cms.call<{
    runs: { env: string; status: string; startedAt: string }[];
  }>("deploy.list_runs", { limit: 50 });
  const live = r.runs.filter((x) => x.env === "production" && x.status === "succeeded");
  return live.length > 0
    ? (live
        .map((x) => x.startedAt)
        .sort()
        .at(-1) ?? null)
    : null;
}
