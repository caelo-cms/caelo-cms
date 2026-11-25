// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's Stage-audit contribution — the I/O half (rules in
 * ./audit-rules.ts). Core calls `audit_findings` once with the staged
 * pages: this answers the site rules plus the list-translation findings
 * and asks for the facts of every page in batches that keep each
 * variant group together; core then calls once per batch with the facts.
 * Read-only, main line — what the staged build was rendered from.
 *
 * #1632 — each call reads what ITS rules need, nothing the other kind
 * of call needs. The first call is site-wide by nature (coverage, broken
 * groups, list translations): it reads each site-wide source once. A
 * batch call costs what its pages name: the variant rows of its pages and
 * of the pages they link to, the shared content placed on its pages,
 * and the site's term lists. Before, every batch call re-ran
 * the first call's reads (`pages.list_shared_content` twice, every variant
 * row), so the audit's cost grew with batches × site and a 299-page site
 * ran out of the check's time.
 *
 * #1721 — and a batch call is no longer handed every page of the build:
 * the first answer says `batchPages: "own"`, so each batch call carries
 * its own pages and the audit run, by which it reads the few other pages
 * its rules name (`quality_audits.staged_pages`). The page list crosses
 * once per audit, with the first call.
 */

import type {
  PluginAuditFinding,
  PluginAuditFindingsArgs,
  PluginAuditPageFacts,
} from "@caelo-cms/plugin-sdk";
import { z } from "@caelo-cms/plugin-sdk";
import {
  BuildModel,
  factBatchesOf,
  type PageRuleState,
  pageFindings,
  pagesNamedBy,
  type SiteRuleState,
  type StagedPageRef,
  siteFindings,
} from "./audit-rules.js";
import {
  type ChromeDeps,
  chromeTargetsOf,
  loadChromeVariants,
  type SharedContent,
} from "./chrome-ops.js";
import type { PageVariantRow } from "./index.js";
import { collectSources } from "./list-translation.js";
import {
  type KnownSiteReads,
  listFindings,
  loadListTranslationState,
  loadPluginSources,
  type ValueTranslationRow,
} from "./list-translation-ops.js";
import type { NeutralTermRow } from "./neutral-terms.js";
import type { GlossaryRow } from "./page-translation.js";
import { chunked, listAll, listWhereAnyOf, STORE_READ_MAX } from "./store-reads.js";
import { onePerValueAddress } from "./translation-rows.js";

/** Most findings one answer may carry (the SDK contract). */
const MAX_FINDINGS_PER_ANSWER = 499;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/**
 * What core sends, key for key (`PluginAuditFindingsArgs`). The object is
 * strict, so every key the SDK names must be listed here, read or not: a
 * missing `runId` failed every Stage audit of a site with this plugin once
 * core started sending it (#1651). `satisfies` stops the build when the SDK
 * gains a key this list lacks.
 */
const auditArgShape = {
  pages: z.array(z.object({ pageId: z.string(), path: z.string() }).strict()),
  // The Stage's deploy run. Unread: the audit reads the main line the
  // staged build was rendered from, not one run's output.
  runId: z.string().optional(),
  // #1721 — a batch call with only its own pages, and the audit run the
  // other pages of the build are read by (quality_audits.staged_pages).
  batchPages: z.literal("own").optional(),
  auditRunId: z.string().optional(),
  // Core builds the facts (admin-core quality/checks/page-facts.ts); the
  // SDK type is the contract, checked here for the fields the rules read.
  facts: z
    .array(
      z
        .object({
          pageId: z.string(),
          path: z.string(),
          alternates: z.array(z.unknown()),
          links: z.array(z.unknown()),
          texts: z.array(z.unknown()),
        })
        .passthrough(),
    )
    .optional(),
} satisfies Record<keyof PluginAuditFindingsArgs, z.ZodType>;

const auditArgs = z.object(auditArgShape).strict();

/** Parses one call of `audit_findings`; throws on a key core does not send. */
export function parseAuditArgs(args: unknown): z.infer<typeof auditArgs> {
  return auditArgs.parse(args);
}

/**
 * Per language, the plugin texts whose current translation reads the same
 * as the source ("Marketing" is that in German and English). A translator
 * decided that; comparing the page with its source cannot tell (#1323).
 *
 * Read per language: the table's index leads with `locale_code`
 * (`["locale_code", "address"]`), so a read by address alone is one no
 * index can drive, and the host refuses it (#1292, #1536). A language
 * version only ever holds translations of its non-default languages.
 *
 * @param pageId any page of the site.
 */
