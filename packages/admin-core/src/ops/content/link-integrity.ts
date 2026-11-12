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
 *     replay, inside the merge transaction. A missing target refuses the
 *     merge, so nothing reaches main; the static build would refuse it
 *     anyway, and here the refusal names every place and the tool that
 *     fixes it. Draft targets, targets without a same-language version
 *     (#1240) and legacy literal paths come back as warnings.
 *   - {@link buildReferenceGate}: the same check where every build starts
 *     (`deploy.start_trigger`). A merge can only see what it merges: a
 *     page published in the panel changes the live row and leaves a chat
 *     nothing to merge, and a rebuild merges nothing at all (#1240). A
 *     staging build records the same read under the Publish policy for its
 *     quality audit ({@link RecordedReferenceCheck}, #1594): the audit
 *     reports what the build rendered and reads the site no second time.
 *   - `links.check_references`: the read op behind the AI's `check_links`
 *     tool (chat and Power-MCP).
 *   - `links.publish_notice`: what a publish click tells the operator.
 *
 * Each check reads its scope once (`loadReferences`) and scans that read
 * per environment.
 */

import {
  hasLinkResolveContributors,
  type ResolvedLinkVariants,
  resolveLinkVariants,
} from "@caelo-cms/plugin-host";
import { defineOperation, type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { createSiteLinkIndex, err, normaliseLinkPath, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadLinkTargetLookup } from "../../links/canonicalise.js";
import { type ActiveImportTargets, loadActiveImportTargets } from "../../links/import-targets.js";
import {
  buildLinkNotice,
  type LinkNotice,
  linkNoticeSchema,
  type NoticePage,
} from "../../links/link-notice.js";
import { REFERENCE_PROBLEMS } from "../../links/reference-fix.js";
import {
  type ReferenceCheckEnv,
  type ReferenceIssue,
  scanReferenceIntegrity,
} from "../../links/reference-integrity.js";
import { loadReferenceSources, type ReferenceSourceModel } from "../../links/reference-sources.js";
import { loadPageRows } from "../../lists/pages-view.js";
import { loadPublishPageUrlStyle } from "./public-urls.js";

/** Thrown when the site has no default deploy target (no URL style). */
export class ReferenceCheckUnavailable extends Error {}

/**
 * One scope's link sources and link targets, read once. Every scan of the
 * scope (a gate's environment, the audit's Publish policy, the op's page
 * paths) runs over it, so a check that answers two questions does not read
 * the site twice (#1594).
 */
interface LoadedReferences {
  readonly model: ReferenceSourceModel;
  readonly lookup: Awaited<ReturnType<typeof loadLinkTargetLookup>>;
  readonly pageUrlStyle: NonNullable<Awaited<ReturnType<typeof loadPublishPageUrlStyle>>>;
  readonly pageVariants: ResolvedLinkVariants | undefined;
}

/**
 * Read every stored link of one scope and every page and file it can
 * point at. The pages are read once, for the targets and the sources.
 *
 * @param opts.branchId the scope (null = main line).
 * @param opts.pluginScopeBranchId the scope plugins answer in, when it
 *   differs (the Stage merge: main read in-transaction, plugins asked as
 *   the merged branch — see loadReferenceSources).
 */
async function loadReferences(
  tx: TransactionRunner,
  opts: { readonly branchId: string | null; readonly pluginScopeBranchId?: string | null },
): Promise<LoadedReferences> {
  const pageUrlStyle = await loadPublishPageUrlStyle(tx);
  if (pageUrlStyle === null) {
    throw new ReferenceCheckUnavailable(
      "no default deploy target — the link check needs the page URL style of the target Publish serves. " +
        "Next step: run the cms_admin migrations (they seed the production target) or mark a deploy target as default under Ops → Deploy.",
    );
  }
  const pluginScope =
    opts.pluginScopeBranchId === undefined ? opts.branchId : opts.pluginScopeBranchId;
  const pageRows = await loadPageRows(tx, opts.branchId);
  const lookup = await loadLinkTargetLookup(
    tx,
    opts.branchId,
    [],
    await activeImportTargets(tx, pluginScope),
    { pageRows },
  );
  const model = await loadReferenceSources(tx, opts.branchId, {
    pluginScopeBranchId: pluginScope,
    pageRows,
  });
  const pageVariants =
    lookup.targets.pages.length > 0 && hasLinkResolveContributors()
      ? await resolveLinkVariants(
          lookup.targets.pages.map((p) => p.id),
          { chatBranchId: pluginScope },
        )
      : undefined;
  return { model, lookup, pageUrlStyle, pageVariants };
}

/** The issues of a loaded scope under one environment's policy. */
function scanReferences(loaded: LoadedReferences, env: ReferenceCheckEnv): ReferenceIssue[] {
  const { model, lookup, pageUrlStyle, pageVariants } = loaded;
  const index = createSiteLinkIndex({
    pages: lookup.targets.pages,
    media: lookup.targets.media,
    env,
    pageUrlStyle,
    ...(pageVariants ? { pageVariants } : {}),
  });
  return scanReferenceIntegrity({ model, lookup, targets: lookup.targets, index, env });
}

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
  return scanReferences(await loadReferences(tx, opts), opts.env);
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
async function activeImportTargets(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<ActiveImportTargets | null> {
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
  const found: ActiveImportTargets[] = [];
  for (const b of branches) {
    const t = await loadActiveImportTargets(tx, b);
    if (t) found.push(t);
  }
  if (found.length <= 1) return found[0] ?? null;
  // Main line: every active run's planned pages at once.
  const runsByPath = new Map<string, string[]>();
  const rebuiltByPath = new Map<string, string>();
  for (const t of found) {
    for (const [path, runs] of t.runsByPath) {
      runsByPath.set(path, [...(runsByPath.get(path) ?? []), ...runs]);
    }
    for (const [path, pageId] of t.rebuiltByPath) rebuiltByPath.set(path, pageId);
  }
  return {
    runsByPath,
    rebuiltByPath,
    sourceHosts: [...new Set(found.flatMap((t) => t.sourceHosts))],
  };
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
 * The scope plugins answer the Stage gate in: the post-merge state.
 *
 * Plugin calls join the merge's transaction (#1254), so main already
 * shows the merge's own writes. When the merge took no plugin rows, the
 * plugins' storage is main — ask on main; asking as the branch would show
 * a selected-header Stage's unselected changes. When it took plugin rows,
 * it took every pending plugin row of the branch (the merge's
 * completeness check refuses anything less), so the branch view is the
 * post-merge plugin storage too — ask as the branch. Mirrors
 * `refreshLivePathsAfterMerge`, which composes post-merge paths the same way.
 */
export function stagePluginScope(
  mergedBranchId: string,
  opts: { readonly pluginRowsMerged: boolean },
): string | null {
  return opts.pluginRowsMerged ? mergedBranchId : null;
}

/**
 * The Stage gate: main line after the merge's replay, Stage policy.
 * Call inside the merge transaction, after the replay.
 *
 * @param opts.pluginRowsMerged whether the merge replayed plugin rows
 *   (see {@link stagePluginScope}).
 */
export async function stageReferenceGate(
  tx: TransactionRunner,
  mergedBranchId: string,
  opts: { readonly pluginRowsMerged: boolean },
): Promise<StageReferenceGate> {
  let issues: ReferenceIssue[];
  try {
    issues = await checkReferences(tx, {
      branchId: null,
      env: "staging",
      pluginScopeBranchId: stagePluginScope(mergedBranchId, opts),
    });
  } catch (e) {
    if (e instanceof ReferenceCheckUnavailable) return { ok: false, message: e.message };
    throw e;
  }
  const blocking = issues.filter((i) => i.severity === "block");
  if (blocking.length > 0) return { ok: false, message: refusalMessage(blocking) };
  return { ok: true, warnings: stageWarnings(issues) };
}

/** The refusal of a site whose stored references point at nothing. */
function refusalMessage(blocking: readonly ReferenceIssue[]): string {
  const listed = blocking
    .slice(0, STAGE_MESSAGE_ISSUES)
    .map((i, n) => `(${n + 1}) ${i.message}`)
    .join(" ");
  const more =
    blocking.length > STAGE_MESSAGE_ISSUES
      ? ` …and ${blocking.length - STAGE_MESSAGE_ISSUES} more (check_links lists every one).`
      : "";
  return `Stage refused — ${blocking.length} stored reference(s) point at a page, file, list, vocabulary entry or module that does not exist, so the build would ship broken links or content: ${listed}${more} Fix each one with the tool it names, then Stage again.`;
}

/** A link with no same-language target on a published page (#1240). */
function shipsAcrossLanguages(i: ReferenceIssue): boolean {
  return i.problem === "variant-missing" && i.shipped;
}

/** Warnings besides the language links, which the link notice reports. */
function stageWarnings(issues: readonly ReferenceIssue[]): string[] {
  return issues
    .filter((i) => !shipsAcrossLanguages(i))
    .slice(0, STAGE_WARNINGS)
    .map((i) => i.message);
}

/** The titles and paths a notice names, for the pages `issues` mention. */
async function noticePages(
  tx: TransactionRunner,
  issues: readonly ReferenceIssue[],
): Promise<Map<string, NoticePage>> {
  const ids = [
    ...new Set(
      issues.flatMap((i) => (i.targetPageId ? [i.targetPageId, ...i.pageIds] : [...i.pageIds])),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, title, current_path AS path FROM pages
    WHERE id = ANY(${uuidArray(ids)}) AND deleted_at IS NULL
  `)) as unknown as { id: string; title: string; path: string }[];
  return new Map(rows.map((r) => [r.id, { title: r.title, path: r.path }]));
}

/** What a build learns from the check before it starts. */
export type BuildReferenceGate =
  | {
      readonly ok: true;
      readonly warnings: string[];
      /** Staging: the language links this build renders; Publish live refuses them. */
      readonly notice: LinkNotice | null;
      /**
       * Staging: the same read under the Publish policy, which the Stage's
       * quality audit reports (`deploy_runs.reference_check`). Null for a
       * production build: it has no audit.
       */
      readonly audit: RecordedReferenceCheck | null;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The check where a build starts, over the main line it renders. Every
 * Stage and rebuild passes here, whatever it merged, so nothing the check
 * can name reaches the generator's render gate.
 *
 * Production refuses only what the generator cannot render (a deleted
 * target, a link with no same-language page). A draft target renders, and
 * whether one may ship is the quality gate's decision: an Owner can accept it.
 *
 * A staging build also scans the same read under the Publish policy for its
 * quality audit (#1594): the audit reports the links of the state the build
 * rendered, and reads the site no second time.
 *
 * Call inside a transaction, on the main line.
 */
export async function buildReferenceGate(
  tx: TransactionRunner,
  env: ReferenceCheckEnv,
): Promise<BuildReferenceGate> {
  let loaded: LoadedReferences;
  try {
    loaded = await loadReferences(tx, { branchId: null });
  } catch (e) {
    if (e instanceof ReferenceCheckUnavailable) return { ok: false, message: e.message };
    throw e;
  }
  const issues = scanReferences(loaded, env);
  const blocking = issues.filter(
    (i) => i.severity === "block" && i.problem !== "unpublished-target",
  );
  if (blocking.length > 0) {
    const language = blocking.filter(shipsAcrossLanguages);
    const notice = buildLinkNotice(language, await noticePages(tx, language));
    return {
      ok: false,
      message:
        notice !== null && language.length === blocking.length
          ? notice.operatorText
          : refusalMessage(blocking),
    };
  }
  const language = issues.filter(shipsAcrossLanguages);
  return {
    ok: true,
    warnings: stageWarnings(issues),
    notice: buildLinkNotice(language, await noticePages(tx, language)),
    audit:
      env === "staging"
        ? recordForAudit(scanReferences(loaded, "production"), pathsOf(loaded))
        : null,
  };
}

const placeSchema = z.looseObject({ kind: z.string() });

const problemSchema = z.enum(REFERENCE_PROBLEMS);

const issueSchema = z.object({
  problem: problemSchema,
  severity: z.enum(["block", "warning"]),
  target: z.string(),
  /** The page the link resolves to (null: a media file, a deleted page, no match). */
  targetPageId: z.string().nullable(),
  /** That page's path in the checked scope. */
  targetPath: z.string().nullable(),
  variant: z.string().nullable(),
  where: z.string(),
  place: placeSchema,
  pageIds: z.array(z.string()),
  pagePaths: z.array(z.string()),
  shipped: z.boolean(),
  area: z.string(),
  message: z.string(),
  fix: z.object({ tool: z.string(), hint: z.string() }),
});

type IssueView = z.infer<typeof issueSchema>;

/** Page id → path in the loaded scope. */
function pathsOf(loaded: LoadedReferences): ReadonlyMap<string, string> {
  return new Map(loaded.lookup.targets.pages.map((p) => [p.id, p.path]));
}

/** An issue as the op returns it and the audit record keeps it: with the scope's paths. */
function issueView(i: ReferenceIssue, paths: ReadonlyMap<string, string>): IssueView {
  return {
    ...i,
    place: { ...i.place },
    pageIds: [...i.pageIds],
    pagePaths: i.pageIds.map((id) => paths.get(id) ?? id),
    targetPath: i.targetPageId === null ? null : (paths.get(i.targetPageId) ?? null),
  };
}

/** Most issues the audit record keeps per list: what one `links.check_references` call returns. */
export const RECORDED_REFERENCE_ISSUES = 500;

/**
 * The problems of a link the staged build renders to a page a visitor of
 * live may not get: a draft target, or no page in the linking page's
 * language (#1240, staging renders the target in its own language).
 */
const DRAFT_LINK_PROBLEMS: ReadonlySet<ReferenceIssue["problem"]> = new Set([
  "unpublished-target",
  "variant-missing",
]);

/**
 * A staging build's link check under the Publish policy, recorded with the
 * run for its quality audit (#1594, `deploy_runs.reference_check`).
 */
export const recordedReferenceCheckSchema = z
  .object({
    /** Every issue, blocks first, cut at {@link RECORDED_REFERENCE_ISSUES}. */
    issues: z.array(issueSchema).max(RECORDED_REFERENCE_ISSUES),
    /** True when the check found more issues than `issues` keeps. */
    truncated: z.boolean(),
    /**
     * The draft and language links among them, cut the same way: the staged
     * build's `links` check skips what these already report.
     */
    draftLinks: z.array(issueSchema).max(RECORDED_REFERENCE_ISSUES),
  })
  .strict();

/** A parsed {@link recordedReferenceCheckSchema}. */
export type RecordedReferenceCheck = z.infer<typeof recordedReferenceCheckSchema>;

function recordForAudit(
  issues: readonly ReferenceIssue[],
  paths: ReadonlyMap<string, string>,
): RecordedReferenceCheck {
  return {
    issues: issues.slice(0, RECORDED_REFERENCE_ISSUES).map((i) => issueView(i, paths)),
    truncated: issues.length > RECORDED_REFERENCE_ISSUES,
    draftLinks: issues
      .filter((i) => DRAFT_LINK_PROBLEMS.has(i.problem))
      .slice(0, RECORDED_REFERENCE_ISSUES)
      .map((i) => issueView(i, paths)),
  };
}

export const checkReferencesInput = z
  .object({
    /**
     * Which gate to check for: `stage` (a draft target is a warning) or
     * `publish` (Publish live / promote: a draft target blocks).
     */
    for: z.enum(["stage", "publish"]).default("publish"),
    /** Only issues on this page (plus site-wide places: plugin data). */
    pageId: z.string().uuid().optional(),
    /** Same as pageId, by the page's path (`/about`). */
    pagePath: z.string().min(1).max(2000).optional(),
    /** False = blocking issues only. */
    includeWarnings: z.boolean().default(true),
    /** Only these problems (all when absent). */
    problems: z.array(problemSchema).min(1).optional(),
    limit: z.number().int().min(1).max(RECORDED_REFERENCE_ISSUES).default(100),
  })
  .strict();

export const checkReferencesOp = defineOperation({
  name: "links.check_references",
  // Why site-wide: a link check reads every link of the site by purpose.
  readScope: "site",
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
    let loaded: LoadedReferences;
    try {
      loaded = await loadReferences(tx, { branchId });
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
    const issues = scanReferences(loaded, env);
    const { lookup } = loaded;
    const paths = pathsOf(loaded);
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
        (input.problems === undefined || input.problems.includes(i.problem)) &&
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
      issues: matching.slice(0, input.limit).map((i) => issueView(i, paths)),
      truncated: matching.length > input.limit,
    });
  },
});

export const publishNoticeOp = defineOperation({
  name: "links.publish_notice",
  // Why site-wide: a link check reads every link of the site by purpose. It
  // is its own read, not part of pages.set_status(_many): those stay
  // O(request), and a status write must not fail on a link check.
  readScope: "site",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageIds: z.array(z.string().uuid()).min(1).max(5_000) }).strict(),
  output: z.object({ notice: linkNoticeSchema.nullable() }),
  handler: async (ctx, input, tx) => {
    let issues: ReferenceIssue[];
    try {
      issues = await checkReferences(tx, {
        branchId: ctx.chatBranchId ?? null,
        env: "production",
      });
    } catch (e) {
      if (e instanceof ReferenceCheckUnavailable) {
        return err({
          kind: "HandlerError",
          operation: "links.publish_notice",
          message: e.message,
        });
      }
      throw e;
    }
    const published = new Set(input.pageIds);
    const blocking = issues.filter(
      (i) => i.severity === "block" && i.pageIds.some((id) => published.has(id)),
    );
    return ok({ notice: buildLinkNotice(blocking, await noticePages(tx, blocking)) });
  },
});
