// SPDX-License-Identifier: MPL-2.0

/**
 * #818 — `cms-provision request-update --version <v> [--wait]` — install a
 * Caelo release with the install's own upgrader job, exactly as the Owner's
 * "Install update" does, from a terminal or a CI runner.
 *
 * Why it exists: the release workflow's real-GCP upgrader smoke test
 * (.github/workflows/upgrader-smoke.yml) must drive the REAL job — its
 * image, its service account, its IAM self-check, the migrations and the
 * roll on Cloud Run — for every release candidate, and Settings → Updates
 * never offers a release candidate (the release check follows GitHub's
 * newest stable release). It is also how an operator installs an RC.
 *
 * Same channel and root of trust as `owner-reset` (admin-internal.ts):
 * whoever can read the install's internal secret and sign as caelo-mcp
 * already controls its project, so queueing an update grants nothing new.
 * The admin queues the request (`platform_updates.operator_request`) and
 * starts the job; the job still verifies the signed release manifest and
 * refuses a downgrade or an infrastructure change by itself.
 *
 * With `--wait` the command follows the request's timeline until it ends
 * and exits non-zero unless it succeeded — what the smoke test asserts.
 */

import { isFinishedUpdateStatus, type PlatformUpdateStatusValue } from "@caelo-cms/shared";
import {
  type AdminInternalDeps,
  type AdminInternalResult,
  type AdminInternalTarget,
  callAdminInternal,
} from "./admin-internal.js";
import { gcloud as defaultGcloud } from "./gcloud.js";
import { readGcloudAccount } from "./owner-reset.js";

/** Token scope the admin endpoint checks (apps/admin …/api/internal/platform-update). */
export const PLATFORM_UPDATE_SCOPE = "platform_updates.operator";
const ENDPOINT = "/api/internal/platform-update";
const INTRODUCED_BY = "#818";

/** The request as the admin reports it (platform_updates.get). */
export interface OperatorUpdateRequest {
  readonly id: string;
  readonly targetVersion: string;
  readonly fromVersion: string;
  readonly status: PlatformUpdateStatusValue;
  readonly statusReason: string | null;
  readonly refusalCodes: readonly string[];
  readonly execution: string | null;
}

/** One timeline line. */
export interface OperatorUpdateEvent {
  readonly id: number;
  readonly at: string;
  readonly phase: string;
  readonly level: string;
  readonly message: string;
}

/** Queue `version` and start the upgrader; returns the request and the job run. */
export async function requestPlatformUpdate(
  target: AdminInternalTarget,
  version: string,
  deps: AdminInternalDeps = {},
): Promise<AdminInternalResult<{ requestId: string; execution: string }>> {
  const account = await readGcloudAccount(deps.run ?? defaultGcloud);
  if (!account.ok) return account;
  const r = await callAdminInternal<{ requestId?: string; execution?: string }>(
    target,
    {
      endpoint: ENDPOINT,
      scope: PLATFORM_UPDATE_SCOPE,
      body: { action: "request", version, requestedBy: account.value },
      introducedBy: INTRODUCED_BY,
    },
    deps,
  );
  if (!r.ok) return r;
  const { requestId, execution } = r.value.answer;
  if (!requestId || !execution) {
    return { ok: false, error: "the admin answered without a request id or an upgrader run" };
  }
  return { ok: true, value: { requestId, execution } };
}

/** The request and its timeline so far. */
export async function platformUpdateStatus(
  target: AdminInternalTarget,
  requestId: string,
  deps: AdminInternalDeps = {},
): Promise<
  AdminInternalResult<{ request: OperatorUpdateRequest; events: readonly OperatorUpdateEvent[] }>
> {
  const r = await callAdminInternal<{
    request?: OperatorUpdateRequest | null;
    events?: OperatorUpdateEvent[];
  }>(
    target,
    {
      endpoint: ENDPOINT,
      scope: PLATFORM_UPDATE_SCOPE,
      body: { action: "status", requestId },
      introducedBy: INTRODUCED_BY,
    },
    deps,
  );
  if (!r.ok) return r;
  const { request, events } = r.value.answer;
  if (!request) return { ok: false, error: `the admin knows no update request ${requestId}` };
  return { ok: true, value: { request, events: events ?? [] } };
}

export interface WaitOptions {
  /** Give up (and fail) after this long; the job's own task timeout is 60 minutes. */
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Each timeline line, once, in order. */
  readonly onEvent: (e: OperatorUpdateEvent) => void;
}

/**
 * Follow request `requestId` until it ends. A failed status read is retried
 * until the deadline: the admin itself is replaced during the roll, so a
 * few refused or unreachable polls are expected.
 *
 * @returns the ended request, or why it could not be followed to its end
 */
export async function waitForPlatformUpdate(
  target: AdminInternalTarget,
  requestId: string,
  opts: WaitOptions,
  deps: AdminInternalDeps = {},
): Promise<AdminInternalResult<OperatorUpdateRequest>> {
  const deadline = opts.now() + opts.timeoutMs;
  let lastEvent = 0;
  let lastError = "no answer yet";
  while (opts.now() < deadline) {
    const r = await platformUpdateStatus(target, requestId, deps);
    if (r.ok) {
      for (const e of r.value.events) {
        if (e.id > lastEvent) {
          opts.onEvent(e);
          lastEvent = e.id;
        }
      }
      if (isFinishedUpdateStatus(r.value.request.status))
        return { ok: true, value: r.value.request };
    } else {
      lastError = r.error;
    }
    await opts.sleep(opts.intervalMs);
  }
  return {
    ok: false,
    error: `update request ${requestId} did not end within ${Math.round(opts.timeoutMs / 60_000)} minutes (last status read: ${lastError})`,
  };
}

/** The lines printed for the end of a request. Pure. */
export function describeUpdateEnd(r: OperatorUpdateRequest): string[] {
  if (r.status === "succeeded") {
    return [`Caelo ${r.targetVersion} is installed (from ${r.fromVersion}).`];
  }
  return [
    `The update to ${r.targetVersion} ended as ${r.status}${r.refusalCodes.length ? ` (${r.refusalCodes.join(", ")})` : ""}.`,
    ...(r.statusReason ? [r.statusReason] : []),
  ];
}
