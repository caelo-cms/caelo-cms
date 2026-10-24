// SPDX-License-Identifier: MPL-2.0

/**
 * Retry for gcloud IAM writes that fail transiently: a service account
 * created seconds ago is not yet bindable, and concurrent writers to the
 * same IAM policy lose the etag race. Anything else fails fast — a
 * PERMISSION_DENIED does not get better by waiting.
 */

import type { GcloudResult } from "./gcloud.js";

/**
 * Runs one gcloud command; `stdin` feeds secret payloads (`--data-file=-`),
 * `env` replaces the base environment (default: this process's).
 */
export type GcloudRunner = (
  args: string[],
  opts?: { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv },
) => Promise<GcloudResult>;
export type Sleep = (ms: number) => Promise<void>;

/** Errors worth retrying: propagation delay and policy write races. */
const TRANSIENT = /does not exist|not found|NOT_FOUND|concurrent|etag|ABORTED|409/i;
const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000];

export const realSleep: Sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `args`, retrying with backoff while the failure looks transient. */
export async function runWithRetry(
  run: GcloudRunner,
  sleep: Sleep,
  args: string[],
): Promise<GcloudResult> {
  let r = await run(args);
  for (const delay of RETRY_DELAYS_MS) {
    if (r.ok || !TRANSIENT.test(r.stderr)) break;
    await sleep(delay);
    r = await run(args);
  }
  return r;
}

/**
 * gcloud's wording for a call against an API that is not enabled on the
 * project — also for the few minutes after `services enable` returned,
 * until the enablement has propagated ("Cloud KMS API has not been used in
 * project N before or it is disabled … (reason: SERVICE_DISABLED)", #1060).
 * Shared with default-firewall.ts, which reads it as "Compute Engine is off".
 */
export const SERVICE_NOT_ENABLED =
  /SERVICE_DISABLED|accessNotConfigured|has not been used in project|it is disabled/i;

/**
 * Backoff while a just-enabled API propagates: ~3.5 minutes in total, the
 * window Google documents for enablement to reach every endpoint.
 */
export const SERVICE_ENABLE_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
];

/**
 * Wrap `run` so a call that fails with {@link SERVICE_NOT_ENABLED} is
 * retried with {@link SERVICE_ENABLE_DELAYS_MS} backoff. Every other result
 * (success or a different failure) returns at once; when the backoff is
 * exhausted the last failure is returned unchanged, so the caller can still
 * tell the operator that the API never came up.
 */
export function retryWhileServiceEnabling(run: GcloudRunner, sleep: Sleep): GcloudRunner {
  return async (args, opts) => {
    let r = await run(args, opts);
    for (const delay of SERVICE_ENABLE_DELAYS_MS) {
      if (r.ok || !SERVICE_NOT_ENABLED.test(r.stderr)) break;
      await sleep(delay);
      r = await run(args, opts);
    }
    return r;
  };
}
