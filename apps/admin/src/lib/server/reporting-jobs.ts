// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the admin's door for reporting jobs:
 * `POST /api/internal/jobs/<kind>/report`, called by a job container
 * (Google Cloud: one execution of the kind's Cloud Run job) for every
 * report it sends.
 *
 * Two checks, both required, before anything reads the body's meaning:
 *
 *   1. the request passed the admin's IAP as the kind's own service
 *      account: IAP's signed assertion names exactly
 *      `<kind's service-account env var>` (the quality audit:
 *      `CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT`). An install without that var
 *      runs its jobs in-process (self-hosted, development) and takes no
 *      report over HTTP at all;
 *   2. the attempt's token (`x-caelo-job-token`), checked with the attempt
 *      and the rate by admin-core `handleJobReport`.
 *
 * The body is read with a hard cap (`MAX_REPORT_BODY_BYTES`): a larger
 * input travels in parts. The answer is streamed, so a large read (the page
 * index of a big site) is not bound by a response-size limit.
 */

import {
  handleJobReport,
  IAP_ASSERTION_HEADER,
  iapVerifier,
  JOB_TOKEN_HEADER,
  MAX_REPORT_BODY_BYTES,
  type ReportingJobKind,
  reportingJobKind,
} from "@caelo-cms/admin-core";
import { getQueryContext } from "#lib/server/query.js";

function refuse(status: number, code: string, message: string): never {
  throw new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Let a report of `kind` through, or throw a 401 Response: its IAP
 * identity must be the kind's service account.
 */
export async function authorizeJobReport(
  request: Request,
  kind: ReportingJobKind,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const def = reportingJobKind(kind);
  const expected = env[def.gcp.serviceAccountEnvVar]?.trim().toLowerCase();
  if (!expected) {
    refuse(
      401,
      "no-job-identity",
      `this admin takes no ${def.label} reports over HTTP (${def.gcp.serviceAccountEnvVar} is not set): its jobs run inside the admin`,
    );
  }
  const verified = await iapVerifier()(request.headers.get(IAP_ASSERTION_HEADER));
  if (!verified.ok || verified.identity.email.toLowerCase() !== expected) {
    refuse(401, "not-the-job", `only the ${def.label}'s job may report here`);
  }
}

/**
 * The request body as text, at most `max` bytes; a longer one is a 413.
 * Counted as it streams in, so a lying or missing Content-Length cannot
 * make the admin buffer more.
 */
export async function readReportBody(
  request: Request,
  max: number = MAX_REPORT_BODY_BYTES,
): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  const tooLarge = () =>
    refuse(413, "too-large", `a report carries at most ${max} bytes; send larger inputs in parts`);
  if (Number.isFinite(declared) && declared > max) tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Answer one report (see the file comment). */
export async function answerJobReport(request: Request, kind: ReportingJobKind): Promise<Response> {
  await authorizeJobReport(request, kind);
  const bodyText = await readReportBody(request);
  const { adapter, registry } = getQueryContext();
  const { status, answer } = await handleJobReport(
    { adapter, registry },
    { kind, token: request.headers.get(JOB_TOKEN_HEADER), bodyText },
  );
  // Streamed (no Content-Length): Cloud Run caps buffered answers at 32 MiB.
  return new Response(new Blob([JSON.stringify(answer)]).stream(), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
