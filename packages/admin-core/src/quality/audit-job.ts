// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 (#1140 category A) — the quality audit as a reporting job:
 * the whole audit of one Stage, run in its own container (Google Cloud: one
 * execution of the Cloud Run job `caelo-<env>-audit-run`) or, on
 * self-hosted and development installs, inside the admin's process — the
 * same function behind the same reports either way.
 *
 *   1. `start`: the admin claims the run and answers what to audit (the
 *      pages, the staged build's slot) or that there is nothing to do.
 *   2. The findings checks over every page and, when the Stage needs it,
 *      the Lighthouse fan-out to the audit task job (#875) — both read the
 *      staged build, never the database: what a check needs from the
 *      database it asks for with `source`, a plugin's contribution with
 *      `plugin-findings`.
 *   3. `result`: the outcome, which the admin records.
 *
 * Nothing here publishes or builds anything (CLAUDE.md §2, one path to
 * live): the admin records the result, and what follows an audit (the
 * chat's card, the gate of Publish live) reads that record.
 */

import type { JobReporter } from "../reporting-jobs/job-reporter.js";
import {
  deferAttempt,
  faultWatchingReporter,
  isPassingReportFault,
  JobStoppedError,
} from "../reporting-jobs/job-reporter.js";
import { type AuditStart, type PageIndexWire, pageIndexFromWire } from "./audit-job-wire.js";
import { type AuditReport, auditClaimedRun, type OriginEnv } from "./audit-run.js";
import type { LinkSources } from "./checks/links.js";
import {
  collectPluginFindings,
  type PluginAuditAnswer,
  type PluginAuditSource,
  withPluginAuditChecks,
} from "./checks/plugin-findings.js";
import type { ReferenceSources } from "./checks/references.js";
import {
  type CheckRegistry,
  createCoreCheckRegistry,
  type LighthouseRunner,
} from "./checks/registry.js";
import type { StructureSources } from "./checks/structure.js";
import { lighthouseRunnerFromEnv } from "./lighthouse-runner-select.js";

/** What a test hands the audit instead of its defaults. */
export interface AuditJobDeps {
  /**
   * The checks; core's (sources asked from the admin) plus the active
   * plugins' when omitted. A function gets the reporter its reads go through.
   */
  readonly checks?: CheckRegistry | ((reporter: JobReporter) => CheckRegistry);
  readonly runJob?: LighthouseRunner;
  readonly fetchPage?: typeof fetch;
  readonly env?: OriginEnv;
}

/**
 * The check sources, each read asked from the admin once per audit: the
 * structure and link checks read the same modules and layouts, and the
 * job holds nothing it could read them with.
 */
export function reportedCheckSources(reporter: JobReporter): {
  readonly structure: StructureSources;
  readonly links: LinkSources;
  readonly references: ReferenceSources;
} {
  const memo = new Map<string, Promise<unknown>>();
  const source = <T>(request: { readonly name: string } & Record<string, unknown>): Promise<T> => {
    const key = JSON.stringify(request);
    let answer = memo.get(key);
    if (!answer) {
      answer = reporter.call("source", request);
      memo.set(key, answer);
      // A failed read is asked again by the next check that needs it.
      answer.catch(() => memo.delete(key));
    }
    return answer as Promise<T>;
  };
  const structure: StructureSources = {
    modules: () => source({ name: "modules" }),
    layouts: () => source({ name: "layouts" }),
    pageIndex: async () => pageIndexFromWire(await source<PageIndexWire>({ name: "pageIndex" })),
  };
  return {
    structure,
    links: {
      modules: () => source({ name: "modules" }),
      layouts: () => source({ name: "layouts" }),
      redirects: () => source({ name: "redirects" }),
      siteUrls: () => source({ name: "siteUrls" }),
      reportedDraftLinks: () => source({ name: "reportedDraftLinks" }),
      neverLivePageIds: async (pageIds) =>
        new Set(await source<string[]>({ name: "neverLivePageIds", pageIds: [...pageIds] })),
    },
    references: {
      issues: (limit) => source({ name: "referenceIssues", limit }),
    },
  };
}

/** The active plugins' audit contributions, each call asked from the admin. */
export function reportedPluginAudit(
  reporter: JobReporter,
  contributors: readonly string[],
  siteUrls: () => Promise<readonly string[]>,
): PluginAuditSource {
  return {
    contributors: () => contributors,
    findings: (slug, pages, facts) =>
      collectPluginFindings(
        (args, label) => reporter.call<PluginAuditAnswer>("plugin-findings", { slug, label, args }),
        slug,
        pages,
        facts,
      ),
    siteUrls,
  };
}

/** Core's checks over reported sources, plus one check per contributing plugin. */
function auditChecks(reporter: JobReporter, contributors: readonly string[]): CheckRegistry {
  const sources = reportedCheckSources(reporter);
  const core = createCoreCheckRegistry({
    lighthouse: lighthouseRunnerFromEnv(process.env),
    structure: sources.structure,
    links: sources.links,
    references: sources.references,
  });
  return withPluginAuditChecks(
    core,
    reportedPluginAudit(reporter, contributors, sources.links.siteUrls),
  );
}

/** One attempt of a Stage's quality audit (see the file comment). */
export async function runQualityAuditJob(
  reporter: JobReporter,
  deps: AuditJobDeps = {},
): Promise<void> {
  const start = await reporter.call<AuditStart>("start");
  if (start.kind === "stop") {
    console.log(`[quality-audit-job] ${reporter.subjectId}: nothing to audit (${start.reason})`);
    return;
  }
  // Every read goes through a reporter that remembers a passing fault, so a
  // read the admin could not answer in time spoils the attempt even when a
  // check turned it into a check error.
  const watched = faultWatchingReporter(reporter);
  let report: AuditReport | null = null;
  let failure: unknown = null;
  try {
    const checks =
      typeof deps.checks === "function"
        ? deps.checks(watched.reporter)
        : (deps.checks ?? auditChecks(watched.reporter, start.pluginContributors));
    report = await auditClaimedRun(start.run, {
      checks,
      ...(deps.runJob ? { runJob: deps.runJob } : {}),
      ...(deps.fetchPage ? { fetchPage: deps.fetchPage } : {}),
      ...(deps.env ? { env: deps.env } : {}),
    });
  } catch (e) {
    if (e instanceof JobStoppedError) throw e;
    failure = e;
  }
  // A read still in flight means a check stopped waiting for it (it timed
  // out first): the outcome raced the admin, whatever the read ends with.
  // Let every read end, so a fault it ends with is seen, then give the
  // attempt back.
  const raced = watched.inFlight();
  if (raced.length > 0) await watched.settled();
  const fault = watched.fault() ?? (isPassingReportFault(failure) ? failure : null);
  if (fault !== null || raced.length > 0) {
    // The admin was starting, busy, unreachable or slower than a check for
    // one of the audit's reads: another attempt may get the answer in time.
    // Give this one back with the reason; the next tick starts the next
    // attempt, and after the last one the audit fails with that reason.
    // Nothing spoiled is recorded.
    await deferAttempt(
      reporter,
      fault !== null
        ? fault instanceof Error
          ? fault.message
          : String(fault)
        : `a check stopped waiting for the admin's answer to ${[...new Set(raced)].join(", ")}`,
    );
  }
  await reporter.call(
    "result",
    report ?? {
      // A bug in the audit itself: recorded as the audit's failure, never
      // left to the backstop's retries (it would fail the same way again).
      baseUrl: null,
      outcome: {
        kind: "failed",
        code: "worker-crashed",
        message: failure instanceof Error ? failure.message : String(failure),
      },
    },
  );
}
