// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's Stage-audit contribution — the I/O half (rules in
 * ./audit-rules.ts). Core calls `audit_findings` once with the staged
 * pages: this answers the site rules plus the list-translation findings
 * and asks for the facts of every page in batches that keep each
 * variant group together; core then calls once per batch with the facts.
 * Read-only, main line — what the staged build was rendered from.
 */

import type { PluginAuditFinding, PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import { z } from "@caelo-cms/plugin-sdk";
import {
  type AuditState,
  BuildModel,
  factBatchesOf,
  pageFindings,
  type StagedPageRef,
  siteFindings,
} from "./audit-rules.js";
import { type ChromeDeps, loadChromeTargets, loadChromeVariants } from "./chrome-ops.js";
import type { PageVariantRow } from "./index.js";
import { listFindings, loadListTranslationState } from "./list-translation-ops.js";
import type { GlossaryRow } from "./page-translation.js";
import { listAll } from "./store-reads.js";

/** Most findings one answer may carry (the SDK contract). */
const MAX_FINDINGS_PER_ANSWER = 499;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

const auditArgs = z
  .object({
    pages: z.array(z.object({ pageId: z.string(), path: z.string() }).strict()),
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
  })
  .strict();

/** The plugin's data the rules read, for the staged pages. */
export async function loadAuditState(
  deps: ChromeDeps,
  stagedPages: readonly StagedPageRef[],
): Promise<AuditState> {
  const [variants, glossary, defaults, shared, chromeRows, targets] = await Promise.all([
    listAll(deps.q, "page_variants") as Promise<PageVariantRow[]>,
    listAll(deps.q, "glossary") as Promise<GlossaryRow[]>,
    deps.cms.call<{ defaults: { rootPageId: string | null } | null }>("site_defaults.get", {}),
    deps.cms.call<{
      layoutPlacements: { moduleId: string }[];
      sharedInstances: { moduleId: string }[];
    }>("pages.list_shared_content", {}),
    loadChromeVariants(deps.q),
    loadChromeTargets(deps.cms),
  ]);
  const labels = new Map(targets.map((t) => [t.key, t.label]));
  return {
    locales: deps.locales,
    variants,
    stagedPages,
    siteHomePageId: defaults.defaults?.rootPageId ?? null,
    glossary,
    chromeModuleIds: new Set([
      ...shared.layoutPlacements.map((p) => p.moduleId),
      ...shared.sharedInstances.map((i) => i.moduleId),
    ]),
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
async function listTranslationFindings(deps: ChromeDeps): Promise<PluginAuditFinding[]> {
  const found = listFindings(deps, await loadListTranslationState(deps));
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
  const parsed = auditArgs.parse(args);
  const model = new BuildModel(await loadAuditState(deps, parsed.pages));
  if (parsed.facts) {
    return {
      findings: capFindings(pageFindings(model, parsed.facts as unknown as PluginAuditPageFacts[])),
    };
  }
  const batches = factBatchesOf(model);
  return {
    findings: capFindings([...(await listTranslationFindings(deps)), ...siteFindings(model)]),
    ...(batches.length > 0 ? { factBatches: batches } : {}),
  };
}
