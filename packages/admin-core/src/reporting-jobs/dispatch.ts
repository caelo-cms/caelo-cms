// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the admin's side of one report: admit it, validate it, run
 * the action, answer. The report endpoint (apps/admin
 * `api/internal/jobs/[kind]/report`) calls it after the job's IAP identity
 * was checked; a job running inside the admin (self-hosted, development)
 * reaches the same function directly (in-process.ts). Both pass the body as
 * text, so the same caps and the same parsing apply to both.
 *
 * Two steps (#1574): `admitJobReport` checks everything a report brings and
 * answers a refusal with its status; the admitted report's `run` then runs
 * the action. Between them the endpoint learns whether the action is long
 * (the build carrier's `run`) and answers it as a stream that keeps the
 * request busy; the action's signal aborts when the job's request ended.
 *
 * Everything a job sends is checked here before anything acts on it: the
 * envelope, the attempt and its token (`reporting_jobs.authorize`), the
 * rate, and the action's own schema. A job is the admin's own code, but it
 * reads what it reports from pages it fetched — the site-import crawl's from
 * third-party sites — so its reports are handled as untrusted data
 * (docs/dev/reporting-jobs.md).
 */

import { execute, type QueryError } from "@caelo-cms/query-api";
import { describeError } from "../ai/tools/_describe-error.js";
import {
  ActionRefusal,
  type AdminJobDeps,
  REPORTING_JOB_CTX,
  type ReportingJobKindDef,
} from "./kind.js";
import { reportingJobKind } from "./kinds.js";
import {
  deferSchema,
  hashJobToken,
  isReportingJobKind,
  JOB_TIMING,
  MAX_REPORT_BODY_BYTES,
  REPORTS_PER_MINUTE,
  type ReportAnswer,
  type ReportEnvelope,
  reportEnvelopeSchema,
  uploadPartSchema,
} from "./protocol.js";

/** One report as the endpoint received it. */
export interface ReportRequest {
  /** The kind from the URL. */
  readonly kind: string;
  /** The token header's value, or null. */
  readonly token: string | null;
  /** The body as text, read under {@link MAX_REPORT_BODY_BYTES}. */
  readonly bodyText: string;
}

/** The answer and its HTTP status. */
export interface ReportResponse {
  readonly status: number;
  readonly answer: ReportAnswer;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function refused(status: number, code: string, message: string): ReportResponse {
  return { status, answer: { ok: false, error: { code, message } } };
}

function answered(value: unknown): ReportResponse {
  return { status: 200, answer: { ok: true, value } };
}

/** Run one op as the system actor; a failure throws with its description. */
async function op(deps: AdminJobDeps, name: string, input: unknown): Promise<unknown> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new OpFailure(name, r.error);
  return r.value;
}

class OpFailure extends Error {
  constructor(
    readonly opName: string,
    readonly error: QueryError,
  ) {
    super(`${opName} failed: ${describeError(error)}`);
    this.name = "OpFailure";
  }
}

/**
 * A report the admin admitted: its envelope, token, rate and input passed.
 * What is left is the action itself.
 */
export interface AdmittedReport {
  /**
   * The action holds its request while the admin works (kind.ts `long`):
   * the endpoint answers it as a stream that keeps the request busy.
   */
  readonly long: boolean;
  /**
   * Run the action and answer. Never throws: every failure is an answer.
   *
   * @param signal - aborts when the job's request ended before the answer.
   */
  run(signal?: AbortSignal): Promise<ReportResponse>;
}

/** An admission: the report's runner, or the answer that refuses it. */
export type ReportAdmission =
  | { readonly admitted: AdmittedReport }
  | { readonly refused: ReportResponse };

/**
 * Admit one report: everything before its action runs (the envelope, the
 * attempt and its token, the rate, an upload's parts, the action's input).
 * Never throws: every refusal is an answer, with its status.
 */
export async function admitJobReport(
  deps: AdminJobDeps,
  request: ReportRequest,
): Promise<ReportAdmission> {
  const refusal = (r: ReportResponse): ReportAdmission => ({ refused: r });
  if (!isReportingJobKind(request.kind)) {
    return refusal(refused(404, "unknown-kind", `no reporting job of kind "${request.kind}"`));
  }
  const def = reportingJobKind(request.kind);
  if (Buffer.byteLength(request.bodyText, "utf8") > MAX_REPORT_BODY_BYTES) {
    return refusal(
      refused(
        413,
        "too-large",
        `a report carries at most ${MAX_REPORT_BODY_BYTES} bytes; send larger inputs in parts (upload-part)`,
      ),
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(request.bodyText);
  } catch {
    return refusal(refused(400, "bad-json", "the report is not JSON"));
  }
  const parsed = reportEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return refusal(refused(400, "bad-envelope", issuesOf(parsed.error)));
  }
  const envelope = parsed.data;
  if (!request.token || !TOKEN.test(request.token)) {
    return refusal(refused(401, "missing-token", "the report carries no attempt token"));
  }
  try {
    const admitted = (await op(deps, "reporting_jobs.authorize", {
      kind: def.kind,
      subjectId: envelope.subjectId,
      attempt: envelope.attempt,
      tokenHash: hashJobToken(request.token),
      leaseSeconds: JOB_TIMING[def.kind].leaseSeconds,
      ratePerMinute: REPORTS_PER_MINUTE,
    })) as { admitted: true } | { admitted: false; reason: string; retryAfterSeconds?: number };
    if (!admitted.admitted) {
      switch (admitted.reason) {
        case "stale":
          return refusal(refused(409, "stale", "a newer attempt replaced this one: stop"));
        case "finished":
          return refusal(refused(409, "finished", `the ${def.label} is over: stop`));
        case "rate-limited":
          return refusal({
            status: 429,
            answer: {
              ok: false,
              error: {
                code: "rate-limited",
                message: `more than ${REPORTS_PER_MINUTE} reports this minute`,
              },
              retryAfterSeconds: admitted.retryAfterSeconds ?? 60,
            },
          });
        default:
          return refusal(refused(401, "not-admitted", "no such attempt, or not its token"));
      }
    }
    return await prepareAction(deps, def, envelope);
  } catch (e) {
    return refusal(failure(def, envelope, e));
  }
}

/**
 * Handle one report: admit it, then run its action (a job inside the
 * admin's process, and tests). Never throws: every failure is an answer.
 */
export async function handleJobReport(
  deps: AdminJobDeps,
  request: ReportRequest,
  signal?: AbortSignal,
): Promise<ReportResponse> {
  const admission = await admitJobReport(deps, request);
  if ("refused" in admission) return admission.refused;
  return admission.admitted.run(signal);
}

/** The answer to an action that threw: a refusal is a 422, anything else a 500. */
function failure(def: ReportingJobKindDef, envelope: ReportEnvelope, e: unknown): ReportResponse {
  if (e instanceof ActionRefusal) return refused(422, "refused", e.message.slice(0, 2000));
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[reporting-jobs] ${def.kind} ${envelope.subjectId} ${envelope.action}:`, message);
  return refused(500, "failed", message.slice(0, 2000));
}

/** An admission whose answer is ready (the shared actions, a refused input). */
function answeredNow(response: ReportResponse): ReportAdmission {
  return { admitted: { long: false, run: async () => response } };
}

/**
 * The shared actions run here, at admission (they are short). A kind's own
 * action is checked here (its upload read, its input parsed) and runs when
 * the endpoint calls `run`.
 */
async function prepareAction(
  deps: AdminJobDeps,
  def: ReportingJobKindDef,
  envelope: ReportEnvelope,
): Promise<ReportAdmission> {
  const { subjectId, attempt } = envelope;
  switch (envelope.action) {
    case "heartbeat":
      return answeredNow(answered({}));
    case "upload-part": {
      const part = uploadPartSchema.safeParse(envelope.payload);
      if (!part.success) return answeredNow(refused(400, "bad-input", issuesOf(part.error)));
      try {
        await op(deps, "reporting_jobs.put_upload_part", {
          kind: def.kind,
          subjectId,
          attempt,
          ...part.data,
        });
      } catch (e) {
        if (e instanceof OpFailure && isRefusal(e.error)) {
          return answeredNow(refused(413, "too-large", describeError(e.error)));
        }
        throw e;
      }
      return answeredNow(answered({}));
    }
    case "defer": {
      const d = deferSchema.safeParse(envelope.payload);
      if (!d.success) return answeredNow(refused(400, "bad-input", issuesOf(d.error)));
      await op(deps, "reporting_jobs.release", {
        kind: def.kind,
        subjectId,
        attempt,
        // Read as "the last attempt deferred: …" when the work is given up.
        reason: `deferred: ${d.data.reason}`,
      });
      return answeredNow(answered({}));
    }
    default:
      break;
  }
  const action = def.actions[envelope.action];
  if (!action) {
    return answeredNow(
      refused(404, "unknown-action", `a ${def.label} job has no action "${envelope.action}"`),
    );
  }
  let raw: unknown = envelope.payload ?? {};
  if (envelope.upload) {
    let text: string;
    try {
      text = (
        (await op(deps, "reporting_jobs.read_upload", {
          kind: def.kind,
          subjectId,
          attempt,
          uploadId: envelope.upload.uploadId,
          parts: envelope.upload.parts,
        })) as { text: string }
      ).text;
    } catch (e) {
      if (e instanceof OpFailure && isRefusal(e.error)) {
        return answeredNow(refused(400, "incomplete-upload", describeError(e.error)));
      }
      throw e;
    }
    try {
      raw = JSON.parse(text);
    } catch {
      return answeredNow(refused(400, "bad-json", "the uploaded input is not JSON"));
    }
  }
  const input = action.input.safeParse(raw);
  if (!input.success) return answeredNow(refused(400, "bad-input", issuesOf(input.error)));
  return {
    admitted: {
      long: action.long === true,
      async run(signal) {
        try {
          const result = await action.handle(deps, subjectId, input.data, signal ? { signal } : {});
          if (result.done) {
            await op(deps, "reporting_jobs.finish", {
              kind: def.kind,
              subjectId,
              attempt,
              outcome: result.done.outcome,
              note: result.done.note ?? null,
            });
          }
          return answered(result.value);
        } catch (e) {
          return failure(def, envelope, e);
        }
      },
    },
  };
}

function isRefusal(error: QueryError): boolean {
  return error.kind === "HandlerError" && error.refusal === true;
}

/** The first few issues of a failed parse, for the job's log. */
function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(input)"}: ${i.message}`)
    .join("; ");
}
