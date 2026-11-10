// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — what the admin knows about one kind of reporting job: what
 * it does with each report, where the job runs, and how it finds work that
 * has no job and gives up work whose last attempt died. Each kind's file
 * declares one (the quality audit: quality/audit-job-kind.ts);
 * `reporting-jobs/kinds.ts` lists them. The timings both sides share are in
 * protocol.ts (`JOB_TIMING`).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { z } from "zod";
import type { ReportingJobKind } from "./protocol.js";

/** The admin process's handles, as every report handler gets them. */
export interface AdminJobDeps {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}

/** The system actor every report runs as (no person, no AI). */
export const REPORTING_JOB_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "reporting-job",
};

/** What a report handler answers, and whether the work is over with it. */
export interface ActionResult {
  /** The JSON value the job gets back. */
  readonly value: unknown;
  /**
   * Set when this report ends the work: the job's row is finished and no
   * later report is admitted. `completed` — the result is recorded;
   * `stopped` — there is nothing (left) to do (superseded, deleted).
   */
  readonly done?: { readonly outcome: "completed" | "stopped"; readonly note?: string };
}

/**
 * A report the admin cannot act on for a reason that sending it again
 * would not change (a plugin that is not active, an answer the plugin got
 * wrong): the job gets a 422 with the message and does not retry it.
 */
export class ActionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionRefusal";
  }
}

/** What a report handler knows about the request it answers. */
export interface ActionRequest {
  /**
   * Aborts when the job's request ended before the answer (the job died,
   * or its connection dropped). Absent for a job inside the admin's process.
   */
  readonly signal?: AbortSignal;
}

/** One action a job of this kind may report. */
export interface ReportingAction<I = unknown> {
  /** The input's schema, checked before `handle` runs (a job's data is untrusted). */
  readonly input: z.ZodType<I>;
  /**
   * The action holds its request while the admin works (the build carrier's
   * `run`, #1574): it is answered as a stream that keeps the request busy
   * until the answer (protocol.ts `KEEPALIVE_SECONDS`).
   */
  readonly long?: boolean;
  handle(
    deps: AdminJobDeps,
    subjectId: string,
    input: I,
    request: ActionRequest,
  ): Promise<ActionResult>;
}

/** Everything the admin needs to run one kind of reporting job. */
export interface ReportingJobKindDef {
  readonly kind: ReportingJobKind;
  /** How messages name the work ("quality audit"). */
  readonly label: string;
  /**
   * Google Cloud: the admin env vars naming the kind's Cloud Run job
   * (`projects/<p>/locations/<r>/jobs/<j>`) and the service account its
   * reports must pass IAP as.
   */
  readonly gcp: { readonly jobEnvVar: string; readonly serviceAccountEnvVar: string };
  /** What `aws` / `azure` lack for it, for the refusal (#749, #750). */
  readonly pendingIssue: Readonly<Record<"aws" | "azure", string>>;
  /**
   * Inside the admin's process (self-hosted, development): `in-line` runs
   * one attempt of the kind at a time (in-line.ts says why), `at-once`
   * starts each attempt when it is launched.
   */
  readonly inProcess: "in-line" | "at-once";
  /**
   * What the backstop does with work that has no job ({@link listUnstarted}):
   * `start` it late, or `give-up` — work a person asked for and waits on (a
   * build) is never started minutes after the request that asked for it.
   */
  readonly unstarted: "start" | "give-up";
  /** The kind's own actions (the shared ones: protocol.ts FOUNDATION_ACTIONS). */
  // biome-ignore lint/suspicious/noExplicitAny: each action narrows its own input with its schema.
  readonly actions: Readonly<Record<string, ReportingAction<any>>>;
  /**
   * Work that should run and has no job: queued and never started (the
   * start was lost), or started by a release before reporting jobs.
   */
  listUnstarted(deps: AdminJobDeps, limit: number): Promise<readonly string[]>;
  /**
   * Record the work as failed: its last attempt died, or it cannot run on
   * this install. Idempotent; work that already ended stays as it is.
   */
  giveUp(deps: AdminJobDeps, subjectId: string, message: string): Promise<void>;
}