export async function pluginTextsKeptAsIs(
  deps: ChromeDeps,
  pageId: string | undefined,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const pluginSources = await loadPluginSources(deps.cms, pageId);
  const { units } = collectSources({
    listTypes: new Map(),
    lists: [],
    instances: [],
    pageProps: [],
    pluginSources,
  });
  const addresses = units.map((u) => u.address);
  const translated = [...deps.locales.values()].filter((l) => !l.is_default);
  // One language after the other: each read holds a connection, and the
  // audit already runs its other reads beside this one (loadPageRuleState).
  const rows: ValueTranslationRow[] = [];
  for (const l of translated) {
    rows.push(
      ...((await listWhereAnyOf(deps.q, "list_value_translations", "address", addresses, {
        locale_code: l.code,
      })) as unknown as ValueTranslationRow[]),
    );
  }
  const unitByAddress = new Map(units.map((u) => [u.address, u]));
  const out = new Map<string, Set<string>>();
  // #1659 — rows that share a key read as the one every reader takes.
  for (const r of onePerValueAddress(rows).rows) {
    const u = unitByAddress.get(r.address);
    if (!u || r.source_hash !== u.hash || r.value?.trim() !== u.text.trim()) continue;
    const kept = out.get(r.locale_code) ?? new Set<string>();
    kept.add(u.text.trim().toLowerCase());
    out.set(r.locale_code, kept);
  }
  return out;
}

/** The home and 404 page core ships (`site_defaults.get`). */
async function sitePages(
  deps: ChromeDeps,
): Promise<{ siteHomePageId: string | null; notFoundPageId: string | null }> {
  const r = await deps.cms.call<{
    defaults: { rootPageId: string | null; notFoundPageId: string | null } | null;
  }>("site_defaults.get", {});
  return {
    siteHomePageId: r.defaults?.rootPageId ?? null,
    notFoundPageId: r.defaults?.notFoundPageId ?? null,
  };
}

/** The site-wide sources the first call reads once, for its own rules and the list findings. */
interface SiteReads {
  readonly variants: PageVariantRow[];
  readonly shared: SharedContent;
}

/** What the site rules read (the first call). */
export async function loadSiteRuleState(
  deps: ChromeDeps,
  stagedPages: readonly StagedPageRef[],
  site: SiteReads,
): Promise<SiteRuleState> {
  const [pages, chromeRows] = await Promise.all([sitePages(deps), loadChromeVariants(deps.q)]);
  const labels = new Map(chromeTargetsOf(site.shared).map((t) => [t.key, t.label]));
  return {
    locales: deps.locales,
    variants: site.variants,
    stagedPages,
    ...pages,
    staleChrome: chromeRows
      .filter((r) => r.mode === "translated" && r.translation_status === "needs_update")
      .flatMap((r) => {
        const label = labels.get(r.target_key);
        // A variant whose target is gone renders nowhere: nothing to report.
        return label ? [{ label, localeCode: r.locale_code }] : [];
      }),
  };
}

/**
 * The variant rows of `pageIds` and of every other member of their
 * groups, and the pages that covers (a page without a row is in no group,
 * which is known too). Past one read of ids the whole table instead, as
 * `loadVariantsByPage` does (#1212): pages that link half the site name
 * more rows by id, in more reads, than the narrow table holds. The rows
 * of the other groups the table holds are then read too, and `members`
 * still names only the pages of the groups `pageIds` are in.
 */
async function variantsAround(
  deps: ChromeDeps,
  pageIds: readonly string[],
): Promise<{ variants: PageVariantRow[]; members: Set<string>; wholeTable: boolean }> {
  if (pageIds.length > STORE_READ_MAX) {
    const variants = (await listAll(deps.q, "page_variants")) as PageVariantRow[];
    const named = new Set(pageIds);
    const groups = new Set(variants.filter((v) => named.has(v.page_id)).map((v) => v.group_id));
    return {
      variants,
      members: new Set(variants.filter((v) => groups.has(v.group_id)).map((v) => v.page_id)),
      wholeTable: true,
    };
  }
  const own = (await listWhereAnyOf(
    deps.q,
    "page_variants",
    "page_id",
    pageIds,
  )) as PageVariantRow[];
  const variants = (await listWhereAnyOf(
    deps.q,
    "page_variants",
    "group_id",
    own.map((v) => v.group_id),
  )) as PageVariantRow[];
  return { variants, members: new Set(variants.map((v) => v.page_id)), wholeTable: false };
}

/**
 * The shared content of `pageIds`: the modules placed in a layout, and
 * per page the modules of the shared instances placed on it — asked of
 * core for these pages only.
 */
