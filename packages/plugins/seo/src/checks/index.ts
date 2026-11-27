// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's Stage-audit contribution (core's `auditFindingsOperation`
 * hook, epic #1751). Only objective rules are findings, and an `error`
 * blocks Publish live until it is fixed or accepted; rules of thumb are
 * write hints (`../hints/`), never findings (maintainer decision
 * 2026-11-26).
 *
 * Every rule family is one {@link SeoAuditRule} in {@link SEO_AUDIT_RULES},
 * each in a file of its own under `checks/`. The runner below is the I/O
 * contract with core, shared by all of them:
 *
 * - The first call carries every staged page and no facts. Each rule's
 *   `site` part runs there, once per Stage: it reads site-wide data (the
 *   page types, the vocabularies) exactly once.
 * - When any rule has a `facts` part, the first answer asks for the facts
 *   of every page in batches of {@link MAX_AUDIT_FACT_BATCH_PAGES}, with
 *   `batchPages: "own"`: a batch call then carries only its own pages, so
 *   it costs the same on a site of 50 pages and one of 50,000 (#1721).
 *   Core makes up to four batch calls at once, so a `facts` part reads
 *   only what its batch's pages name.
 */

import {
  MAX_AUDIT_FACT_BATCH_PAGES,
  type PluginAuditFinding,
  type PluginAuditFindingsArgs,
  type PluginAuditPageFacts,
  type PluginContextTier1,
  z,
} from "@caelo-cms/plugin-sdk";

type Ctx = PluginContextTier1;

/** One staged page as core names it. */
export interface StagedPage {
  readonly pageId: string;
  readonly path: string;
}

/** What a rule's `site` part reads: the whole staged build, by id and path. */
export interface SiteAuditInput {
  readonly pages: readonly StagedPage[];
  /** The Stage's deploy run. */
  readonly runId: string | undefined;
}

/** What a rule's `facts` part reads: one batch of staged pages and their facts. */
export interface FactsAuditInput {
  readonly facts: readonly PluginAuditPageFacts[];
  /** The audit run, for `quality_audits.staged_pages` (a page outside the batch, by id or path). */
  readonly auditRunId: string | undefined;
}

/** One family of objective rules. */
export interface SeoAuditRule {
  /** Names the family in an error (`structured-data`, `topic-pages`). */
  readonly name: string;
  /** Findings from site-wide data, on the first call. */
  readonly site?: (ctx: Ctx, input: SiteAuditInput) => Promise<readonly PluginAuditFinding[]>;
  /** Findings from the rendered pages, once per fact batch. */
  readonly facts?: (ctx: Ctx, input: FactsAuditInput) => Promise<readonly PluginAuditFinding[]>;
}

/**
 * Every rule family the audit runs, in report order. A new family is a file
 * under `checks/` and one entry here.
 */
export const SEO_AUDIT_RULES: readonly SeoAuditRule[] = [];

/** Most findings one answer may carry (the SDK contract). */
const MAX_FINDINGS_PER_ANSWER = 499;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/**
 * What core sends, key for key. Strict, so every key the SDK names is listed
 * here, read or not; `satisfies` stops the build when the SDK gains a key
 * this list lacks (a missing key once failed every Stage audit, #1651).
 */
const auditArgShape = {
  pages: z.array(z.object({ pageId: z.string(), path: z.string() }).strict()),
  runId: z.string().optional(),
  batchPages: z.literal("own").optional(),
  auditRunId: z.string().optional(),
  // Core builds the facts (admin-core quality/checks/page-facts.ts); the SDK
  // type is the contract.
  facts: z.array(z.object({ pageId: z.string(), path: z.string() }).passthrough()).optional(),
} satisfies Record<keyof PluginAuditFindingsArgs, z.ZodType>;

const auditArgs = z.object(auditArgShape).strict();

/** The findings to answer: errors first, at most what one answer holds. */
function capped(findings: readonly PluginAuditFinding[]): PluginAuditFinding[] {
  return [...findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, MAX_FINDINGS_PER_ANSWER);
}

/** The fact batches of the first answer: every page, in staged order. */
function factBatchesOf(pages: readonly StagedPage[]): string[][] {
  const batches: string[][] = [];
  for (let at = 0; at < pages.length; at += MAX_AUDIT_FACT_BATCH_PAGES) {
    batches.push(pages.slice(at, at + MAX_AUDIT_FACT_BATCH_PAGES).map((p) => p.pageId));
  }
  return batches;
}

/**
 * The `audit` operation: runs {@link SEO_AUDIT_RULES} (or `rules`, for a
 * test) against one call of core's audit.
 */
export async function seoAudit(
  ctx: Ctx,
  rawArgs: unknown,
  rules: readonly SeoAuditRule[] = SEO_AUDIT_RULES,
): Promise<{
  findings: PluginAuditFinding[];
  factBatches?: string[][];
  batchPages?: "own";
}> {
  const args = auditArgs.parse(rawArgs);
  if (args.facts !== undefined) {
    const input: FactsAuditInput = {
      facts: args.facts as unknown as readonly PluginAuditPageFacts[],
      auditRunId: args.auditRunId,
    };
    const findings: PluginAuditFinding[] = [];
    for (const rule of rules) if (rule.facts) findings.push(...(await rule.facts(ctx, input)));
    return { findings: capped(findings) };
  }
  const findings: PluginAuditFinding[] = [];
  const input: SiteAuditInput = { pages: args.pages, runId: args.runId };
  for (const rule of rules) if (rule.site) findings.push(...(await rule.site(ctx, input)));
  const wantsFacts = rules.some((r) => r.facts !== undefined) && args.pages.length > 0;
  return wantsFacts
    ? { findings: capped(findings), factBatches: factBatchesOf(args.pages), batchPages: "own" }
    : { findings: capped(findings) };
}
