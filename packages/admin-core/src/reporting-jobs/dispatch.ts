// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the admin's side of one report: admit it, validate it, run
 * the action, answer. The report endpoint (apps/admin
 * `api/internal/jobs/[kind]/report`) calls it after the job's IAP identity
 * was checked; a job running inside the admin (self-hosted, development)
 * reaches the same function directly (in-process.ts). Both pass the body as
 * text, so the same caps and the same parsing apply to both.
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

/** Handle one report. Never throws: every failure is an answer. */
export async function handleJobReport(
  deps: AdminJobDeps,
  request: ReportRequest,
): Promise<ReportResponse> {
  if (!isReportingJobKind(request.kind)) {
    return refused(404, "unknown-kind", `no reporting job of kind "${request.kind}"`);
  }
  const def = reportingJobKind(request.kind);
  if (Buffer.byteLength(request.bodyText, "utf8") > MAX_REPORT_BODY_BYTES) {
    return refused(
      413,
      "too-large",
      `a report carries at most ${MAX_REPORT_BODY_BYTES} bytes; send larger inputs in parts (upload-part)`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(request.bodyText);
  } catch {
    return refused(400, "bad-json", "the report is not JSON");
  }
  const parsed = reportEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return refused(400, "bad-envelope", issuesOf(parsed.error));
  }
  const envelope = parsed.data;
  if (!request.token || !TOKEN.test(request.token)) {
    return refused(401, "missing-token", "the report carries no attempt token");
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
          return refused(409, "stale", "a newer attempt replaced this one: stop");
        case "finished":
          return refused(409, "finished", `the ${def.label} is over: stop`);
        case "rate-limited":
          return {
            status: 429,
            answer: {
              ok: false,
              error: {
                code: "rate-limited",
                message: `more than ${REPORTS_PER_MINUTE} reports this minute`,
              },
              retryAfterSeconds: admitted.retryAfterSeconds ?? 60,
            },
          };
        default:
          return refused(401, "not-admitted", "no such attempt, or not its token");
      }
    }
    return await runAction(deps, def, envelope);
  } catch (e) {
    if (e instanceof ActionRefusal) return refused(422, "refused", e.message.slice(0, 2000));
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[reporting-jobs] ${def.kind} ${envelope.subjectId} ${envelope.action}:`,
      message,
    );
    return refused(500, "failed", message.slice(0, 2000));
  }
}

async function runAction(
  deps: AdminJobDeps,
  def: ReportingJobKindDef,
  envelope: ReportEnvelope,
): Promise<ReportResponse> {
  const { subjectId, attempt } = envelope;
  switch (envelope.action) {
    case "heartbeat":
      return answered({});
    case "upload-part": {
      const part = uploadPartSchema.safeParse(envelope.payload);
      if (!part.success) return refused(400, "bad-input", issuesOf(part.error));
      try {
        await op(deps, "reporting_jobs.put_upload_part", {
          kind: def.kind,
          subjectId,
          attempt,
          ...part.data,
        });
      } catch (e) {
        if (e instanceof OpFailure && isRefusal(e.error)) {
          return refused(413, "too-large", describeError(e.error));
        }
        throw e;
      }
      return answered({});
    }
    case "defer": {
      const d = deferSchema.safeParse(envelope.payload);
      if (!d.success) return refused(400, "bad-input", issuesOf(d.error));
      await op(deps, "reporting_jobs.release", {
        kind: def.kind,
        subjectId,
        attempt,
        // Read as "the last attempt deferred: …" when the work is given up.
        reason: `deferred: ${d.data.reason}`,
      });
      return answered({});
    }
    default:
      break;
  }
  const action = def.actions[envelope.action];
  if (!action) {
    return refused(404, "unknown-action", `a ${def.label} job has no action "${envelope.action}"`);
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
        return refused(400, "incomplete-upload", describeError(e.error));
      }
      throw e;
    }
    try {
      raw = JSON.parse(text);
    } catch {
      return refused(400, "bad-json", "the uploaded input is not JSON");
    }
  }
  const input = action.input.safeParse(raw);
  if (!input.success) return refused(400, "bad-input", issuesOf(input.error));
  const result = await action.handle(deps, subjectId, input.data);
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
