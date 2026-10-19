// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — reference integrity at the Stage boundary and
 * as a read op.
 *
 * Replaces the literal-path scan (`scanBranchInternalLinks`, #846): links
 * are references now, so the question is no longer "does this path match a
 * slug" but "does the referenced page exist, is it published, and does it
 * have a version in the rendering page's language" — answered by the same
 * resolver the render uses (links/reference-integrity.ts).
 *
 *   - {@link stageReferenceGate}: run by the Stage merge right after its
 *     replay, inside the merge transaction. A missing target (or a target
 *     without a same-language version) refuses the merge, so nothing
 *     reaches main; the static build would refuse it anyway, and here the
 *     refusal names every place and the tool that fixes it. Draft targets
 *     and legacy literal paths come back as warnings.
 *   - `links.check_references`: the read op behind the AI's `check_links`
 *     tool (chat and Power-MCP) and the Publish-live quality check
 *     (quality/checks/references.ts).
 */

import { hasLinkResolveContributors, resolveLinkVariants } from "@caelo-cms/plugin-host";
import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { createSiteLinkIndex, err, normaliseLinkPath, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadLinkTargetLookup } from "../../links/canonicalise.js";
import { loadActiveImportTargets } from "../../links/import-targets.js";
import {
  type ReferenceCheckEnv,
  type ReferenceIssue,
  scanReferenceIntegrity,
} from "../../links/reference-integrity.js";
import { loadReferenceSources } from "../../links/reference-sources.js";
import { loadPublishPageUrlStyle } from "./public-urls.js";

/** Thrown when the site has no default deploy target (no URL style). */
export class ReferenceCheckUnavailable extends Error {}

/**
 * Check every stored link of one scope.
 *
 * @param opts.branchId the scope (null = main line).
 * @param opts.pluginScopeBranchId the scope plugins answer in, when it
 *   differs (the Stage merge: main read in-transaction, plugins asked as
 *   the merged branch — see loadReferenceSources).
 */
export async function checkReferences(
  tx: TransactionRunner,
  opts: {
    readonly branchId: string | null;
    readonly env: ReferenceCheckEnv;
    readonly pluginScopeBranchId?: string | null;
  },
): Promise<ReferenceIssue[]> {
  const pageUrlStyle = await loadPublishPageUrlStyle(tx);
  if (pageUrlStyle === null) {
    throw new ReferenceCheckUnavailable(
      "no default deploy target — the link check needs the page URL style of the target Publish serves. " +
        "Next step: run the cms_admin migrations (they seed the production target) or mark a deploy target as default under Ops → Deploy.",
    );
  }
  const pluginScope =
    opts.pluginScopeBranchId === undefined ? opts.branchId : opts.pluginScopeBranchId;
  const lookup = await loadLinkTargetLookup(
    tx,
    opts.branchId,
    [],
    await activeImportPagePaths(tx, pluginScope),
  );
  const model = await loadReferenceSources(tx, opts.branchId, {
    pluginScopeBranchId: pluginScope,
  });
  const pageVariants =
    lookup.targets.pages.length > 0 && hasLinkResolveContributors()
      ? await resolveLinkVariants(
          lookup.targets.pages.map((p) => p.id),
          { chatBranchId: pluginScope },
        )
      : undefined;
  const index = createSiteLinkIndex({
    pages: lookup.targets.pages,
    media: lookup.targets.media,
    env: opts.env,
    pageUrlStyle,
    ...(pageVariants ? { pageVariants } : {}),
  });
  return scanReferenceIntegrity({ model, lookup, targets: lookup.targets, index, env: opts.env });
}

/**
 * Rollout E — pages an active site import has planned but not built yet.
 * While the run is active, a link to one stays literal on purpose
 * (`import_run_links`) and must not block a Stage; it is reported as
 * `pending-import-link`. Once the run finalises its links
 * (`imports.resolve_links`, or its cleanup) it is no longer active and
 * anything still unresolved follows the normal rules.
 *
 * @param branchId the scope's branch; null = the main line, which sees
 *   every active run's planned pages (the quality check reads main).
 */
async function activeImportPagePaths(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<Set<string>> {
  const branches = branchId
    ? [branchId]
    : (
        (await tx.execute(sql`
          SELECT DISTINCT cs.chat_branch_id::text AS branch_id
            FROM import_runs r
            JOIN chat_sessions cs ON cs.id = r.chat_session_id
           WHERE r.status NOT IN ('completed', 'failed') AND cs.chat_branch_id IS NOT NULL
        `)) as unknown as { branch_id: string }[]
      ).map((r) => r.branch_id);
  const paths = new Set<string>();
  for (const b of branches) {
    const targets = await loadActiveImportTargets(tx, b);
    for (const p of targets?.runsByPath.keys() ?? []) paths.add(p);
  }
  return paths;
}

/** Most blocking issues one Stage refusal lists (check_links has them all). */
const STAGE_MESSAGE_ISSUES = 8;
/** Most warnings a merge result carries. */
const STAGE_WARNINGS = 50;

/** What the Stage merge learns from the check. */
export type StageReferenceGate =
  | { readonly ok: true; readonly warnings: string[] }
  | { readonly ok: false; readonly message: string };

/**
 * The Stage gate: main line after the merge's replay, Stage policy.
 * Call inside the merge transaction, after the replay.
 */
export async function stageReferenceGate(
  tx: TransactionRunner,
  mergedBranchId: string,
): Promise<StageReferenceGate> {
  let issues: ReferenceIssue[];
  try {
    issues = await checkReferences(tx, {
      branchId: null,
      env: "staging",
      pluginScopeBranchId: mergedBranchId,
    });
  } catch (e) {
    if (e instanceof ReferenceCheckUnavailable) return { ok: false, message: e.message };
    throw e;
  }
  const blocking = issues.filter((i) => i.severity === "block");
  if (blocking.length > 0) {
    const listed = blocking
      .slice(0, STAGE_MESSAGE_ISSUES)
      .map((i, n) => `(${n + 1}) ${i.message}`)
      .join(" ");
    const more =
      blocking.length > STAGE_MESSAGE_ISSUES
        ? ` …and ${blocking.length - STAGE_MESSAGE_ISSUES} more (check_links lists every one).`
        : "";
    return {
      ok: false,
      message: `Stage refused — ${blocking.length} stored link(s) point at a page or file that does not exist (or has no version in the page's language), so the build would ship broken links: ${listed}${more} Fix each one with the tool it names, then Stage again.`,
    };
  }
  return {
    ok: true,
    warnings: issues.slice(0, STAGE_WARNINGS).map((i) => i.message),
  };
}

const placeSchema = z.looseObject({ kind: z.string() });

const issueSchema = z.object({
  problem: z.enum([
    "missing-target",
    "variant-missing",
    "unpublished-target",
    "literal-link",
    "broken-literal",
    "pending-import-link",
  ]),
  severity: z.enum(["block", "warning"]),
  target: z.string(),
  variant: z.string().nullable(),
  where: z.string(),
  place: placeSchema,
  pageIds: z.array(z.string()),
  pagePaths: z.array(z.string()),
  shipped: z.boolean(),
  message: z.string(),
  fix: z.object({ tool: z.string(), hint: z.string() }),
});

export const checkReferencesInput = z
  .object({
    /**
     * Which gate to check for: `stage` (a draft target is a warning) or
     * `publish` (Publish live / promote: a draft target blocks).
     */
    for: z.enum(["stage", "publish"]).default("publish"),
    /** Only issues on this page (plus site-wide chrome: sets, plugin data). */
    pageId: z.string().uuid().optional(),
    /** Same as pageId, by the page's path (`/about`). */
    pagePath: z.string().min(1).max(2000).optional(),
    /** False = blocking issues only. */
    includeWarnings: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const checkReferencesOp = defineOperation({
  name: "links.check_references",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: checkReferencesInput,
  output: z.object({
    env: z.enum(["staging", "production"]),
    /** `draft` = the caller's chat branch as its preview shows it; `main` = what is staged. */
    scope: z.enum(["main", "draft"]),
    blocking: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    issues: z.array(issueSchema),
    /** True when more issues matched than `limit` returned (blocks come first). */
    truncated: z.boolean(),
  }),
  handler: async (ctx, input, tx) => {
    const branchId = ctx.chatBranchId ?? null;
    const env: ReferenceCheckEnv = input.for === "stage" ? "staging" : "production";
    let issues: ReferenceIssue[];
    try {
      issues = await checkReferences(tx, { branchId, env });
    } catch (e) {
      if (e instanceof ReferenceCheckUnavailable) {
        return err({
          kind: "HandlerError",
          operation: "links.check_references",
          message: e.message,
        });
      }
      throw e;
    }
    const lookup = await loadLinkTargetLookup(tx, branchId);
    const paths = new Map(lookup.targets.pages.map((p) => [p.id, p.path]));
    let pageFilter: string | null = input.pageId ?? null;
    if (input.pagePath !== undefined) {
      const id = lookup.pageIdForPath(
        normaliseLinkPath(input.pagePath.startsWith("/") ? input.pagePath : `/${input.pagePath}`),
      );
      if (id === null) {
        return err({
          kind: "HandlerError",
          operation: "links.check_references",
          message: `no page has the path "${input.pagePath}". Next step: list_pages shows every page's path; or call check_links without a page filter.`,
        });
      }
      pageFilter = id;
    }
    const matching = issues.filter(
      (i) =>
        (input.includeWarnings || i.severity === "block") &&
        (pageFilter === null ||
          i.pageIds.includes(pageFilter) ||
          // Site-wide places (plugin data) render on every page.
          (i.pageIds.length === 0 && i.shipped)),
    );
    return ok({
      env,
      scope: branchId ? ("draft" as const) : ("main" as const),
      blocking: matching.filter((i) => i.severity === "block").length,
      warnings: matching.filter((i) => i.severity === "warning").length,
      issues: matching.slice(0, input.limit).map((i) => ({
        ...i,
        place: { ...i.place },
        pageIds: [...i.pageIds],
        pagePaths: i.pageIds.map((id) => paths.get(id) ?? id),
      })),
      truncated: matching.length > input.limit,
    });
  },
});
