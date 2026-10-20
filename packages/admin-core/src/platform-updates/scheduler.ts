// SPDX-License-Identifier: MPL-2.0

/**
 * The auto-update scheduler (epic #696 Phase 5) — a background loop inside
 * every admin instance (CLAUDE.md §11.B Tier 5), bootstrapped from
 * apps/admin/src/hooks.server.ts like the release check.
 *
 * Each tick:
 *   1. reads the newest release the release check cached;
 *   2. when it is newer, reads its manifest facts (network, outside any
 *      transaction; release-facts.ts);
 *   3. runs `platform_updates.scheduler_tick`, which takes the lease (one
 *      instance decides per interval), applies the Owner's policy, soak,
 *      window and pause (shared auto-update.ts), queues an automatic request
 *      exactly like a manual install would — system actor, `trigger = 'auto'`
 *      — and writes the Owner's emails to the outbox;
 *   4. starts the upgrader for a new request (or one whose start was lost)
 *      through the same trigger the Owner's click uses, and records the
 *      outcome on the request. On self-hosted installs that trigger is the
 *      update agent (#696 Phase 4c): the request row is what it polls for,
 *      so nothing is queued unless the agent checks in without a problem;
 *   5. sends what is in the outbox through the configured email transport.
 *
 * Nothing here can do more than the Owner's policy allows: the upgrader job
 * re-checks every automatic request against the signed manifest and the
 * policy, and the AI never reaches any of it.
 */

import {
  type DatabaseAdapter,
  execute,
  type OperationRegistry,
  SYSTEM_ACTOR_ID,
} from "@caelo-cms/query-api";
import type {
  ExecutionContext,
  PlatformUpdateAgentStatus,
  PlatformUpdateRoute,
} from "@caelo-cms/shared";
import { buildEmailTransport, type EmailConfigRow } from "../email/transport.js";
import { startUpgraderFor } from "../ops/platform-update-requests.js";
import type { PlatformUpdateStatus } from "../ops/platform-updates.js";
import { agentUnavailable } from "../security/upgrader/agent-trigger.js";
import type { UpgraderTrigger } from "../security/upgrader/job-trigger.js";
import { updateNotificationHtml } from "./notification-text.js";
import { type ManifestReader, readReleaseFacts } from "./release-facts.js";

/** How often a tick runs (per install, not per instance: the lease spreads it). */
export const AUTO_UPDATE_TICK_MS = 15 * 60 * 1000;

/** The upgrader this install has right now (resolved per tick: env can be fixed without a redeploy of this code). */
export type UpgraderResolver = () =>
  | { readonly ok: true; readonly trigger: UpgraderTrigger | null }
  | { readonly ok: false; readonly error: string; readonly nextStep: string };

export interface AutoUpdateSchedulerOpts {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly upgrader: UpgraderResolver;
  /**
   * The converge job (#819): releases that change the cloud setup install
   * through it, automatically only when the Owner's `autoConverge` allows.
   */
  readonly converge: UpgraderResolver;
  readonly readManifest: ManifestReader;
  /**
   * The install's provider as Settings → Updates resolves it (`self-hosted`
   * when `CAELO_PROVIDER` is unset). On `self-hosted` the update agent's
   * heartbeat decides whether anything is queued.
   */
  readonly provider: string | undefined;
  /** Names this instance in the scheduler's status line. */
  readonly holder: string;
  readonly intervalMs?: number;
  /** Logs (stderr by default). */
  readonly log?: (line: string) => void;
}

let n = 0;
const systemCtx = (): ExecutionContext => ({
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: `auto-update-${Date.now()}-${n++}`,
});

/** One tick. Exported for tests; the loop calls it on a timer. */
export async function runAutoUpdateTick(opts: AutoUpdateSchedulerOpts): Promise<{
  readonly ran: boolean;
  readonly action: string | null;
  readonly requestId: string | null;
  readonly delivered: number;
}> {
  const { adapter, registry } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const call = async <T>(op: string, input: unknown): Promise<T> => {
    const r = await execute(registry, adapter, systemCtx(), op, input);
    if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
    return r.value as T;
  };

  const status = await call<PlatformUpdateStatus>("platform_updates.status", {});
  const factsVersion = status.upgradeAvailable ? status.latestVersion : null;
  const facts =
    factsVersion === null
      ? { unavailable: "no newer release" }
      : await readReleaseFacts(
          {
            installedVersion: status.installedVersion,
            targetVersion: factsVersion,
            provider: opts.provider,
          },
          opts.readManifest,
        );
  const upgrader = opts.upgrader();
  if (!upgrader.ok) log(`[auto-update] the upgrader is misconfigured: ${upgrader.error}`);
  let trigger = upgrader.ok ? upgrader.trigger : null;
  let upgraderProblem: string | null = upgrader.ok
    ? null
    : `${upgrader.error} ${upgrader.nextStep}`;
  // Self-hosted: the request row IS the trigger and the update agent on the
  // server picks it up. Queue nothing while the agent is missing, silent or
  // reporting a problem — a request nobody claims would only end as failed
  // and use up the release's one automatic attempt.
  if (trigger && opts.provider === "self-hosted") {
    const { agent } = await call<{ agent: PlatformUpdateAgentStatus | null }>(
      "platform_updates.agent_status",
      {},
    );
    const unavailable = agentUnavailable(agent);
    if (unavailable) {
      trigger = null;
      upgraderProblem = `${unavailable.error} ${unavailable.nextStep}`;
    }
  }

  const converge = opts.converge();
  if (!converge.ok) log(`[auto-update] the converge job is misconfigured: ${converge.error}`);
  const convergeTrigger = converge.ok ? converge.trigger : null;

  const tick = await call<{
    ran: boolean;
    action: string | null;
    reason: string | null;
    requestId: string | null;
    restartRequestId: string | null;
    startRoute: PlatformUpdateRoute | null;
  }>("platform_updates.scheduler_tick", {
    holder: opts.holder,
    intervalSeconds: Math.floor((opts.intervalMs ?? AUTO_UPDATE_TICK_MS) / 1000),
    factsVersion,
    facts,
    upgraderAvailable: trigger !== null,
    upgraderProblem,
    convergeAvailable: convergeTrigger !== null,
  });
  if (tick.ran) log(`[auto-update] ${tick.action}: ${tick.reason}`);

  const toStart = tick.requestId ?? tick.restartRequestId;
  // The request names its job: a cloud-setup release goes to the converge job.
  const startWith = tick.startRoute === "converge" ? convergeTrigger : trigger;
  if (toStart && startWith) {
    const started = await startUpgraderFor(registry, adapter, systemCtx(), toStart, startWith);
    if (!started.ok) {
      log(
        `[auto-update] could not start the ${tick.startRoute === "converge" ? "converge job" : "upgrader"}: ${started.error} ${started.nextStep}`,
      );
    }
  }

  const delivered = await deliverUpdateNotifications(opts);
  return { ran: tick.ran, action: tick.action, requestId: tick.requestId, delivered };
}

