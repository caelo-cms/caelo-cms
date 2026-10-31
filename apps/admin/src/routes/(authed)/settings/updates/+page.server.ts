// SPDX-License-Identifier: MPL-2.0

/**
 * Settings → Updates (#696): the release this install runs, the newest
 * release with its notes, and how to install it. The page derives ONE state
 * from what this loads (`updatePageState`, #861) and shows one action for it
 * at the top; everything else is collapsed reference.
 *
 *   - Phase 0: for whoever may change settings, the exact, version-pinned
 *     command that upgrades this install from a terminal.
 *   - Phase 5: the automatic-update policy (which kinds install on their
 *     own, maintenance window, soak periods, pause/resume) — every change a
 *     step-up action of its own (the Owner's password, #757) — plus what the scheduler last decided and
 *     which update emails went out. A scheduled install can be skipped
 *     for that one release ("Skip this time", `skipScheduled`, #868).
 *   - Phase 2: on installs with the upgrader job, "Install update" for whoever
 *     holds `platform.update` (the Owner): a confirmation of what will
 *     happen with the Owner's password (step-up), then the request + the job start,
 *     and a live timeline of the job's run that survives the admin restarting
 *     (it is in the database).
 *   - #819: a release that changes the cloud setup installs the same way —
 *     same button, same password, same timeline — but `install` hands it
 *     to the converge job (admin-core update-route.ts picks the job from
 *     the release manifest and the last attempt). A converge whose run died
 *     is offered "Continue" (`continueUpdate`), which starts the job again; it
 *     resumes from its checkpoint. Cloud Shell stays only for installs
 *     without the converge job (break-glass); #817's release check predicts
 *     that route before the click.
 *
 * "Check now" asks GitHub for the newest release right away (otherwise the
 * release-check worker does, hourly) — for anyone who may open this page.
 *
 * Nothing here installs anything itself and the AI only reads (CLAUDE.md §2;
 * #696 decision 3). Every guarded action confirms the password from its own
 * form first (lib/server/step-up.ts); the ops behind the actions re-check the
 * permission and the step-up, and consume it.
 */

import {
  agentInstallCommand,
  agentUnavailable,
  checkReleasesNow,
  type PlatformUpdateEvent,
  type PlatformUpdateRequest,
  type PlatformUpdateStatus,
  type SchedulerStatus,
  STEP_UP_REQUIRED,
  startUpgraderFor,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { PlatformUpdateAgentStatus, StoredUpdatePolicy } from "@caelo-cms/shared";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import { releaseCheckFetch, releaseManifestReader } from "#lib/server/release-check.js";
import { confirmStepUp } from "#lib/server/step-up.js";
import {
  convergeTrigger,
  updateRouteFor,
  updatesEnv,
  upgraderTrigger,
} from "#lib/server/upgrader.js";
import { deadRunOf } from "#lib/update-dead-run.js";
import type { InstallRoute } from "#lib/updates-display.js";
import {
  cloudShellUpgrade,
  resolveUpgradePath,
  type UpgradePath,
  updatesProvider,
} from "#lib/upgrade-path.js";
import type { Actions, PageServerLoad } from "./$types";

/** Whether an email transport is set up (the update emails need one). */
async function readEmailConfigured(ctx: App.Locals["ctx"]): Promise<boolean> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "email_config.get", {});
  if (!r.ok) throw new Error(opErrorMessage(r.error, "could not read the email settings"));
  return (r.value as { config: { transport: string } }).config.transport !== "none";
}