async function sharedContentOn(
  deps: ChromeDeps,
  pageIds: readonly string[],
): Promise<Pick<PageRuleState, "chromeModuleIds" | "sharedModulesOn">> {
  const chromeModuleIds = new Set<string>();
  const sharedModulesOn = new Map<string, Set<string>>();
  for (const ids of chunked(pageIds)) {
    const r = await deps.cms.call<SharedContent>("pages.list_shared_content", { onPageIds: ids });
    for (const p of r.layoutPlacements) chromeModuleIds.add(p.moduleId);
    for (const i of r.sharedInstances) {
      for (const pageId of i.pageIds) {
        const on = sharedModulesOn.get(pageId) ?? new Set<string>();
        on.add(i.moduleId);
        sharedModulesOn.set(pageId, on);
      }
    }
  }
  return { chromeModuleIds, sharedModulesOn };
}

/**
 * Where a batch call reads the pages of the build (#1721): from `pages`
 * when core passed every page, or by the audit run when the first answer
 * asked for batch calls with their own pages only (`batchPages: "own"`).
 */
export type BatchPages =
  | { readonly kind: "all"; readonly stagedPages: readonly StagedPageRef[] }
  | { readonly kind: "own"; readonly auditRunId: string; readonly own: readonly StagedPageRef[] };

/**
 * #1721 — the staged pages among `pageIds` and `paths`, read by the
 * audit run (`quality_audits.staged_pages`): one read per 1000 ids and
 * 1000 paths, none when nothing is asked.
 */
async function stagedPagesOf(
  deps: ChromeDeps,
  auditRunId: string,
  ask: { readonly pageIds: readonly string[]; readonly paths: readonly string[] },
): Promise<StagedPageRef[]> {
  const ids = chunked([...new Set(ask.pageIds)]);
  const paths = chunked([...new Set(ask.paths)]);
  const out: StagedPageRef[] = [];
  for (let i = 0; i < Math.max(ids.length, paths.length); i++) {
    const r = await deps.cms.call<{ pages: StagedPageRef[] }>("quality_audits.staged_pages", {
      auditRunId,
      ...(ids[i] ? { pageIds: ids[i] } : {}),
      ...(paths[i] ? { paths: paths[i] } : {}),
    });
    out.push(...r.pages);
  }
  return out;
}

/** Every site path a page's facts name: its canonical, hreflang alternates and links. */
function pathsNamedBy(facts: readonly PluginAuditPageFacts[]): string[] {
  const out = new Set<string>();
  for (const f of facts) {
    if (f.canonical?.path) out.add(f.canonical.path);
    for (const a of f.alternates) if (a.path) out.add(a.path);
    for (const l of f.links) if (l.path) out.add(l.path);
  }
  return [...out];
}

/**
 * #1721 — the pages of the build a batch's rules ask about, when the
 * batch call carries only its own: its pages, the staged pages at the
 * paths its facts name, the site home, and the language versions of all
 * of these (variant groups). Two reads by the audit run: the named paths
 * (and the home), then the versions not known yet. Costs what the batch
 * names, whatever the size of the site.
 */
async function buildPagesOwn(
  deps: ChromeDeps,
  pages: Extract<BatchPages, { kind: "own" }>,
  facts: readonly PluginAuditPageFacts[],
  siteHomePageId: string | null,
): Promise<{
  variants: PageVariantRow[];
  stagedPages: StagedPageRef[];
  knownPages: Set<string>;
  knownPaths: Set<string>;
}> {
  const known = new Map<string, string>();
  for (const p of [...pages.own, ...facts.map((f) => ({ pageId: f.pageId, path: f.path }))]) {
    known.set(p.pageId, p.path);
  }
  const ownPaths = new Set(known.values());
  const named = pathsNamedBy(facts).filter((path) => !ownPaths.has(path));
  const home = siteHomePageId && !known.has(siteHomePageId) ? [siteHomePageId] : [];
  for (const p of await stagedPagesOf(deps, pages.auditRunId, { pageIds: home, paths: named })) {
    known.set(p.pageId, p.path);
  }
  const namedIds = [...known.keys(), ...home];
  const { variants, members } = await variantsAround(deps, namedIds);
  const unread = [...members].filter((id) => !known.has(id));
  for (const p of await stagedPagesOf(deps, pages.auditRunId, { pageIds: unread, paths: [] })) {
    known.set(p.pageId, p.path);
  }
  return {
    variants,
    stagedPages: [...known].map(([pageId, path]) => ({ pageId, path })),
    knownPages: new Set([...namedIds, ...members]),
    knownPaths: new Set([...ownPaths, ...named, ...known.values()]),
  };
}

