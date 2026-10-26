// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — plugin contributions to the Stage audit (docs/lists.md §9
 * hook 5). An active plugin that declares an `auditFindingsOperation`
 * is asked once per audit, as a render (read-only) invocation on the main
 * line — the state the staged build was rendered from — which findings
 * it has about the staged pages. Core's quality runner files them under
 * `plugin.<slug>/<rule>` in the same report as its own checks
 * (admin-core `quality/checks/plugin-findings.ts`).
 *
 * The same path for every plugin, shipped or runtime-installed (CLAUDE.md
 * §2 one plugin model): the hook is a manifest field, the call goes
 * through the broker like every other plugin operation, and the answer is
 * Zod-validated here before core sees it.
 *
 * Loud (CLAUDE.md §2): a failing call or a malformed answer throws; the
 * runner then reports the plugin's check as failed and the audit fails,
 * instead of reading as "no findings".
 */

import { type PluginAuditFinding, pluginAuditFindings } from "@caelo-cms/plugin-sdk";
import {
  isPluginDisabled,
  loadedPlugins,
  MAIN_RENDER,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";

/** Slugs of the active plugins that contribute audit findings, sorted. */
export function auditFindingContributors(): string[] {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.auditFindingsOperation === "string")
    .map((lp) => lp.slug)
    .sort();
}

/**
 * Ask plugin `slug` for its findings about the staged pages.
 *
 * @param pages the published pages of the staged build; a finding may
 *   name only one of them (the runner refuses any other page).
 * @throws when the plugin does not contribute, the call fails or the
 *   answer is malformed.
 */
export async function collectPluginAuditFindings(
  slug: string,
  pages: readonly { readonly pageId: string; readonly path: string }[],
): Promise<PluginAuditFinding[]> {
  const lp = loadedPlugins.all().find((p) => p.slug === slug && !isPluginDisabled(p.slug));
  const operationName = lp?.definition.auditFindingsOperation;
  if (!lp || typeof operationName !== "string") {
    throw new Error(
      `audit findings: plugin "${slug}" is not active or declares no auditFindingsOperation`,
    );
  }
  const r = await runPluginOperation({
    invocation: renderInvocation(MAIN_RENDER),
    pluginSlug: slug,
    operationName,
    args: { pages: pages.map((p) => ({ pageId: p.pageId, path: p.path })) },
  });
  if (!r.ok) {
    throw new Error(
      `audit findings: ${slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`,
    );
  }
  const parsed = pluginAuditFindings.safeParse(r.value);
  if (!parsed.success) {
    throw new Error(
      `audit findings: plugin "${slug}" returned an invalid answer: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data.findings;
}