/**
 * Send the outbox. Delivery happens outside any transaction; each row ends
 * as sent, failed, no_transport (Settings → Email has none configured) or
 * no_recipients — recorded and shown on Settings → Updates, never dropped
 * silently.
 *
 * @returns how many emails the transport accepted
 */
export async function deliverUpdateNotifications(
  opts: Pick<AutoUpdateSchedulerOpts, "adapter" | "registry" | "log">,
): Promise<number> {
  const { adapter, registry } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const claim = await execute(
    registry,
    adapter,
    systemCtx(),
    "platform_updates.notification_claim",
    {
      limit: 20,
    },
  );
  if (!claim.ok) throw new Error(`notification_claim: ${JSON.stringify(claim.error)}`);
  const { notifications, recipients } = claim.value as {
    notifications: { id: string; subject: string; body: string }[];
    recipients: string[];
  };
  if (notifications.length === 0) return 0;

  const cfgResult = await execute(registry, adapter, systemCtx(), "email_config.get", {});
  if (!cfgResult.ok) throw new Error(`email_config.get: ${JSON.stringify(cfgResult.error)}`);
  const c = (cfgResult.value as { config: EmailConfigRow }).config;
  const transport = buildEmailTransport({
    transport: c.transport,
    fromAddress: c.fromAddress,
    config: c.config,
  });

  let sent = 0;
  for (const note of notifications) {
    let status: "sent" | "failed" | "no_transport" | "no_recipients";
    let detail: string | null = null;
    const to: string[] = [];
    if (!transport) {
      status = "no_transport";
      detail = "No email transport is configured (Settings → Email).";
    } else if (recipients.length === 0) {
      status = "no_recipients";
      detail = "No user holding the platform.update permission has an email address.";
    } else {
      const failures: string[] = [];
      for (const r of recipients) {
        try {
          await transport.send({
            to: r,
            subject: note.subject,
            html: updateNotificationHtml(note.body),
          });
          to.push(r);
        } catch (e) {
          failures.push(`${r}: ${(e as Error).message}`);
        }
      }
      status = to.length > 0 ? "sent" : "failed";
      detail = failures.length > 0 ? failures.join("; ").slice(0, 2000) : null;
      if (status === "sent") sent += 1;
    }
    if (status !== "sent") log(`[auto-update] email "${note.subject}" not sent: ${detail}`);
    const fin = await execute(
      registry,
      adapter,
      systemCtx(),
      "platform_updates.notification_finish",
      { id: note.id, status, detail, recipients: to },
    );
    if (!fin.ok) log(`[auto-update] could not record delivery: ${JSON.stringify(fin.error)}`);
  }
  return sent;
}

let handle: ReturnType<typeof setInterval> | null = null;
let firstTick: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the loop. Idempotent. A tick that throws is logged and the next one
 * runs on schedule — the decision is recomputed from the database each time.
 */
export function startAutoUpdateScheduler(opts: AutoUpdateSchedulerOpts): void {
  if (handle) return;
  const log = opts.log ?? ((line: string) => console.error(line));
  const once = () =>
    runAutoUpdateTick(opts).catch((e) => {
      log(`[auto-update] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  // First tick shortly after boot (the release check's first poll is
  // usually done by then), not inside the request that bootstrapped it.
  firstTick = setTimeout(() => void once(), 60_000);
  handle = setInterval(() => void once(), opts.intervalMs ?? AUTO_UPDATE_TICK_MS);
}

/** Test-only — stop the loop. */
export function stopAutoUpdateScheduler(): void {
  if (firstTick) {
    clearTimeout(firstTick);
    firstTick = null;
  }
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
