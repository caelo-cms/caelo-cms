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
 * index of a big site) is not bound by a response-size limit. Every refusal
 * is the endpoint's answer (401, 413, 4xx from the dispatch), so the job
 * tells a permanent refusal from a passing fault.
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

/**
 * A refusal, returned and never thrown: SvelteKit answers a thrown plain
 * `Response` with a 500, which the job would retry as a passing fault.
 */
function refusal(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Null when a report of `kind` may go on, else the 401 to answer: its IAP
 * identity must be the kind's service account.
 */
export async function authorizeJobReport(
  request: Request,
  kind: ReportingJobKind,
  env: Record<string, string | undefined> = process.env,
): Promise<Response | null> {
  const def = reportingJobKind(kind);
  const expected = env[def.gcp.serviceAccountEnvVar]?.trim().toLowerCase();
  if (!expected) {
    return refusal(
      401,
      "no-job-identity",
      `this admin takes no ${def.label} reports over HTTP (${def.gcp.serviceAccountEnvVar} is not set): its jobs run inside the admin`,
    );
  }
  const verified = await iapVerifier()(request.headers.get(IAP_ASSERTION_HEADER));
  if (!verified.ok || verified.identity.email.toLowerCase() !== expected) {
    return refusal(401, "not-the-job", `only the ${def.label}'s job may report here`);
  }
  return null;
}

/**
 * The request body as text, at most `max` bytes, or the 413 to answer.
 * Counted as it streams in, so a lying or missing Content-Length cannot
 * make the admin buffer more.
 */
export async function readReportBody(
  request: Request,
  max: number = MAX_REPORT_BODY_BYTES,
): Promise<{ readonly text: string } | { readonly refused: Response }> {
  const tooLarge = () => ({
    refused: refusal(
      413,
      "too-large",
      `a report carries at most ${max} bytes; send larger inputs in parts`,
    ),
  });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return tooLarge();
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return tooLarge();
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/** Answer one report (see the file comment). */
export async function answerJobReport(request: Request, kind: ReportingJobKind): Promise<Response> {
  const unauthorized = await authorizeJobReport(request, kind);
  if (unauthorized) return unauthorized;
  const body = await readReportBody(request);
  if ("refused" in body) return body.refused;
  const bodyText = body.text;
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
