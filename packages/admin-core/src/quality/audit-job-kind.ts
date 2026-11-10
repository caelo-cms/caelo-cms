// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the admin's side of the quality audit's job: what it
 * answers to each report (quality/audit-job-wire.ts names them), how the
 * backstop finds an audit without a job, and how it records one whose job
 * kept dying. The job's side is quality/audit-job.ts.
 *
 * Every answer is read through the Query API as the system actor, the
 * same reads the audit made when it ran in the admin (the check sources,
 * plugin-host's audit hook); every outcome is recorded by
 * `quality_audits.record_result`, the same op as before. The job adds a
 * transport, not a second write path.
 */

import { auditFindingContributors, pluginAuditFindingsCall } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { auditOutcomeSchema } from "../ops/quality/record-result.js";
import {
  ActionRefusal,
  type AdminJobDeps,
  REPORTING_JOB_CTX,
  type ReportingJobKindDef,
} from "../reporting-jobs/kind.js";
import {
  type AuditSourceRequest,
  type AuditStart,
  auditPluginCallSchema,
  auditSourceRequestSchema,
  pageIndexToWire,
} from "./audit-job-wire.js";
import type { ClaimedAuditRun } from "./audit-run.js";
import { linkSourcesFromOps, referenceSourcesFromOps } from "./checks/links-sources.js";
import { structureSourcesFromOps } from "./checks/structure-sources.js";

/** The admin env var naming the audit's Cloud Run job (Google Cloud). */
export const AUDIT_RUNNER_JOB_ENV_VAR = "CAELO_AUDIT_RUNNER_JOB";

/** The admin env var naming the service account the audit's reports pass IAP as. */
export const AUDIT_RUNNER_SERVICE_ACCOUNT_ENV_VAR = "CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT";

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

type ClaimState = "claimed" | "resumed" | "superseded" | "settled" | "missing";

const STOP_REASONS: Readonly<Record<Exclude<ClaimState, "claimed" | "resumed">, string>> = {
  superseded: "a newer Stage replaced its build; that Stage's audit covers its pages",
  settled: "the audit has ended already",
  missing: "the audit was deleted (its Stage's build run was)",
};

/** Answer one `source` read with the same op reads the in-admin audit made. */
async function readSource(deps: AdminJobDeps, request: AuditSourceRequest): Promise<unknown> {
  const { registry, adapter } = deps;
  const structure = structureSourcesFromOps(registry, adapter, REPORTING_JOB_CTX);
  const links = linkSourcesFromOps(registry, adapter, REPORTING_JOB_CTX);
  switch (request.name) {
    case "modules":
      return structure.modules();
    case "layouts":
      return structure.layouts();
    case "pageIndex":
      return pageIndexToWire(await structure.pageIndex());
    case "redirects":
      return links.redirects();
    case "siteUrls":
      return links.siteUrls();
    case "reportedDraftLinks":
      return links.reportedDraftLinks();
    case "neverLivePageIds":
      return [...(await links.neverLivePageIds(request.pageIds))];
    case "referenceIssues":
      return referenceSourcesFromOps(registry, adapter, REPORTING_JOB_CTX).issues(request.limit);
  }
}

/** The quality audit's kind of reporting job. */
export const qualityAuditJobKind: ReportingJobKindDef = {
  kind: "quality_audit",
  label: "quality audit",
  gcp: {
    jobEnvVar: AUDIT_RUNNER_JOB_ENV_VAR,
    serviceAccountEnvVar: AUDIT_RUNNER_SERVICE_ACCOUNT_ENV_VAR,
  },
  pendingIssue: {
    aws: "issue #749: an ECS task per audit",
    azure: "issue #750: a Container Apps job per audit",
  },
  // One audit at a time in-process: two would share the CPU their Lighthouse runs measure.
  inProcess: "in-line",
  unstarted: "start",
  actions: {
    start: {
      input: z.object({}).strict(),
      async handle(deps, subjectId) {
        const claimed = await op<{ state: ClaimState; run: ClaimedAuditRun | null }>(
          deps,
          "quality_audits.claim",
          { auditRunId: subjectId },
        );
        if (claimed.state === "claimed" || claimed.state === "resumed") {
          if (!claimed.run) throw new Error(`quality_audits.claim ${claimed.state} without a run`);
          const value: AuditStart = {
            kind: "run",
            run: claimed.run,
            // Read per audit: activating or archiving a plugin changes what
            // the next Stage's audit runs without a restart (CLAUDE.md §2).
            pluginContributors: auditFindingContributors(),
          };
          return { value };
        }
        const reason = STOP_REASONS[claimed.state];
        const value: AuditStart = { kind: "stop", reason };
        return { value, done: { outcome: "stopped", note: reason } };
      },
    },
    source: {
      input: auditSourceRequestSchema,
      async handle(deps, _subjectId, input: AuditSourceRequest) {
        return { value: await readSource(deps, input) };
      },
    },
    "plugin-findings": {
      input: auditPluginCallSchema,
      async handle(_deps, _subjectId, input: z.infer<typeof auditPluginCallSchema>) {
        if (!auditFindingContributors().includes(input.slug)) {
          throw new ActionRefusal(
            `plugin "${input.slug}" no longer contributes audit findings (it was deactivated while the audit ran)`,
          );
        }
        try {
          return {
            value: await pluginAuditFindingsCall(
              input.slug,
              input.args as Parameters<typeof pluginAuditFindingsCall>[1],
              input.label,
            ),
          };
        } catch (e) {
          // The plugin's own failure or a malformed answer: asking again
          // changes nothing, so the job's plugin check fails with it.
          throw new ActionRefusal(e instanceof Error ? e.message : String(e));
        }
      },
    },
    result: {
      input: z.object({ baseUrl: z.string().nullable(), outcome: auditOutcomeSchema }).strict(),
      async handle(deps, subjectId, input) {
        const r = await execute(
          deps.registry,
          deps.adapter,
          REPORTING_JOB_CTX,
          "quality_audits.record_result",
          { auditRunId: subjectId, baseUrl: input.baseUrl, outcome: input.outcome },
        );
        if (r.ok) {
          const recorded = r.value as { status: string; problemCount: number };
          return {
            value: recorded,
            done: { outcome: recorded.status === "discarded" ? "stopped" : "completed" },
          };
        }
        // The job sends a result again when it lost the answer to the first:
        // that one was recorded, and the audit is no longer running.
        const now = await op<{ run: { status: string; problemCount: number } | null }>(
          deps,
          "quality_audits.get",
          { auditRunId: subjectId },
        );
        if (now.run && now.run.status !== "running" && now.run.status !== "queued") {
          return {
            value: { status: now.run.status, problemCount: now.run.problemCount },
            done: { outcome: "completed", note: "the result was recorded by an earlier report" },
          };
        }
        throw new Error(`quality_audits.record_result failed: ${describeError(r.error)}`);
      },
    },
  },

  async listUnstarted(deps, limit) {
    const r = await op<{ auditRunIds: string[] }>(deps, "quality_audits.sweep_unstarted", {
      limit,
    });
    return r.auditRunIds;
  },

  async giveUp(deps, subjectId, message) {
    const claimed = await op<{ state: ClaimState }>(deps, "quality_audits.claim", {
      auditRunId: subjectId,
    });
    if (claimed.state !== "claimed" && claimed.state !== "resumed") return;
    await op(deps, "quality_audits.record_result", {
      auditRunId: subjectId,
      baseUrl: null,
      outcome: { kind: "failed", code: "job-failed", message },
    });
  },
};
