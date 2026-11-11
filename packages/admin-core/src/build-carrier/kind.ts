// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — the build carrier, as the reporting-job foundation (#1359)
 * knows it: kind `build`, whose one action `run` holds its request while
 * the admin runs the ordered build inside it (run-order.ts). The job's
 * side is job.ts; how a request asks for a carried build is carry.ts.
 *
 * One attempt: a carrier that dies ends its build, and the backstop records
 * the order as failed with where it ran and the next step. An order whose
 * carrier never started is given up the same way, never started late: a
 * build a person asked for minutes ago is not run behind their back, and
 * the tick never starts a build (scripts/no-automatic-production-deploy.test.ts).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import {
  type AdminJobDeps,
  REPORTING_JOB_CTX,
  type ReportingJobKindDef,
} from "../reporting-jobs/kind.js";
import { runBuildOrder } from "./run-order.js";

/** The admin env var naming the build carrier's Cloud Run job (Google Cloud). */
export const BUILD_CARRIER_JOB_ENV_VAR = "CAELO_BUILD_CARRIER_JOB";

/** The admin env var naming the service account the carrier's reports pass IAP as. */
export const BUILD_CARRIER_SERVICE_ACCOUNT_ENV_VAR = "CAELO_BUILD_CARRIER_SERVICE_ACCOUNT";

/**
 * How long a queued order may wait for its carrier's job before the
 * backstop gives it up. The request that writes the order starts the
 * carrier at once; an order still without a job after this lost its start.
 */
const UNSTARTED_AFTER_SECONDS = 120;

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

export const buildCarrierJobKind: ReportingJobKindDef = {
  kind: "build",
  label: "build",
  gcp: {
    jobEnvVar: BUILD_CARRIER_JOB_ENV_VAR,
    serviceAccountEnvVar: BUILD_CARRIER_SERVICE_ACCOUNT_ENV_VAR,
  },
  pendingIssue: {
    aws: "issue #749: an ECS task that carries a build's request",
    azure: "issue #750: a Container Apps job that carries a build's request",
  },
  // In-process the admin has CPU between requests: two builds do not wait
  // on each other (their publish leases order them, as before).
  inProcess: "at-once",
  unstarted: "give-up",
  actions: {
    run: {
      long: true,
      input: z.object({}).strict(),
      handle: (deps, orderId, _input, request) => runBuildOrder(deps, orderId, request),
    },
  },

  async listUnstarted(deps, limit) {
    const r = await op<{ ids: string[] }>(deps, "build_orders.list_unstarted", {
      limit,
      olderThanSeconds: UNSTARTED_AFTER_SECONDS,
    });
    return r.ids;
  },

  async giveUp(deps, orderId, message) {
    await op(deps, "build_orders.give_up", {
      id: orderId,
      message: `The build stopped without its result: ${message}.`.slice(0, 2000),
    });
  },
};
