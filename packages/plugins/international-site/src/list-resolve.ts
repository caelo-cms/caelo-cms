// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G — the `list-resolve` answer: one overlay per asked
 * non-default language (translations by address, hidden entries).
 *
 * Two shapes of the same answer (#1223):
 *   - a build asks without a scope: the whole site's list translation
 *     state (`loadListTranslationState`), read once for every language;
 *   - an editor preview asks for the one page it renders, with core's
 *     `scope` (the shared lists, the content instances whose local lists
 *     render, the pages whose properties render). Only those sources and
 *     their stored translations are read, so the answer costs what the
 *     page costs, not what the site costs. For every address in the scope
 *     it is the whole-site answer, value for value (the overlay of a list,
 *     an instance or a page depends only on that source, its stored rows
 *     and the variants of the pages its links point at).
 *
 * The page variants come through the render pass's shared reads
 * (`VariantReads`, index.ts): a preview's `link_resolve` already read the
 * rows of every page it renders, so the scoped answer re-reads none of
 * them.
 */

import {
  type ListItem,
  type ListResolveScope,
  listResolveArgs,
  type PageTypeDef,
} from "@caelo-cms/plugin-sdk";
import type { ChromeDeps } from "./chrome-ops.js";
import type { PageVariantRow } from "./index.js";
import {
  appliesTo,
  collectSources,
  type ListSourceSnapshot,
  type LocaleOverlay,
  overlayFor,
  type SourceList,
  type TranslationIndex,
} from "./list-translation.js";
import {
  groupLocalesOf,
  type InstanceInfo,
  linkVersionCheck,
  loadListTranslationState,
  localListSources,
  type ModuleInfo,
  normalisePath,
  PAGE_REF_RE,
  type PageInfo,
  type PagePropTranslationRow,
  pagePropSources,
  type TermTranslationRow,
  translationIndexOf,
  type ValueTranslationRow,
  type VisibilityRow,
} from "./list-translation-ops.js";
import { chunked, listWhereAnyOf } from "./store-reads.js";

/** Page variant reads shared with the render pass (index.ts). */
export interface VariantReads {
  /** The variant row of each page that has one. */
  byPage(pageIds: readonly string[]): Promise<ReadonlyMap<string, PageVariantRow>>;
  /** Every variant row of each group. */
  groupMembers(groupIds: readonly string[]): Promise<ReadonlyMap<string, PageVariantRow[]>>;
}

const EMPTY = new Set<string>();

/** The `list-resolve` answer: one overlay per requested non-default language. */
export async function resolveListOverlays(
  deps: ChromeDeps,
  rawArgs: unknown,
  reads: VariantReads,
): Promise<{ overlays: Record<string, LocaleOverlay> }> {
  const { variants, scope } = listResolveArgs.parse(rawArgs);
  const overlays: Record<string, LocaleOverlay> = {};
  const wanted = variants.filter((v) => deps.locales.get(v)?.is_default === false);
  if (wanted.length === 0) return { overlays };
  if (scope) {
    for (const code of wanted) {
      const state = await loadScopedListState(deps, scope, code, reads);
      overlays[code] = overlayFor(
        state.snapshot,
        code,
        state.index,
        state.linkHasVersion,
        state.hiddenByOperator.get(code) ?? EMPTY,
      );
    }
    return { overlays };
  }
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

/** What one language's overlay of a scoped render is made from. */
interface ScopedListState {
  readonly snapshot: ListSourceSnapshot;
  readonly index: TranslationIndex;
  readonly hiddenByOperator: ReadonlyMap<string, ReadonlySet<string>>;
  readonly linkHasVersion: (href: string) => boolean;
}

/** `rows` of `call` for each slice of `ids` (none for an empty list). */
async function perChunk<T>(
  ids: readonly string[],
  call: (slice: string[]) => Promise<readonly T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (const slice of chunked([...new Set(ids)])) out.push(...(await call(slice)));
  return out;
}

/**
 * The scoped half of {@link resolveListOverlays}: the sources `scope`
 * names, as the whole-site state would see them, and their stored rows
 * in `locale`.
 */
async function loadScopedListState(
  deps: ChromeDeps,
  scope: ListResolveScope,
  locale: string,
  reads: VariantReads,
): Promise<ScopedListState> {
  const { cms, q } = deps;
  const defaultCode = [...deps.locales.values()].find((l) => l.is_default)?.code ?? null;
  const nonDefault = [...deps.locales.values()].filter((l) => !l.is_default).map((l) => l.code);
  // A variant row of a language the registry no longer has is no variant.
  const known = (v: PageVariantRow | undefined): PageVariantRow | undefined =>
    v && deps.locales.has(v.locale_code) ? v : undefined;
  const listIds = new Set(scope.listIds);

  // 1. The shared lists, and which of the instances hold local lists on
  //    which pages.
  const [lists, placed] = await Promise.all([
    listIds.size > 0
      ? cms.call<{
          lists: { id: string; slug: string; name: string; type: string; items?: ListItem[] }[];
        }>("lists.list", { includeItems: true })
      : { lists: [] },
    perChunk(scope.contentInstanceIds, async (slice) => {
      const r = await cms.call<{
        listInstances: { contentInstanceId: string; pageIds: string[] }[];
      }>("pages.list_shared_content", { listInstanceIds: slice });
      return r.listInstances;
    }),
  ]);
  const pagesOfInstance = new Map(placed.map((r) => [r.contentInstanceId, r.pageIds]));
  const [instances, modules] =
    pagesOfInstance.size > 0
      ? await Promise.all([
          perChunk([...pagesOfInstance.keys()], async (slice) => {
            const r = await cms.call<{ instances: InstanceInfo[] }>("content_instances.list", {
              ids: slice,
            });
            return r.instances;
          }),
          cms.call<{ modules: ModuleInfo[] }>("modules.list", {}),
        ])
      : [[] as InstanceInfo[], { modules: [] as ModuleInfo[] }];

  // 2. The variants of the pages those instances sit on and of the scope's
  //    pages (shared with the render pass's link_resolve).
  const variantByPage = new Map<string, PageVariantRow>();
  const learnVariants = async (pageIds: readonly string[]): Promise<void> => {
    const missing = pageIds.filter((id) => !variantByPage.has(id));
    if (missing.length === 0) return;
    for (const [id, v] of await reads.byPage(missing)) {
      const k = known(v);
      if (k) variantByPage.set(id, k);
    }
  };
  await learnVariants([...new Set([...[...pagesOfInstance.values()].flat(), ...scope.pageIds])]);
  const localeOfPage = (pageId: string): string | null =>
    variantByPage.get(pageId)?.locale_code ?? defaultCode;

  const sourceInstances = localListSources({
    instances,
    modules: modules.modules,
    pagesOfInstance,
    localeOfPage,
    defaultCode,
    nonDefault,
  });
  const sourceLists: SourceList[] = lists.lists
    .filter((l) => listIds.has(l.id) && deps.listTypes.has(l.type))
    .map((l) => ({ id: l.id, slug: l.slug, name: l.name, type: l.type, items: l.items ?? [] }));
  // The entries' links decide what is hidden for want of a version.
  const linked = collectSources({
    listTypes: deps.listTypes,
    lists: sourceLists,
    instances: sourceInstances,
    pageProps: [],
  });
  const hrefs = linked.entries.filter((e) => appliesTo(e, locale)).flatMap((e) => e.links);
  const refIds = hrefs.flatMap((h) => {
    const id = PAGE_REF_RE.exec(h)?.[1];
    return id ? [id] : [];
  });
  const paths = [
    ...new Set(hrefs.filter((h) => !PAGE_REF_RE.test(h) && h.startsWith("/")).map(normalisePath)),
  ];

  // 3. The language versions among the scope's pages, their groups' source
  //    pages, and the pages the links' paths name.
  const propVariants = scope.pageIds.flatMap((id) => {
    const v = variantByPage.get(id);
    return v && v.translation_status !== "source" && v.locale_code === locale ? [v] : [];
  });
  const sourceByGroup = new Map<string, string>();
  for (const members of (
    await reads.groupMembers([...new Set(propVariants.map((v) => v.group_id))])
  ).values()) {
    for (const m of members) {
      if (known(m) && m.translation_status === "source") sourceByGroup.set(m.group_id, m.page_id);
    }
  }
  const pageIds = [...new Set([...propVariants.map((v) => v.page_id), ...sourceByGroup.values()])];
  const [pages, pageTypes] = await Promise.all([
    readPages(cms, pageIds, paths),
    propVariants.length > 0
      ? cms.call<{ pageTypes: PageTypeDef[] }>("page_types.list", {})
      : { pageTypes: [] as PageTypeDef[] },
  ]);
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const pageIdByPath = new Map<string, string>();
  for (const p of pages) {
    const path = normalisePath(p.currentPath);
    if (paths.includes(path)) pageIdByPath.set(path, p.id);
  }
  const pageProps = pagePropSources({
    variants: propVariants,
    sourceByGroup,
    pageById,
    pageTypes: pageTypes.pageTypes,
    nonDefault,
  });

  // 4. The link targets' variants and their groups' languages.
  const targetIds = [...new Set([...refIds, ...pageIdByPath.values()])];
  await learnVariants(targetIds);
  const targetGroups = [
    ...new Set(
      targetIds.flatMap((id) => {
        const g = variantByPage.get(id)?.group_id;
        return g ? [g] : [];
      }),
    ),
  ];
  const groupLocales = groupLocalesOf(
    [...(await reads.groupMembers(targetGroups)).values()]
      .flat()
      .filter((v) => known(v) !== undefined),
  );

  // 5. The sources with their pages' properties, and their stored rows in
  //    `locale`.
  const snapshot = collectSources({
    listTypes: deps.listTypes,
    lists: sourceLists,
    instances: sourceInstances,
    pageProps,
  });
  const inLocale = { locale_code: locale };
  // Every unit's address, as the whole-site index would hold a value row
  // for it (a term or property row still wins, as there).
  const valueAddresses = snapshot.units.map((u) => u.address);
  const termLists = snapshot.units.flatMap((u) => (u.term ? [u.term.listId] : []));
  const [values, terms, props, visibility] = await Promise.all([
    listWhereAnyOf(q, "list_value_translations", "address", valueAddresses, inLocale),
    listWhereAnyOf(q, "term_translations", "list_id", termLists, inLocale),
    listWhereAnyOf(
      q,
      "page_prop_translations",
      "page_id",
      pageProps.map((p) => p.pageId),
      inLocale,
    ),
    listWhereAnyOf(
      q,
      "list_item_visibility",
      "address",
      snapshot.entries.map((e) => e.address),
      inLocale,
    ),
  ]);
  const { index, hiddenByOperator } = translationIndexOf({
    values: values as ValueTranslationRow[],
    terms: terms as TermTranslationRow[],
    props: props as PagePropTranslationRow[],
    visibility: visibility as VisibilityRow[],
  });
  const check = linkVersionCheck({ pageIdByPath, variantByPage, groupLocales, defaultCode });
  return { snapshot, index, hiddenByOperator, linkHasVersion: (h) => check(h, locale) };
}

/** The pages with these ids or at these paths (`pages.list`, ≤ 1000 of each per call). */
async function readPages(
  cms: ChromeDeps["cms"],
  pageIds: readonly string[],
  paths: readonly string[],
): Promise<PageInfo[]> {
  const idSlices = chunked([...pageIds]);
  const pathSlices = chunked([...paths]);
  const out: PageInfo[] = [];
  for (let i = 0; i < Math.max(idSlices.length, pathSlices.length); i += 1) {
    const ids = idSlices[i];
    const at = pathSlices[i];
    const r = await cms.call<{ pages: PageInfo[] }>("pages.list", {
      ...(ids ? { pageIds: ids } : {}),
      ...(at ? { paths: at } : {}),
    });
    out.push(...r.pages);
  }
  return out;
}
