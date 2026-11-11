// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — a carried build's look for a stop. The request that asked
 * for the build passes the operator's Stop on through the build's order
 * (`build_orders.request_stop`), and the backstop asks a build to stop when
 * it gives the order up; the build runs inside its carrier's request, maybe
 * on another admin instance, so it looks at its order now and then.
 * Request-scoped: the watch lives exactly as long as the build's request,
 * and builds nothing itself (scripts/no-automatic-production-deploy.test.ts).
 *
 * One small read every few seconds for as long as the build runs (up to
 * 58 minutes): often enough that a Stop lands within seconds, rare enough
 * for the smallest database (#1392).
 */

import { execute } from "@caelo-cms/query-api";
import { describeError } from "../ai/tools/_describe-error.js";
import { type AdminJobDeps, REPORTING_JOB_CTX } from "../reporting-jobs/kind.js";

/** How often a running build looks at its order for a stop. */
const STOP_POLL_MS = 5_000;

/**
 * Abort `stop` with the order's stop reason once order `orderId` asks for a
 * stop: the operator's Stop, or the backstop's when it gave the order up.
 *
 * @returns the function that ends the watch.
 */
export function watchForStop(
  deps: AdminJobDeps,
  orderId: string,
  stop: AbortController,
  everyMs: number = STOP_POLL_MS,
): () => void {
  let looking = false;
  const watch = setInterval(() => {
    if (looking || stop.signal.aborted) return;
    looking = true;
    execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, "build_orders.get", { id: orderId })
      .then((r) => {
        if (!r.ok) throw new Error(describeError(r.error));
        const reason = (r.value as { order: { stopReason: string | null } | null }).order
          ?.stopReason;
        if (reason) stop.abort(new Error(reason));
      })
      .catch((e: unknown) => {
        console.error(
          `[build-carrier] ${orderId}: could not look for a stop:`,
          e instanceof Error ? e.message : String(e),
        );
      })
      .finally(() => {
        looking = false;
      });
  }, everyMs);
  return () => clearInterval(watch);
}
