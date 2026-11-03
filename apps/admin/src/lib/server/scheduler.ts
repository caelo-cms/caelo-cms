// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — the admin's side of the scheduler tick: who may call it,
 * and what one tick runs.
 *
 * `POST /api/internal/scheduler/tick` is called by the install's scheduler:
 *
 *   - Google Cloud: one Cloud Scheduler job starts a Cloud Workflows
 *     execution, which signs a service-account JWT as the install's
 *     scheduler account and posts through the admin's IAP
 *     (packages/provisioning/src/scheduler-setup.ts says why not Cloud
 *     Scheduler's own OIDC token). IAP admits the account and stamps the
 *     request with its signed assertion; {@link authorizeSchedulerTick}
 *     accepts that assertion only when it names
 *     `CAELO_SCHEDULER_SERVICE_ACCOUNT`.
 *   - self-hosted: the `caelo-scheduler` Compose service
 *     (admin-core scheduler/clock.ts) posts with the internal HMAC token,
 *     scope `scheduler.tick`.
 *
 * Either credential reaches the same tick: the core maintenance tasks and
 * every active plugin worker (admin-core scheduler/), run inside the
 * request so they use the CPU the request is billed for.
 */

import { hostname } from "node:os";
import {
  BugIntakeClient,
  bugIntakeUrl,
  coreScheduledTasks,
  IAP_ASSERTION_HEADER,
  iapVerifier,
  type PublicProjectionPublisher,
  pluginWorkerTasks,
  runSchedulerTick,
  type SchedulerTickReport,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext, PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import { requireInternalAuth } from "#lib/server/internal-jwt.js";
import { getQueryContext } from "#lib/server/query.js";
import { releaseManifestReader } from "#lib/server/release-check.js";
import { convergeTrigger, upgraderTrigger } from "#lib/server/upgrader.js";
import { updatesProvider } from "#lib/upgrade-path.js";

/** The internal token scope of the tick (the self-hosted clock signs the same). */
export const SCHEDULER_TICK_SCOPE = "scheduler.tick";

/** The admin env var naming the scheduler's service account (Google Cloud). */
export const SCHEDULER_SERVICE_ACCOUNT_ENV = "CAELO_SCHEDULER_SERVICE_ACCOUNT";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "scheduler",
};

/**
 * Let the tick through, or throw a 401 Response.
 *
 * The scheduler's IAP identity is checked first: through IAP the workflow's
 * `Authorization` header carries its IAP credential, which is not an
 * internal token. Any other caller (another IAP identity, no IAP at all)
 * needs the internal token.
 */
export async function authorizeSchedulerTick(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<"scheduler-identity" | "internal-token"> {
  const schedulerAccount = env[SCHEDULER_SERVICE_ACCOUNT_ENV]?.trim().toLowerCase();
  const assertion = request.headers.get(IAP_ASSERTION_HEADER);
  if (schedulerAccount && assertion) {
    const verified = await iapVerifier()(assertion);
    if (verified.ok && verified.identity.email.toLowerCase() === schedulerAccount) {
      return "scheduler-identity";
    }
  }
  await requireInternalAuth(request, SCHEDULER_TICK_SCOPE);
  return "internal-token";
}

let projectionPublisher: PublicProjectionPublisher | null = null;

/** The plugin-host boot hands over the process's projection publisher (hooks.server.ts). */
export function setSchedulerProjectionPublisher(publisher: PublicProjectionPublisher): void {
  projectionPublisher = publisher;
}

let ticks = 0;

/**
 * Run one tick over the core tasks and the active plugin workers. The plugin
 * host has booted: hooks.server.ts awaits it before any request.
 */
export async function runAdminSchedulerTick(
  env: Record<string, string | undefined> = process.env,
): Promise<SchedulerTickReport> {
  const { adapter, registry } = getQueryContext();
  const provider = updatesProvider(env);
  const readManifest = releaseManifestReader();
  const instance = `${env.K_REVISION ?? hostname()}/${process.pid}`;
  // Same upgrader the Owner's "Install update" uses: the Cloud Run job, or
  // on self-hosted the update agent (read through its heartbeat op).
  const readAgent = async (): Promise<PlatformUpdateAgentStatus | null> => {
    const r = await execute(registry, adapter, SYSTEM_CTX, "platform_updates.agent_status", {});
    if (!r.ok) throw new Error(`platform_updates.agent_status: ${JSON.stringify(r.error)}`);
    return (r.value as { agent: PlatformUpdateAgentStatus | null }).agent;
  };
  const core = coreScheduledTasks({
    adapter,
    registry,
    projectionPublisher: () => projectionPublisher,
    // CAELO_BUG_INTAKE_URL points a fork or a test run at another intake.
    bugIntake: new BugIntakeClient({ baseUrl: bugIntakeUrl(env) }),
    // #696 — `off` for test runs: the Playwright suite seeds
    // release_check_cache itself, and a live check racing it would overwrite
    // the seeded release (and spend the runner's GitHub API quota).
    releaseCheck: env.CAELO_RELEASE_CHECK === "off" ? null : { readManifest, provider },
    // #696 Phase 5 — `off` for test runs: a live run would read the real
    // registry and write update emails into the suite's database.
    autoUpdate:
      env.CAELO_UPDATE_SCHEDULER === "off"
        ? null
        : {
            upgrader: () => upgraderTrigger(env, readAgent),
            // #819 — releases that change the cloud setup, when autoConverge allows.
            converge: () => convergeTrigger(env),
            readManifest,
            provider,
            holder: instance,
          },
  });
  return runSchedulerTick({
    adapter,
    registry,
    tasks: [...core, ...pluginWorkerTasks()],
    holder: `${instance}/${ticks++}`.slice(0, 200),
  });
}
