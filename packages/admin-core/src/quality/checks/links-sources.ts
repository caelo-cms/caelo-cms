// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — the link check's sources, read through the Query API as the
 * audit worker's system actor (no chat branch, so main: the state the
 * staged build was rendered from — the same reasoning as
 * structure-sources.ts, whose module and layout reads it shares).
 *
 * The stored-link issues come from the link check the audited build
 * recorded where it started (#1594, `quality_audits.reference_check`), not
 * from a second read of the whole site.
 *
 * A failed read throws: the runner reports the check as failed and the
 * audit fails loudly instead of reading as "no findings".
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../../ai/tools/_describe-error.js";
import type { LinkSources, ReportedDraftLink, ReportedDraftLinkOrigin } from "./links.js";
import type { RedirectRow } from "./links-analysis.js";
import type { ReferenceCheckIssue, ReferenceSources } from "./references.js";
import { readSiteUrls, structureSourcesFromOps } from "./structure-sources.js";

/** `pages.list`'s maximum `pageIds`. */
const PAGES_PER_LIST = 1000;

/** The recorded check, as far as these sources read it. */
export interface RecordedLinkIssues {
  readonly issues: readonly ReportedIssue[];
  readonly truncated: boolean;
  readonly draftLinks: readonly ReportedIssue[];
}

/** One recorded issue (`links.check_references`' issue shape). */
type ReportedIssue = ReferenceCheckIssue & {
  readonly place: { readonly kind: string } & Record<string, unknown>;
  readonly targetPath: string | null;
};

/** Reads the recorded link check of the build an audit audits. */
export type RecordedLinkCheck = () => Promise<RecordedLinkIssues>;

/**
 * The link check the build of `auditRunId` recorded where it started
 * (#1594), read through `quality_audits.reference_check` once and shared by
 * the `links` and `references` checks.
 */
export function recordedLinkCheckFromOps(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  auditRunId: string,
): RecordedLinkCheck {
  let read: Promise<RecordedLinkIssues> | null = null;
  return () => {
    if (read === null) {
      const reading = execute(registry, adapter, ctx, "quality_audits.reference_check", {
        auditRunId,
      }).then((r) => {
        if (!r.ok) {
          throw new Error(`quality_audits.reference_check failed: ${describeError(r.error)}`);
        }
        return r.value as RecordedLinkIssues;
      });
      read = reading;
      // A failed read is read again by the next check that needs it.
      reading.catch(() => {
        if (read === reading) read = null;
      });
    }
    return read;
  };
}

/**
 * What renders a stored link (reference-fix.ts `ReferencePlace`), in the
 * terms the staged HTML carries.
 */
function originOf(place: ReportedIssue["place"]): ReportedDraftLinkOrigin {
  switch (place.kind) {
    case "content":
    case "module-html":
    case "module-default":
    case "module-field":
      return { kind: "module", moduleId: String(place.moduleId) };
    case "list":
    case "list-type":
    case "page":
      return { kind: "list-data" };
    case "layout-html":
    case "template-html":
      return { kind: "chrome" };
    case "plugin":
      return { kind: "plugin", pluginSlug: String(place.pluginSlug) };
    default:
      throw new Error(`links.check_references returned an unknown place kind "${place.kind}"`);
  }
}

/** Sources backed by the Query API. */
export function linkSourcesFromOps(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  recorded: RecordedLinkCheck,
): LinkSources {
  const run = async (op: string, input: unknown): Promise<unknown> => {
    const r = await execute(registry, adapter, ctx, op, input);
    if (!r.ok) throw new Error(`${op} failed: ${describeError(r.error)}`);
    return r.value;
  };
  const structure = structureSourcesFromOps(registry, adapter, ctx);
  return {
    modules: structure.modules,
    layouts: structure.layouts,
    async redirects() {
      // #1550 — what staging serves: the live rows (every stored spelling)
      // with the Staged changes the staged build serves, exactly as the
      // staging gateway computes it. Drafts and changes waiting for their
      // target are left out.
      const plan = (await run("redirects.release_plan", { includeRows: true })) as {
        rows: RedirectRow[] | null;
        problem: string | null;
      };
      if (plan.problem !== null || plan.rows === null) {
        throw new Error(`redirects.release_plan: ${plan.problem ?? "returned no rows"}`);
      }
      return plan.rows.map((r) => ({
        fromPath: r.fromPath,
        toPath: r.toPath,
        statusCode: r.statusCode,
      }));
    },
    async reportedDraftLinks() {
      // Every unpublished-target issue (warnings included: a draft page's
      // own link is skipped too, it is not in the build), and every link
      // with no same-language target: staging renders it to the target in
      // its own language, which may be a draft (#1240). Past the record's
      // limit the rest is simply not skipped — reported twice, never lost.
      const r = await recorded();
      return r.draftLinks.flatMap((i): ReportedDraftLink[] => {
        const origin = originOf(i.place);
        return i.targetPath !== null
          ? [{ targetPath: i.targetPath, pageIds: i.pageIds, origin }]
          : [];
      });
    },
    async neverLivePageIds(pageIds) {
      const neverLive = new Set<string>();
      for (let i = 0; i < pageIds.length; i += PAGES_PER_LIST) {
        const r = (await run("pages.list", {
          pageIds: pageIds.slice(i, i + PAGES_PER_LIST),
        })) as { pages: { id: string; firstPublishedAt: string | null }[] };
        for (const p of r.pages) if (p.firstPublishedAt === null) neverLive.add(p.id);
      }
      return neverLive;
    },
    siteUrls: () => readSiteUrls((op, input) => run(op, input)),
  };
}

/**
 * #724 (rollout F) — the `references` check's source: the build's recorded
 * link check (#1594), main line under the Publish-live policy.
 */
export function referenceSourcesOf(recorded: RecordedLinkCheck): ReferenceSources {
  return {
    async issues(limit) {
      const r = await recorded();
      return {
        issues: r.issues.slice(0, limit),
        truncated: r.truncated || r.issues.length > limit,
      };
    },
  };
}
