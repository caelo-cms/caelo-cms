// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — plugin contributions to the Stage audit (docs/lists.md §9
 * hook 5): one site check per active plugin that declares an
 * `auditFindingsOperation`, id `plugin.<slug>`, its findings filed as
 * `plugin.<slug>/<rule>` in the same report as core's checks. Each call
 * reaches the plugin through the broker (plugin-host `audit-findings.ts`
 * `pluginAuditFindingsCall`; from the audit's job by a report to the admin,
 * #1359); this file runs the calls ({@link collectPluginFindings}) and maps
 * the answers onto the findings contract the runner validates (a finding
 * naming a page outside the staged build fails the check loudly, like any
 * check's).
 *
 * The contributors are read per audit, not once per process: activating
 * or archiving a plugin changes what the next Stage's audit runs without
 * a restart (CLAUDE.md §2 activation is a hard state).
 *
 * A plugin that checks the rendered pages asks for their facts in
 * batches (`factBatches`); this check extracts them from the staged HTML
 * (./page-facts.ts) only for the pages asked for, and reads the staged
 * `sitemap.xml` once. Findings from several calls are filed once each.
 */

import type {
  PluginAuditFinding,
  PluginAuditFindingsArgs,
  PluginAuditPageFacts,
} from "@caelo-cms/plugin-sdk";
import type { SiteCheck, StagedPage } from "./check.js";
import type { Finding } from "./findings.js";
import { siteHostsOf } from "./links-analysis.js";
import { extractPageFacts, parseSitemapAlternates, type SitemapAlternates } from "./page-facts.js";
import { CheckRegistry } from "./registry.js";
import { MAX_CHECK_CALL_TIMEOUT_MS, MAX_FINDINGS_PER_CALL, withTimeout } from "./runner.js";

/** Where plugin findings come from (the plugin host in production; fakes in tests). */
export interface PluginAuditSource {
  /** Slugs of the active plugins that contribute findings. */
  contributors(): readonly string[];
  findings(
    slug: string,
    pages: readonly { readonly pageId: string; readonly path: string }[],
    facts: (pageIds: readonly string[]) => Promise<readonly PluginAuditPageFacts[]>,
  ): Promise<readonly PluginAuditFinding[]>;
  /** The site's public URLs and domains: what counts as a same-site URL in the facts. */
  siteUrls(): Promise<readonly string[]>;
}

/** One validated answer of a plugin's `auditFindingsOperation`. */
export interface PluginAuditAnswer {
  readonly findings: readonly PluginAuditFinding[];
  readonly factBatches?: readonly (readonly string[])[];
  /** #1721 — what `pages` the batch calls carry (plugin SDK `pluginAuditFindings`). */
  readonly batchPages?: "all" | "own";
}

/**
 * One call of plugin `slug`'s `auditFindingsOperation`: plugin-host
 * `pluginAuditFindingsCall` in the admin; in the audit's job, a report
 * that asks the admin to make it (#1359).
 */
export type PluginAuditCall = (
  args: PluginAuditFindingsArgs,
  label: string,
) => Promise<PluginAuditAnswer>;

/**
 * #1632 — the budget of ONE call of a plugin's audit operation, not of
 * the plugin's check. The check makes one call plus one per fact batch
 * (at most 200 pages each; international-site asks for 100), so a single
 * budget for every call is a limit on the site's size instead of a hang
 * detector: a bilingual site of 299 pages made four calls and failed at
 * 60 s on every Stage. A plugin call goes through the broker and reads
 * the plugin's data: allow more than a pure check's default. A call
 * past it is hung, and the check fails naming that call.
 */
export const PLUGIN_AUDIT_CALL_TIMEOUT_MS = 60_000;

/**
 * #1721 — how many batch calls of one plugin's check run at once. Each
 * batch call is a few round trips from the audit's job to the admin
 * (through IAP on Google Cloud; its facts go in upload parts) and the
 * plugin's reads in the admin. One at a time, the check's time is the sum
 * of them: at 50,000 pages (500 batches of 100) that sum is what met the
 * check's 5-minute ceiling. A few at a time hide the round trips; more
 * only queue in the admin and on the database (a db-f1-micro has a fifth
 * of a core), next to the editors and agents a Stage does not stop.
 * Measured on the scale-gate fixture at 50,000 pages with a 100 ms round
 * trip per report (`scripts/scale-gate/audit-check.ts`, docs/dev/scale-gate.md):
 * 1 at a time 224 s, 2 142 s, 4 127 s, 8 172 s — at 8 the admin answers
 * reports busy (429) and the job sends them again.
 */
export const PLUGIN_AUDIT_BATCH_CONCURRENCY = 4;

/** How {@link collectPluginFindings} runs a plugin's calls. */
export interface PluginAuditCallOptions {
  /** One call's budget ({@link PLUGIN_AUDIT_CALL_TIMEOUT_MS}). */
  readonly callTimeoutMs?: number;
  /** Batch calls at once ({@link PLUGIN_AUDIT_BATCH_CONCURRENCY}). */
  readonly concurrency?: number;
}

/**
 * Run `count` tasks, at most `limit` at a time, in index order. On a
 * failure no further task starts; the ones running end, and the failure
 * of the lowest index is thrown. Every task below the highest index
 * started has started too, so that is the same failure however the tasks
 * interleaved: the result does not depend on the concurrency.
 */
async function inOrderAtMost(
  count: number,
  limit: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const failures = new Map<number, unknown>();
  const worker = async (): Promise<void> => {
    while (failures.size === 0 && next < count) {
      const index = next++;
      try {
        await task(index);
      } catch (e) {
        failures.set(index, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, () => worker()));
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
}

/**
 * Ask a plugin for its findings about the staged pages: the first call
 * carries the pages; when its answer names `factBatches`, every batch is
 * read through `facts` and the operation is called again per batch with
 * those facts, {@link PLUGIN_AUDIT_BATCH_CONCURRENCY} at a time. A batch
 * call carries every page, or with `batchPages: "own"` in the first answer
 * only the batch's own (#1721: the admin adds the audit run the plugin
 * reads the rest with). The findings are returned in call order, the
 * first call's then each batch's in batch order, however the calls
 * interleaved (the check files identical ones once).
 *
 * Each call has its own budget, `callTimeoutMs` ({@link PLUGIN_AUDIT_CALL_TIMEOUT_MS}).
 *
 * @throws when a call fails or runs past its budget, a batch names a page
 *   outside `pages`, or a batch call asks for batches again — the
 *   plugin's check then fails loudly instead of reading as "no findings".
 *   With several failing batches, the lowest one's failure.
 */
export async function collectPluginFindings(
  call: PluginAuditCall,
  slug: string,
  pages: readonly { readonly pageId: string; readonly path: string }[],
  facts: (pageIds: readonly string[]) => Promise<readonly PluginAuditPageFacts[]>,
  options: PluginAuditCallOptions = {},
): Promise<PluginAuditFinding[]> {
  const callTimeoutMs = options.callTimeoutMs ?? PLUGIN_AUDIT_CALL_TIMEOUT_MS;
  const concurrency = options.concurrency ?? PLUGIN_AUDIT_BATCH_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `audit findings: concurrency must be a whole number of at least 1, not ${concurrency}`,
    );
  }
  const budgeted = (args: PluginAuditFindingsArgs, label: string) =>
    withTimeout(call(args, label), callTimeoutMs, `plugin "${slug}" (${label})`);
  const pageArgs = pages.map((p) => ({ pageId: p.pageId, path: p.path }));
  const first = await budgeted({ pages: pageArgs }, "pages");
  const batches = first.factBatches ?? [];
  const pathOf = new Map(pages.map((p) => [p.pageId, p.path]));
  for (const batch of batches) {
    const outside = batch.find((id) => !pathOf.has(id));
    if (outside) {
      throw new Error(
        `audit findings: plugin "${slug}" asked for the facts of page ${outside}, which is not a page of the staged build`,
      );
    }
  }
  const own = first.batchPages === "own";
  const answers: PluginAuditAnswer[] = [];
  await inOrderAtMost(batches.length, concurrency, async (i) => {
    const batch = batches[i] as readonly string[];
    const label = `facts batch ${i + 1}`;
    const batchFacts = await facts(batch);
    const answer = await budgeted(
      own
        ? {
            pages: batch.map((pageId) => ({ pageId, path: pathOf.get(pageId) as string })),
            facts: batchFacts,
            batchPages: "own",
          }
        : { pages: pageArgs, facts: batchFacts },
      label,
    );
    if (answer.factBatches || answer.batchPages) {
      throw new Error(
        `audit findings: plugin "${slug}" answered ${answer.factBatches ? "factBatches" : "batchPages"} again in ${label} — the first call's answer alone names them`,
      );
    }
    answers[i] = answer;
  });
  return [...first.findings, ...answers.flatMap((a) => a.findings)];
}

/**
 * The whole check runs under the runner's ceiling, the backstop that
 * ends every audit: each call is bounded by
 * {@link PLUGIN_AUDIT_CALL_TIMEOUT_MS}, and a batch call costs what its
 * pages name, not the site (international-site, #1632).
 */
const PLUGIN_CHECK_TIMEOUT_MS = MAX_CHECK_CALL_TIMEOUT_MS;

/** The check id of plugin `slug`'s contributions. */
export function pluginCheckId(slug: string): string {
  return `plugin.${slug}`;
}

/** The site check that files plugin `slug`'s findings. */
export function createPluginAuditCheck(slug: string, source: PluginAuditSource): SiteCheck {
  const id = pluginCheckId(slug);
  return {
    id,
    title: `Plugin ${slug}`,
    scope: "site",
    timeoutMs: PLUGIN_CHECK_TIMEOUT_MS,
    async run({ pages, build }) {
      const byId = new Map(pages.map((p) => [p.pageId, p]));
      // Read once per check, by the first batch that needs it: batches run
      // side by side (#1721), so the promise is kept, not its value.
      let context: Promise<{ hosts: Set<string>; sitemap: SitemapAlternates }> | null = null;
      const facts = async (pageIds: readonly string[]) => {
        context ??= (async () => {
          const hosts = siteHostsOf([
            build.baseUrl,
            build.displayBaseUrl,
            ...(await source.siteUrls()),
          ]);
          return {
            hosts,
            sitemap: parseSitemapAlternates(await build.text("/sitemap.xml"), hosts),
          };
        })();
        const { hosts, sitemap } = await context;
        return pageIds.map((pageId) => {
          const page: StagedPage | undefined = byId.get(pageId);
          if (!page) {
            throw new Error(`plugin ${slug} asked for the facts of ${pageId}, not a staged page`);
          }
          return extractPageFacts(page, hosts, sitemap);
        });
      };
      const found = await source.findings(
        slug,
        pages.map((p) => ({ pageId: p.pageId, path: p.path })),
        facts,
      );
      return fileOnce(id, found);
    },
  };
}

const SEVERITY_ORDER: Readonly<Record<Finding["severity"], number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Map plugin findings onto the findings contract: each identical finding
 * once (two fact batches may see the same module), and — past the
 * runner's per-call cap — the most severe first plus one `limit-reached`
 * note, so a large site's report says what it left out instead of the
 * whole check failing.
 */
export function fileOnce(id: string, found: readonly PluginAuditFinding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of found) {
    const key = JSON.stringify([f.rule, f.severity, f.pageId ?? null, f.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ruleId: `${id}/${f.rule}`,
      severity: f.severity,
      ...(f.pageId ? { pageId: f.pageId } : {}),
      message: f.message,
      ...(f.fix ? { fix: f.fix } : {}),
    });
  }
  if (out.length <= MAX_FINDINGS_PER_CALL) return out;
  const kept = [...out]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, MAX_FINDINGS_PER_CALL - 1);
  kept.push({
    ruleId: `${id}/limit-reached`,
    severity: "info",
    message: `Findings limit reached: the plugin reported ${out.length} findings, the report shows the ${MAX_FINDINGS_PER_CALL - 1} most severe. Fix those and Stage again to see the rest.`,
  });
  return kept;
}

/**
 * `base` plus one check per contributing plugin, as a new registry (the
 * base is shared by every audit of the process and stays untouched).
 */
export function withPluginAuditChecks(
  base: CheckRegistry,
  source: PluginAuditSource,
): CheckRegistry {
  const slugs = source.contributors();
  if (slugs.length === 0) return base;
  const out = new CheckRegistry();
  for (const entry of base.list()) {
    if (entry.kind === "lighthouse") out.registerLighthouse(entry.run);
    else out.register(entry.check, entry.source);
  }
  for (const slug of slugs) {
    out.register(createPluginAuditCheck(slug, source), { kind: "plugin", slug });
  }
  return out;
}
