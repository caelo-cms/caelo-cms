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
 * more rows by id, in more reads, than the narrow table holds — the
 * model then knows every page.
 */
async function variantsAround(
  deps: ChromeDeps,
  pageIds: readonly string[],
): Promise<{ variants: PageVariantRow[]; knownPages?: Set<string> }> {
  if (pageIds.length > STORE_READ_MAX) {
    return { variants: (await listAll(deps.q, "page_variants")) as PageVariantRow[] };
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
  return { variants, knownPages: new Set([...pageIds, ...variants.map((v) => v.page_id)]) };
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

/** What the page rules read for one fact batch: what its pages name, nothing more. */
export async function loadPageRuleState(
  deps: ChromeDeps,
  stagedPages: readonly StagedPageRef[],
  facts: readonly PluginAuditPageFacts[],
): Promise<PageRuleState> {
  const [pages, glossary, neutralTerms, chrome, sameOnPurpose] = await Promise.all([
    sitePages(deps),
    listAll(deps.q, "glossary") as Promise<GlossaryRow[]>,
    listAll(deps.q, "neutral_terms") as Promise<NeutralTermRow[]>,
    sharedContentOn(
      deps,
      facts.map((f) => f.pageId),
    ),
    pluginTextsKeptAsIs(deps, stagedPages[0]?.pageId),
  ]);
  const { variants, knownPages } = await variantsAround(
    deps,
    pagesNamedBy(facts, stagedPages, pages.siteHomePageId),
  );
  return {
    locales: deps.locales,
    variants,
    ...(knownPages ? { knownPages } : {}),
    stagedPages,
    ...pages,
    glossary,
    neutralTerms,
    sameOnPurpose,
    ...chrome,
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
): Promise<{ findings: PluginAuditFinding[]; factBatches?: string[][] }> {
  const parsed = parseAuditArgs(args);
  if (parsed.facts) {
    const facts = parsed.facts as unknown as PluginAuditPageFacts[];
    const model = new BuildModel(await loadPageRuleState(deps, parsed.pages, facts));
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
    ...(batches.length > 0 ? { factBatches: batches } : {}),
  };
}
