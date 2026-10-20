// SPDX-License-Identifier: MPL-2.0

/**
 * HTTP surface of the bug intake:
 *
 *   GET  /healthz              liveness
 *   POST /v1/installs          pin an install's public key (unsigned, TOFU)
 *   POST /v1/reports           one redacted report (signed)
 *   POST /v1/clusters/status   upstream state of known clusters (signed)
 *
 * Every refusal answers with `{ error, retryable }`, so the install knows
 * whether to keep the report queued (outage, rate limit) or stop (malformed,
 * unknown key).
 */

import {
  bugIntakeRegisterRequest,
  bugIntakeReport,
  bugIntakeStatusRequest,
} from "@caelo-cms/shared";
import { verifySignedRequest } from "./auth.js";
import { GitHubError } from "./github.js";
import { RateLimiter } from "./rate-limit.js";
import { IntakeRefusal, type IntakeService } from "./service.js";
import type { IntakeStore } from "./store.js";

/** Requests larger than this are refused before parsing; a full report is ~13 KB. */
const MAX_BODY_BYTES = 64 * 1024;

export interface IntakeHandlerDeps {
  service: IntakeService;
  store: IntakeStore;
  now?: () => number;
  /** Per client IP, for unsigned registrations. */
  registerLimiter?: RateLimiter;
  /** Per verified install, for reports and status refreshes. */
  installLimiter?: RateLimiter;
}

function refuse(status: number, error: string, retryable: boolean): Response {
  return Response.json({ error, retryable }, { status });
}

function clientIp(req: Request): string {
  // Cloud Run appends the caller's address as the last x-forwarded-for hop.
  return req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

export function createIntakeHandler(deps: IntakeHandlerDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const registerLimiter = deps.registerLimiter ?? new RateLimiter(20, 60 * 60_000);
  const installLimiter = deps.installLimiter ?? new RateLimiter(120, 60 * 60_000);

  return async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/healthz") return new Response("ok");
    if (req.method !== "POST") return refuse(404, "Not found.", false);

    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) return refuse(413, "Request too large.", false);
    const body = await req.text();
    if (body.length > MAX_BODY_BYTES) return refuse(413, "Request too large.", false);

    try {
      if (path === "/v1/installs") {
        if (!registerLimiter.take(clientIp(req), now())) {
          return refuse(429, "Too many registrations from this address.", true);
        }
        const parsed = bugIntakeRegisterRequest.safeParse(safeJson(body));
        if (!parsed.success)
          return refuse(400, `Invalid registration: ${parsed.error.message}`, false);
        await deps.service.register(parsed.data.installId, parsed.data.publicKey);
        return new Response(null, { status: 204 });
      }

      if (path === "/v1/reports" || path === "/v1/clusters/status") {
        const installId = await verifySignedRequest({
          store: deps.store,
          headers: req.headers,
          method: req.method,
          path,
          body,
          nowMs: now(),
        });
        if (!installLimiter.take(installId, now())) {
          return refuse(429, "Too many requests from this install; retry later.", true);
        }
        if (path === "/v1/reports") {
          const parsed = bugIntakeReport.safeParse(safeJson(body));
          if (!parsed.success) return refuse(400, `Invalid report: ${parsed.error.message}`, false);
          return Response.json(await deps.service.ingest(installId, parsed.data));
        }
        const parsed = bugIntakeStatusRequest.safeParse(safeJson(body));
        if (!parsed.success)
          return refuse(400, `Invalid status request: ${parsed.error.message}`, false);
        return Response.json({ clusters: await deps.service.status(parsed.data.clusterIds) });
      }

      return refuse(404, "Not found.", false);
    } catch (e) {
      if (e instanceof IntakeRefusal) {
        // An unregistered key is retryable: the install re-registers on its next run.
        return refuse(
          e.status,
          e.message,
          e.status === 401 && e.message.startsWith("Unknown install"),
        );
      }
      // GitHub outage or rate limit: the report is fine, the intake is not.
      console.error("[bug-intake]", path, e instanceof GitHubError ? e.message : e);
      return refuse(503, "The bug intake is temporarily unavailable; retry later.", true);
    }
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
