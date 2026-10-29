// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — where this admin's server-side browser renders run.
 *
 *   gcp, gcp-firebase  the capture job (one short-lived Cloud Run execution
 *                      per render); no Chromium in the admin container.
 *   self-hosted, dev   in-process, one render at a time (capture-slot.ts):
 *                      no extra machines to put it on.
 *   aws, azure         nowhere yet — refused with the tracking issue, the
 *                      same honest gap the quality audit has there (#875).
 *
 * A cloud install whose job is not configured is refused too, never rendered
 * in-process instead: the in-process render is exactly the memory spike that
 * killed the admin (no fallbacks pre-1.0).
 */

import {
  CAPTURE_JOB_ENV_VAR,
  type CaptureClient,
  createCaptureClient,
  gcpCaptureLauncher,
} from "./capture-client.js";
import { CAPTURE_BUCKET_ENV_VAR, gcsCaptureStore, MEDIA_BUCKET_ENV_VAR } from "./capture-store.js";

export type CaptureBackend =
  | { readonly kind: "in-process" }
  | { readonly kind: "job"; readonly client: CaptureClient }
  | { readonly kind: "unavailable"; readonly message: string };

/** Where each provider's missing capture job is tracked (its stack's FIXME). */
const PENDING_CAPTURE_JOB_ISSUE: Readonly<Record<string, string>> = {
  aws: "issue #749: a Fargate task per capture",
  azure: "issue #750: a Container Apps job per capture",
};

/** The backend for an admin with this environment. Pure apart from building clients. */
export function captureBackendFromEnv(env: NodeJS.ProcessEnv): CaptureBackend {
  const provider = env.CAELO_PROVIDER ?? "";
  if (provider === "" || provider === "self-hosted") return { kind: "in-process" };
  if (provider === "gcp" || provider === "gcp-firebase") {
    const job = env[CAPTURE_JOB_ENV_VAR]?.trim();
    const bucket = env[CAPTURE_BUCKET_ENV_VAR]?.trim();
    const media = env[MEDIA_BUCKET_ENV_VAR]?.trim();
    if (!job || !bucket || !media) {
      return {
        kind: "unavailable",
        message: `server-side screenshots are not set up on this install (${CAPTURE_JOB_ENV_VAR} / ${CAPTURE_BUCKET_ENV_VAR} / ${MEDIA_BUCKET_ENV_VAR} missing on the admin) — the operator runs \`cms-provision upgrade\``,
      };
    }
    try {
      return {
        kind: "job",
        client: createCaptureClient({
          launcher: gcpCaptureLauncher(job),
          store: gcsCaptureStore(bucket, media),
        }),
      };
    } catch (e) {
      return { kind: "unavailable", message: e instanceof Error ? e.message : String(e) };
    }
  }
  return {
    kind: "unavailable",
    message: `server-side screenshots have no capture job on provider "${provider}" yet (${PENDING_CAPTURE_JOB_ISSUE[provider] ?? "no tracking issue"}); the admin does not run a browser itself on a cloud install`,
  };
}

let current: CaptureBackend | null = null;

/** This process's backend, read from its environment once. */
export function captureBackend(): CaptureBackend {
  current ??= captureBackendFromEnv(process.env);
  return current;
}

/** Test seam — pin the backend (null re-reads the environment). */
export function setCaptureBackendForTests(next: CaptureBackend | null): void {
  current = next;
}
