// SPDX-License-Identifier: MPL-2.0

/**
 * Retry for gcloud IAM writes that fail transiently: a service account
 * created seconds ago is not yet bindable, and concurrent writers to the
 * same IAM policy lose the etag race. Anything else fails fast — a
 * PERMISSION_DENIED does not get better by waiting.
 */

import type { GcloudResult } from "./gcloud.js";

/** Runs one gcloud command; `stdin` feeds secret payloads (`--data-file=-`). */
export type GcloudRunner = (
  args: string[],
  opts?: { readonly stdin?: string },
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
