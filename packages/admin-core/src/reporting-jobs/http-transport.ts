// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — how a job container reaches the admin: one POST per report
 * to `<admin origin>/api/internal/jobs/<kind>/report`, through the admin's
 * Google IAP.
 *
 * IAP lets a service account in with a JWT it signed itself, `aud` =
 * `<admin origin>/*` (cloud.google.com/iap/docs/authentication-howto) — the
 * path the scheduler tick's workflow and caelo-mcp take, because it works
 * on the Google-managed IAP client every install starts with. The job signs
 * as its own account through the IAM Credentials API (it holds
 * `roles/iam.serviceAccountTokenCreator` on itself and nothing else of IAM)
 * with the access token of the metadata server. The JWT is bound to the
 * origin the job reports to, so it is good for nothing else.
 *
 * The attempt's token rides in its own header (protocol.ts
 * `JOB_TOKEN_HEADER`); the admin needs both.
 */

import {
  defaultGoogleDeps,
  type GoogleDeps,
  googleCall,
} from "../security/operator-access/google-iam.js";
import type { ReportTransport } from "./job-reporter.js";
import {
  JOB_TIMING,
  JOB_TOKEN_HEADER,
  type ReportAnswer,
  type ReportingJobKind,
  reportOrigin,
  reportPath,
} from "./protocol.js";

/** Lifetime of one IAP credential. The admin's checks allow at most an hour. */
const IAP_JWT_LIFETIME_S = 600;

/**
 * A source of IAP credentials for `origin`, signed as this container's
 * service account; each is reused until a minute before it expires.
 */
export function serviceAccountIapCredential(
  origin: string,
  deps: GoogleDeps = defaultGoogleDeps(),
  now: () => number = () => Math.floor(Date.now() / 1000),
): () => Promise<string> {
  const audience = `${reportOrigin(origin)}/*`;
  let cached: { jwt: string; exp: number } | null = null;
  return async () => {
    const t = now();
    if (cached && cached.exp - 60 > t) return cached.jwt;
    const email = await deps.metadata("instance/service-accounts/default/email");
    const exp = t + IAP_JWT_LIFETIME_S;
    const signed = (await googleCall(
      deps,
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`,
      "POST",
      { payload: JSON.stringify({ iss: email, sub: email, aud: audience, iat: t, exp }) },
    )) as { signedJwt?: string };
    if (!signed.signedJwt) throw new Error("IAM signJwt answered without a signedJwt");
    cached = { jwt: signed.signedJwt, exp };
    return cached.jwt;
  };
}

/** The transport of a job container. */
export function httpReportTransport(opts: {
  readonly kind: ReportingJobKind;
  readonly adminUrl: string;
  readonly token: string;
  /** The IAP credential (`Authorization: Bearer …`). */
  readonly credential: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /**
   * One report's budget (default: the kind's `reportTimeoutSeconds` — a
   * source read of a large site takes a while, a build carrier's `run`
   * holds its request for as long as the build runs).
   */
  readonly timeoutMs?: number;
}): ReportTransport {
  const url = `${reportOrigin(opts.adminUrl)}${reportPath(opts.kind)}`;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? JOB_TIMING[opts.kind].reportTimeoutSeconds * 1000;
  return {
    label: url,
    async send(envelope) {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await opts.credential()}`,
          [JOB_TOKEN_HEADER]: opts.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.headers.get("x-goog-iap-generated-response") === "true") {
        // IAP answered, not the admin: the job's account is not (yet) on
        // the admin's IAP policy. Not retried; the converge restores it.
        return {
          status: res.status === 409 ? 403 : res.status,
          answer: {
            ok: false,
            error: {
              code: "iap-refused",
              message: `Google IAP refused the report (HTTP ${res.status}): this job's service account may not pass the admin's IAP — \`cms-provision upgrade\` grants it (${text.trim().slice(0, 200)})`,
            },
          },
        };
      }
      const answer = parseAnswer(res.status, text);
      // A long action's stream answers 200 and carries a refusal's status
      // inside (protocol.ts KEEPALIVE_SECONDS); the newlines before the
      // answer are JSON whitespace.
      const status =
        res.status === 200 && !answer.ok && typeof answer.status === "number"
          ? answer.status
          : res.status;
      return { status, answer };
    },
  };
}

function parseAnswer(status: number, text: string): ReportAnswer {
  try {
    const parsed = JSON.parse(text) as ReportAnswer;
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
  } catch {
    // fall through: not an answer of the report endpoint
  }
  return {
    ok: false,
    error: {
      code: "bad-answer",
      message: `HTTP ${status} without a report answer: ${text.trim().slice(0, 300)}`,
    },
  };
}
