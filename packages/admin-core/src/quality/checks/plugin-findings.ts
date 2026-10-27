// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — plugin contributions to the Stage audit (docs/lists.md §9
 * hook 5): one site check per active plugin that declares an
 * `auditFindingsOperation`, id `plugin.<slug>`, its findings filed as
 * `plugin.<slug>/<rule>` in the same report as core's checks. The plugin
 * host asks the plugin through the broker (plugin-host
 * `audit-findings.ts`); this file only maps the answer onto the findings
 * contract the runner validates (a finding naming a page outside the
 * staged build fails the check loudly, like any check's).
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

import type { PluginAuditFinding, PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import type { SiteCheck, StagedPage } from "./check.js";
import type { Finding } from "./findings.js";
import { siteHostsOf } from "./links-analysis.js";
import { extractPageFacts, parseSitemapAlternates, type SitemapAlternates } from "./page-facts.js";
import { CheckRegistry } from "./registry.js";
import { MAX_FINDINGS_PER_CALL } from "./runner.js";

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

/** Plugin calls go through the sandbox: allow more than a pure check's default. */
const PLUGIN_CHECK_TIMEOUT_MS = 60_000;

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
      let context: { hosts: Set<string>; sitemap: SitemapAlternates } | null = null;
      const facts = async (pageIds: readonly string[]) => {
        if (context === null) {
          const hosts = siteHostsOf([
            build.baseUrl,
            build.displayBaseUrl,
            ...(await source.siteUrls()),
          ]);
          context = {
            hosts,
            sitemap: parseSitemapAlternates(await build.text("/sitemap.xml"), hosts),
          };
        }
        const { hosts, sitemap } = context;
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