/** The self-hosted update agent's last check-in (null when it never checked in). */
async function readAgent(ctx: App.Locals["ctx"]): Promise<PlatformUpdateAgentStatus | null> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "platform_updates.agent_status", {});
  if (!r.ok) throw new Error(opErrorMessage(r.error, "could not read the update agent's status"));
  return (r.value as { agent: PlatformUpdateAgentStatus | null }).agent;
}

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const user = requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const [statusResult, latestResult, historyResult, policyResult, schedulerResult, pluginsResult] =
    await Promise.all([
      execute(registry, adapter, locals.ctx, "platform_updates.status", {}),
      execute(registry, adapter, locals.ctx, "platform_updates.get", {}),
      execute(registry, adapter, locals.ctx, "platform_updates.list", { limit: 10 }),
      execute(registry, adapter, locals.ctx, "platform_update_policy.get", {}),
      execute(registry, adapter, locals.ctx, "platform_updates.scheduler_status", {}),
      execute(registry, adapter, locals.ctx, "plugins.list", { tier: 1 }),
    ]);
  if (!statusResult.ok) {
    throw error(500, opErrorMessage(statusResult.error, "could not read the update status"));
  }
  if (!policyResult.ok) {
    throw error(500, opErrorMessage(policyResult.error, "could not read the update policy"));
  }
  if (!schedulerResult.ok) {
    throw error(500, opErrorMessage(schedulerResult.error, "could not read the update scheduler"));
  }
  if (!pluginsResult.ok) {
    throw error(500, opErrorMessage(pluginsResult.error, "could not read the plugins"));
  }
  // #1267 — a release whose shipped plugin asks for a new capability leaves
  // that plugin waiting for the Owner's approval (one plugin model).
  const pluginsAwaitingApproval = (
    pluginsResult.value as { plugins: { slug: string; unapprovedCapabilities: string[] }[] }
  ).plugins
    .filter((p) => p.unapprovedCapabilities.length > 0)
    .map((p) => ({ slug: p.slug, capabilities: p.unapprovedCapabilities }));
  const status = statusResult.value as PlatformUpdateStatus;
  const latest = latestResult.ok
    ? (latestResult.value as {
        request: PlatformUpdateRequest | null;
        events: PlatformUpdateEvent[];
      })
    : { request: null, events: [] };
  const history = historyResult.ok
    ? (historyResult.value as { requests: PlatformUpdateRequest[] }).requests
    : [];

  const canUpgrade = user.permissions.has("settings.write");
  const canInstall = user.permissions.has("platform.update");
  const env = updatesEnv(cookies);
  const selfHosted = updatesProvider(env) === "self-hosted";
  // Only built for those who may run it, and only when there is a newer
  // release to name — the command always carries an exact version.
  const upgrade: UpgradePath | null =
    canUpgrade && status.upgradeAvailable && status.latestVersion
      ? resolveUpgradePath(env, status.latestVersion)
      : null;

  // #696 Phase 4c — on a self-hosted install the update agent on the server
  // installs; "Install update" is offered only while it checks in healthy.
  const agent = selfHosted && canInstall ? await readAgent(locals.ctx) : null;
  const agentProblem = selfHosted && canInstall ? agentUnavailable(agent) : null;
  const upgrader = upgraderTrigger(env, () => readAgent(locals.ctx));
  // #819 — the converge job, for releases that change the cloud setup.
  const converge = convergeTrigger(env);
  const convergeJob = converge.ok && converge.trigger !== null;
  // A run that died (out of memory, timeout) never writes its end; Cloud
  // Run knows. Say so instead of showing "Installing" until the next run
  // ends it. Each route asks its own job. A converge whose stage-2 run
  // never started names no execution at all; it counts as dead once the
  // job has no live run (lib/update-dead-run.ts), and may be continued.
  let deadRun: { logsUrl: string; continuable: boolean } | null = null;
  const active = latest.request;
  const activeJob = active?.route === "converge" ? converge : upgrader;
  if (active?.status === "running" && activeJob.ok && activeJob.trigger) {
    // A failed lookup decides nothing: the page keeps showing the timeline.
    const run = await activeJob.trigger.latest().then(
      (r) => ({ ok: true as const, run: r }),
      () => ({ ok: false as const }),
    );
    if (run.ok) {
      deadRun = deadRunOf(active, run.run, {
        canInstall,
        logsUrl: "https://console.cloud.google.com/run/jobs",
      });
    }
  }
  // Cloud Shell for the newest release: the break-glass step when the page
  // needs it, otherwise one of the "other ways" (Google Cloud installs only;
  // self-hosted upgrades on its server with `upgrade`).
  const cloudShellFor =
    status.upgradeAvailable && status.latestVersion
      ? cloudShellUpgrade(env, status.latestVersion)
      : null;
  // The commands only for those who may run them (settings.write).
  const cloudShell = canUpgrade ? cloudShellFor : null;
  const upgraderAvailable = !upgrader.ok
    ? false
    : selfHosted
      ? canInstall && agentProblem === null
      : upgrader.trigger !== null;
  const installRoute: InstallRoute =
    canInstall && upgraderAvailable ? "in_product" : upgrade?.kind === "cli" ? "terminal" : "none";

  return {
    status,
    canUpgrade,
    canInstall,
    upgrade,
    selfHosted,
    upgrader: {
      available: upgraderAvailable,
      problem: upgrader.ok ? null : `${upgrader.error} ${upgrader.nextStep}`,
    },
    installRoute,
    convergeJob,
    // Whether the step by hand exists for this install at all — Google
    // Cloud: the Cloud Shell walkthrough; self-hosted: the upgrade command
    // on the server (both need a buildable upgrade command). The page never
    // offers a break-glass step that isn't there (`updatePageState`).
    breakGlassAvailable: selfHosted ? upgrade?.kind === "cli" : cloudShellFor !== null,
    emailConfigured: await readEmailConfigured(locals.ctx),
    agent:
      selfHosted && canInstall
        ? {
            status: agent,
            problem: agentProblem,
            // Pinned to the running release: the agent it sets up is this one.
            // A command to run on the server, so only for settings.write
            // (like the upgrade command): withheld here, not just hidden.
            installCommand: canUpgrade ? agentInstallCommand(status.installedVersion) : null,
          }
        : null,
    policy: policyResult.value as StoredUpdatePolicy,
    scheduler: schedulerResult.value as SchedulerStatus,
    latest,
    deadRun,
    history,
    cloudShell,
    pluginsAwaitingApproval,
  };
};

