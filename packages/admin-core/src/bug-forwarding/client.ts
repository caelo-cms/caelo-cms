// SPDX-License-Identifier: MPL-2.0

/**
 * HTTP client for the Caelo bug intake (epic #901). Signs every request with
 * the install's Ed25519 key (see shared/bug-intake.ts for the contract) and
 * maps each answer to one of three outcomes the worker acts on:
 *
 *   ok     — the intake accepted the request
 *   retry  — try again later (network error, timeout, 429, 5xx, or an error
 *            body the intake marked retryable)
 *   failed — the intake refused this request for good (4xx, malformed answer)
 *
 * Never called inside a database transaction.
 */

import {
  BUG_INTAKE_HEADERS,
  BUG_INTAKE_PROTOCOL_VERSION,
  type BugIntakeClusterInfo,
  type BugIntakeReport,
  bugIntakeErrorResponse,
  bugIntakeReportResponse,
  bugIntakeSigningString,
  bugIntakeStatusResponse,
  CAELO_VERSION,
} from "@caelo-cms/shared";
import type { z } from "zod";

/** Where installs send reports; `CAELO_BUG_INTAKE_URL` points a fork or a test at another intake. */
export const DEFAULT_BUG_INTAKE_URL = "https://bugs.caelo-cms.com";

const REQUEST_TIMEOUT_MS = 10_000;

export type IntakeOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "retry"; error: string }
  | { kind: "failed"; error: string };

/** The install's signing identity, as `bug_forwarding.identity` returns it. */
export interface IntakeIdentity {
  installId: string;
  publicKey: string;
  privateKeyPkcs8: string;
}

export interface BugIntakeClientOpts {
  baseUrl: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
}

/** Resolve the intake URL from the environment. */
export function bugIntakeUrl(env: Record<string, string | undefined>): string {
  return (env.CAELO_BUG_INTAKE_URL ?? DEFAULT_BUG_INTAKE_URL).replace(/\/+$/, "");
}

export class BugIntakeClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(opts: BugIntakeClientOpts) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  /** Pin the install's public key at the intake (trust on first use). */
  register(identity: IntakeIdentity): Promise<IntakeOutcome<null>> {
    const body = JSON.stringify({
      protocolVersion: BUG_INTAKE_PROTOCOL_VERSION,
      installId: identity.installId,
      publicKey: identity.publicKey,
      caeloVersion: CAELO_VERSION,
    });
    return this.#post("/v1/installs", body, null, () => null);
  }

  /** Send one redacted report; the answer names the cluster it joined. */
  sendReport(
    identity: IntakeIdentity,
    report: BugIntakeReport,
  ): Promise<IntakeOutcome<BugIntakeClusterInfo>> {
    return this.#post("/v1/reports", JSON.stringify(report), identity, (json) =>
      bugIntakeReportResponse.parse(json),
    );
  }

  /** Refresh the upstream status of clusters this install reported into. */
  clusterStatus(
    identity: IntakeIdentity,
    clusterIds: string[],
  ): Promise<IntakeOutcome<BugIntakeClusterInfo[]>> {
    const body = JSON.stringify({ protocolVersion: BUG_INTAKE_PROTOCOL_VERSION, clusterIds });
    return this.#post(
      "/v1/clusters/status",
      body,
      identity,
      (json) => bugIntakeStatusResponse.parse(json).clusters,
    );
  }

  async #post<T>(
    path: string,
    body: string,
    identity: IntakeIdentity | null,
    parse: (json: unknown) => T,
  ): Promise<IntakeOutcome<T>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `caelo-cms/${CAELO_VERSION}`,
    };
    if (identity) {
      const timestamp = String(this.#now());
      headers[BUG_INTAKE_HEADERS.installId] = identity.installId;
      headers[BUG_INTAKE_HEADERS.timestamp] = timestamp;
      headers[BUG_INTAKE_HEADERS.signature] = await sign(
        identity.privateKeyPkcs8,
        await bugIntakeSigningString({ method: "POST", path, timestamp, body }),
      );
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { kind: "retry", error: `bug intake unreachable: ${(e as Error).message}` };
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return { kind: "ok", value: parse(text === "" ? null : JSON.parse(text)) };
      } catch (e) {
        return {
          kind: "failed",
          error: `bug intake answered malformed JSON: ${(e as Error).message}`,
        };
      }
    }
    return { kind: classify(res.status, text), error: describe(res.status, text) };
  }
}

function classify(status: number, text: string): "retry" | "failed" {
  const parsed = parseError(text);
  if (parsed) return parsed.retryable ? "retry" : "failed";
  return status === 429 || status >= 500 ? "retry" : "failed";
}

function describe(status: number, text: string): string {
  const parsed = parseError(text);
  return `bug intake HTTP ${status}: ${parsed?.error ?? text.slice(0, 300)}`;
}

function parseError(text: string): z.infer<typeof bugIntakeErrorResponse> | null {
  try {
    const r = bugIntakeErrorResponse.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

async function sign(privateKeyPkcs8: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(privateKeyPkcs8, "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message));
  return Buffer.from(sig).toString("base64");
}
