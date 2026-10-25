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
 */

import type { PluginAuditFinding } from "@caelo-cms/plugin-sdk";
import type { SiteCheck } from "./check.js";
import type { Finding } from "./findings.js";
import { CheckRegistry } from "./registry.js";

/** Where plugin findings come from (the plugin host in production; fakes in tests). */
export interface PluginAuditSource {
  /** Slugs of the active plugins that contribute findings. */
  contributors(): readonly string[];
  findings(
    slug: string,
    pages: readonly { readonly pageId: string; readonly path: string }[],
  ): Promise<readonly PluginAuditFinding[]>;
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
    async run({ pages }) {
      const found = await source.findings(
        slug,
        pages.map((p) => ({ pageId: p.pageId, path: p.path })),
      );
      return found.map(
        (f): Finding => ({
          ruleId: `${id}/${f.rule}`,
          severity: f.severity,
          ...(f.pageId ? { pageId: f.pageId } : {}),
          message: f.message,
          ...(f.fix ? { fix: f.fix } : {}),
        }),
      );
    },
  };
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