/** A failed op as a form result: step-up refusals flagged, so the page asks for the password again. */
function opFailure(error: unknown, fallback: string, extra: { policy?: true } = {}) {
  const message = opErrorMessage(error, fallback);
  const stepUpRequired = message.startsWith(STEP_UP_REQUIRED);
  return fail(stepUpRequired ? 403 : 400, {
    error: message.replace(`${STEP_UP_REQUIRED}: `, ""),
    stepUpRequired,
    ...extra,
  });
}

/** Pause lengths the page offers, in days ("until I resume" is the other choice). */
const PAUSE_DAYS = [1, 3, 7, 14, 30];

export const actions: Actions = {
  /**
   * Run the release check now instead of waiting for the hourly one. Open to
   * whoever may read this page: it changes nothing but the cached answer.
   * Refused within a minute of the last check (GitHub's API quota).
   */
  checkNow: async ({ request, locals, cookies }) => {
    requirePermission(locals, "settings.read");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const fetchImpl = releaseCheckFetch();
    const r = await checkReleasesNow({
      registry,
      adapter,
      ctx: locals.ctx,
      ...(fetchImpl ? { fetchImpl } : {}),
      readManifest: releaseManifestReader(),
      provider: updatesProvider(updatesEnv(cookies)),
    });
    if (!r.ok) {
      // `releaseCheck` keeps the message in the version card, not in the
      // install section's error spots.
      return fail(r.kind === "cooldown" ? 429 : r.kind === "check_failed" ? 502 : 500, {
        error: r.message,
        releaseCheck: true,
      });
    }
    return {
      ok: `Checked GitHub just now: the newest release is v${r.latestVersion}.`,
      releaseCheck: true,
    };
  },

  /**
   * Request the newest release and start the job that installs it: the
   * upgrader, or for a release that changes the cloud setup the converge
   * job (#819). The route is decided before the password is checked, so a
   * release this install cannot take from here costs no confirmation.
   */
  install: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const version = String(form.get("version") ?? "");
    const env = updatesEnv(cookies);
    const upgrader = upgraderTrigger(env, () => readAgent(locals.ctx));
    if (!upgrader.ok) return fail(500, { error: `${upgrader.error} ${upgrader.nextStep}` });
    if (!upgrader.trigger) {
      return fail(400, {
        error: "This install has no upgrader yet; run the upgrade command shown on this page.",
      });
    }
    const converge = convergeTrigger(env);
    if (!converge.ok) return fail(500, { error: `${converge.error} ${converge.nextStep}` });
    const { adapter, registry } = getQueryContext();
    const last = await execute(registry, adapter, locals.ctx, "platform_updates.get", {});
    if (!last.ok) return opFailure(last.error, "Could not read the last update.");
    // Network (the release manifests), outside any transaction.
    const route = await updateRouteFor({
      env,
      targetVersion: version,
      lastAttempt: (last.value as { request: PlatformUpdateRequest | null }).request,
      convergeAvailable: converge.trigger !== null,
    });
    if (!route.ok) return fail(400, { error: route.error });
    const trigger = route.route === "converge" ? converge.trigger : upgrader.trigger;
    if (!trigger) return fail(400, { error: "This install has no job for that update." });
    const check = await confirmStepUp(locals, cookies, form, "platform_update", "install");
    if (!check.ok) return check.failure;
    const r = await execute(registry, adapter, locals.ctx, "platform_updates.request", {
      targetVersion: version,
      sessionHash: check.sessionHash,
      route: route.route,
    });
    if (!r.ok) return opFailure(r.error, "Could not request the update.");
    const requestId = (r.value as { requestId: string }).requestId;
    const started = await startUpgraderFor(registry, adapter, locals.ctx, requestId, trigger);
    if (!started.ok) {
      return fail(502, {
        error: `The upgrader could not be started: ${started.error} ${started.nextStep}`,
      });
    }
    return { ok: `Installing v${version} — follow along below.` };
  },

  /**
   * #819 — continue a converge whose run died: the Owner's password, then
   * the converge job is started again and resumes from its checkpoint.
   */
  continueUpdate: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const converge = convergeTrigger(updatesEnv(cookies));
    if (!converge.ok) return fail(500, { error: `${converge.error} ${converge.nextStep}` });
    if (!converge.trigger) {
      return fail(400, {
        error:
          "This install has no converge job to continue the update with; run the upgrade from a terminal as this page shows.",
      });
    }
    const check = await confirmStepUp(locals, cookies, form, "platform_update", "continueUpdate");
    if (!check.ok) return check.failure;
    const { adapter, registry } = getQueryContext();
    const requestId = String(form.get("requestId") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "platform_updates.continue", {
      requestId,
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not continue the update.");
    const version = (r.value as { targetVersion: string }).targetVersion;
    const started = await startUpgraderFor(
      registry,
      adapter,
      locals.ctx,
      requestId,
      converge.trigger,
    );
    if (!started.ok) {
      return fail(502, {
        error: `The converge job could not be started: ${started.error} ${started.nextStep}`,
      });
    }
    return { ok: `Continuing the update to v${version} — follow along below.` };
  },

  /**
   * #868 — "Skip this time": the scheduler does not install this release on
   * its own (the Owner can still install it here; a newer release installs
   * automatically again). Its own password confirmation, like the policy.
   */
  skipScheduled: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const check = await confirmStepUp(locals, cookies, form, "update_policy", "skipScheduled");
    if (!check.ok) return check.failure;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_updates.skip_scheduled", {
      version: String(form.get("version") ?? ""),
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not skip the automatic install.");
    const version = (r.value as { skippedVersion: string }).skippedVersion;
    return {
      ok: `v${version} won't install automatically. Install it here whenever you're ready.`,
    };
  },

  /** Withdraw a request the upgrader has not picked up yet. */
  cancel: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const check = await confirmStepUp(locals, cookies, form, "platform_update", "cancel");
    if (!check.ok) return check.failure;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_updates.cancel", {
      requestId: String(form.get("requestId") ?? ""),
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not cancel the update.");
    return { ok: "Update cancelled." };
  },

  /** Save the automatic-update policy (its own password confirmation). */
  savePolicy: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const check = await confirmStepUp(locals, cookies, form, "update_policy", "savePolicy");
    if (!check.ok) return check.failure;
    const windowOn = form.get("windowEnabled") === "on";
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_update_policy.set", {
      policy: {
        mode: String(form.get("mode") ?? ""),
        autoSecurity: form.get("autoSecurity") === "on",
        autoPatch: form.get("autoPatch") === "on",
        autoMinor: form.get("autoMinor") === "on",
        autoConverge: form.get("autoConverge") === "on",
        channel: "stable",
        windowStart: windowOn ? String(form.get("windowStart") ?? "") : null,
        windowEnd: windowOn ? String(form.get("windowEnd") ?? "") : null,
        windowTimezone: String(form.get("windowTimezone") ?? "").trim(),
        soakHours: Number(form.get("soakHours")),
        securitySoakHours: Number(form.get("securitySoakHours")),
      },
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not save the update policy.", { policy: true });
    return { ok: "Automatic-update settings saved." };
  },

  /** Pause automatic updates for a while, or until resumed. */
  pause: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    // Checked before the confirmation, so a bad choice does not leave one unused.
    const days = String(form.get("pauseFor") ?? "");
    if (days !== "resume" && !PAUSE_DAYS.includes(Number(days))) {
      return fail(400, { error: "Choose how long to pause.", policy: true });
    }
    const check = await confirmStepUp(locals, cookies, form, "update_policy", "pause");
    if (!check.ok) return check.failure;
    const until =
      days === "resume" ? null : new Date(Date.now() + Number(days) * 86_400_000).toISOString();
    const reason = String(form.get("reason") ?? "").trim();
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_update_policy.pause", {
      until,
      ...(reason ? { reason } : {}),
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not pause automatic updates.", { policy: true });
    return { ok: "Automatic updates paused." };
  },

  /** Lift a pause (the Owner's own, or the one a failed install set). */
  resume: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const check = await confirmStepUp(locals, cookies, form, "update_policy", "resume");
    if (!check.ok) return check.failure;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_update_policy.resume", {
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not resume automatic updates.", { policy: true });
    return { ok: "Automatic updates resumed." };
  },
};