/** What the page rules read for one fact batch: what its pages name, nothing more. */
export async function loadPageRuleState(
  deps: ChromeDeps,
  pages: BatchPages,
  facts: readonly PluginAuditPageFacts[],
): Promise<PageRuleState> {
  const anyPage = pages.kind === "all" ? pages.stagedPages[0] : pages.own[0];
  const [site, glossary, neutralTerms, chrome, sameOnPurpose] = await Promise.all([
    sitePages(deps),
    listAll(deps.q, "glossary") as Promise<GlossaryRow[]>,
    listAll(deps.q, "neutral_terms") as Promise<NeutralTermRow[]>,
    sharedContentOn(
      deps,
      facts.map((f) => f.pageId),
    ),
    pluginTextsKeptAsIs(deps, anyPage?.pageId),
  ]);
  const common = {
    locales: deps.locales,
    ...site,
    glossary,
    neutralTerms,
    sameOnPurpose,
    ...chrome,
  };
  if (pages.kind === "own") {
    return { ...common, ...(await buildPagesOwn(deps, pages, facts, site.siteHomePageId)) };
  }
  const named = pagesNamedBy(facts, pages.stagedPages, site.siteHomePageId);
  const { variants, members, wholeTable } = await variantsAround(deps, named);
  return {
    ...common,
    variants,
    // The whole table read: the model knows every page's group.
    ...(wholeTable ? {} : { knownPages: new Set([...named, ...members]) }),
    stagedPages: pages.stagedPages,
  };
}

/**
 * At most {@link MAX_FINDINGS_PER_ANSWER}: the most severe first, and a
 * note saying what was left out, so a huge batch never fails the audit
 * or loses findings without a word.
 */
export function capFindings(found: readonly PluginAuditFinding[]): PluginAuditFinding[] {
  if (found.length <= MAX_FINDINGS_PER_ANSWER) return [...found];
  const kept = [...found]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, MAX_FINDINGS_PER_ANSWER - 1);
  kept.push({
    rule: "limit-reached",
    severity: "info",
    message: `Findings limit reached: ${found.length} language findings in one part of the site; the ${MAX_FINDINGS_PER_ANSWER - 1} most severe are shown. Fix those and Stage again to see the rest.`,
  });
  return kept;
}

/** The list-translation findings (epic #1107), site-wide. */
async function listTranslationFindings(
  deps: ChromeDeps,
  known: KnownSiteReads,
): Promise<PluginAuditFinding[]> {
  const found = listFindings(deps, await loadListTranslationState(deps, known));
  return found.map((f) => ({
    rule:
      f.code === "list-link-variant-missing"
        ? "list-link-target-missing"
        : f.code === "page-property-missing"
          ? "page-property-translation-missing"
          : "list-translation-missing",
    severity: "warning" as const,
    message:
      `${f.code === "list-link-variant-missing" ? "Link target has no version" : "Translation missing"}: ${f.message}`.slice(
        0,
        1000,
      ),
    fix: {
      tool: f.code === "list-link-variant-missing" ? "create_variant" : "translate_chrome",
      hint: f.nextStep.slice(0, 500),
    },
  }));
}

/** The `audit_findings` operation. */
export async function auditFindings(
  deps: ChromeDeps,
  args: unknown,
): Promise<{
  findings: PluginAuditFinding[];
  factBatches?: string[][];
  batchPages?: "own";
}> {
  const parsed = parseAuditArgs(args);
  if (parsed.facts) {
    const facts = parsed.facts as unknown as PluginAuditPageFacts[];
    const model = new BuildModel(await loadPageRuleState(deps, batchPagesOf(parsed), facts));
    return { findings: capFindings(pageFindings(model, facts)) };
  }
  const [variants, shared] = await Promise.all([
    listAll(deps.q, "page_variants") as Promise<PageVariantRow[]>,
    deps.cms.call<SharedContent>("pages.list_shared_content", {}),
  ]);
  const model = new BuildModel(await loadSiteRuleState(deps, parsed.pages, { variants, shared }));
  const batches = factBatchesOf(model);
  const listed = await listTranslationFindings(deps, {
    variants,
    listInstances: shared.listInstances,
  });
  return {
    findings: capFindings([...listed, ...siteFindings(model)]),
    // #1721 — the batch calls need only their own pages: the others their
    // rules name are read by the audit run, so a batch call costs the same
    // on a site of 500 pages and one of 50,000.
    ...(batches.length > 0 ? { factBatches: batches, batchPages: "own" as const } : {}),
  };
}

/** Where a batch call's pages come from, as core said (`batchPages`, `auditRunId`). */
function batchPagesOf(parsed: z.infer<typeof auditArgs>): BatchPages {
  if (parsed.batchPages !== "own") return { kind: "all", stagedPages: parsed.pages };
  if (!parsed.auditRunId) {
    throw new Error(
      'international-site audit: a batch call with only its own pages (batchPages "own") carries no auditRunId to read the other pages of the build by. Report it with bug_report.',
    );
  }
  return { kind: "own", auditRunId: parsed.auditRunId, own: parsed.pages };
}
