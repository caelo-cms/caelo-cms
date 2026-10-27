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

import {
  type PluginAuditFinding,
  type PluginAuditFindingsArgs,
  type PluginAuditPageFacts,
  pluginAuditFindings,
} from "@caelo-cms/plugin-sdk";
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

/** Where the facts of staged pages come from (core reads the rendered HTML). */
export type AuditPageFactsReader = (
  pageIds: readonly string[],
) => Promise<readonly PluginAuditPageFacts[]>;

/**
 * Ask plugin `slug` for its findings about the staged pages.
 *
 * The first call carries the pages; when its answer names `factBatches`,
 * every batch is read through `facts` and the operation is called again
 * per batch with those facts. The findings of every call are returned in
 * call order (the caller files identical ones once).
 *
 * @param pages the published pages of the staged build; a finding may
 *   name only one of them (the runner refuses any other page).
 * @param facts reads the facts of the requested pages.
 * @throws when the plugin does not contribute, a call fails, an answer is
 *   malformed, or a batch names a page outside `pages`.
 */
export async function collectPluginAuditFindings(
  slug: string,
  pages: readonly { readonly pageId: string; readonly path: string }[],
  facts: AuditPageFactsReader,
): Promise<PluginAuditFinding[]> {
  const lp = loadedPlugins.all().find((p) => p.slug === slug && !isPluginDisabled(p.slug));
  const operationName = lp?.definition.auditFindingsOperation;
  if (!lp || typeof operationName !== "string") {
    throw new Error(
      `audit findings: plugin "${slug}" is not active or declares no auditFindingsOperation`,
    );
  }
  const pageArgs = pages.map((p) => ({ pageId: p.pageId, path: p.path }));
  const call = async (args: PluginAuditFindingsArgs, label: string) => {
    const r = await runPluginOperation({
      invocation: renderInvocation(MAIN_RENDER),
      pluginSlug: slug,
      operationName,
      args,
    });
    if (!r.ok) {
      throw new Error(
        `audit findings: ${slug}.${operationName} (${label}) failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const parsed = pluginAuditFindings.safeParse(r.value);
    if (!parsed.success) {
      throw new Error(
        `audit findings: plugin "${slug}" returned an invalid answer (${label}): ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  };
  const first = await call({ pages: pageArgs }, "pages");
  const out = [...first.findings];
  const staged = new Set(pages.map((p) => p.pageId));
  for (const [i, batch] of (first.factBatches ?? []).entries()) {
    const outside = batch.find((id) => !staged.has(id));
    if (outside) {
      throw new Error(
        `audit findings: plugin "${slug}" asked for the facts of page ${outside}, which is not a page of the staged build`,
      );
    }
    const answer = await call(
      { pages: pageArgs, facts: await facts(batch) },
      `facts batch ${i + 1}`,
    );
    if (answer.factBatches) {
      throw new Error(
        `audit findings: plugin "${slug}" requested factBatches again in facts batch ${i + 1} — batches are requested by the first call only`,
      );
    }
    out.push(...answer.findings);
  }
  return out;
}
