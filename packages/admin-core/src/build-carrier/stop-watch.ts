// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — a carried build's look for the operator's Stop. The request
 * that asked for the build passes the Stop on through the build's order
 * (`build_orders.request_stop`); the build runs inside its carrier's
 * request, maybe on another admin instance, so it looks at its order now
 * and then. Request-scoped: the watch lives exactly as long as the build's
 * request, and builds nothing itself (scripts/no-automatic-production-deploy.test.ts).
 */

import { execute } from "@caelo-cms/query-api";
import { describeError } from "../ai/tools/_describe-error.js";
import { type AdminJobDeps, REPORTING_JOB_CTX } from "../reporting-jobs/kind.js";

/** How often a running build looks for the operator's Stop on its order. */
const STOP_POLL_MS = 2_000;

/**
 * Abort `stop` once order `orderId` asks for a stop.
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
        const order = (r.value as { order: { stopRequested: boolean } | null }).order;
        if (order?.stopRequested) stop.abort(new Error("the operator stopped it"));
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
