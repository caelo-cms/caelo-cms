// SPDX-License-Identifier: MPL-2.0

/**
 * Settings → Updates (#696): the release this install runs, the newest
 * release with its notes, and how to install it.
 *
 *   - Phase 0: for whoever may change settings, the exact, version-pinned
 *     command that upgrades this install from a terminal.
 *   - Phase 5: the automatic-update policy (which kinds install on their
 *     own, maintenance window, soak periods, pause/resume) — every change a
 *     step-up action of its own — plus what the scheduler last decided and
 *     which update emails went out.
 *   - Phase 2: on installs with the upgrader job, "Install update" for whoever
 *     holds `platform.update` (the Owner): a fresh Google sign-in (step-up),
 *     a confirmation of what will happen, then the request + the job start,
 *     and a live timeline of the job's run that survives the admin restarting
 *     (it is in the database). A release that changes the cloud setup ends as
 *     "needs Cloud Shell" with the commands to run there.
 *
 * Nothing here installs anything itself and the AI only reads (CLAUDE.md §2;
 * #696 decision 3). The ops behind the actions re-check the permission and the
 * step-up, and consume the step-up.
 */

import {
  type PlatformUpdateEvent,
  type PlatformUpdateRequest,
  type PlatformUpdateStatus,
  type SchedulerStatus,
  STEP_UP_REQUIRED,
  startUpgraderFor,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { StoredUpdatePolicy } from "@caelo-cms/shared";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import {
  beginStepUp,
  requireStepUp,
  STEP_UP_RESULT_COOKIE,
  stepUpRedirectUri,
} from "#lib/server/step-up.js";
import { upgraderTrigger } from "#lib/server/upgrader.js";
import {
  cloudShellUpgrade,
  installProjectId,
  resolveUpgradePath,
  type UpgradePath,
} from "#lib/upgrade-path.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, cookies, url }) => {
  const user = requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const [statusResult, latestResult, historyResult, policyResult, schedulerResult] =
    await Promise.all([
      execute(registry, adapter, locals.ctx, "platform_updates.status", {}),
      execute(registry, adapter, locals.ctx, "platform_updates.get", {}),
      execute(registry, adapter, locals.ctx, "platform_updates.list", { limit: 10 }),
      execute(registry, adapter, locals.ctx, "platform_update_policy.get", {}),
      execute(registry, adapter, locals.ctx, "platform_updates.scheduler_status", {}),
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
  // Only built for those who may run it, and only when there is a newer
  // release to name — the command always carries an exact version.
  const upgrade: UpgradePath | null =
    canUpgrade && status.upgradeAvailable && status.latestVersion
      ? resolveUpgradePath(process.env, status.latestVersion)
      : null;

  const upgrader = upgraderTrigger();
  const stepUp = canInstall ? await requireStepUp(locals, cookies, "platform_update") : null;
  // A policy change is its own step-up action (purpose update_policy).
  const policyStepUp = canInstall ? await requireStepUp(locals, cookies, "update_policy") : null;
  // A run that died (out of memory, timeout) never writes its end; Cloud
  // Run knows. Say so instead of showing "Installing" until the next run
  // ends it.
  let deadRun: { logsUrl: string } | null = null;
  const active = latest.request;
  if (active?.status === "running" && active.execution && upgrader.ok && upgrader.trigger) {
    const run = await upgrader.trigger.latest().catch(() => null);
    if (run && run.execution === active.execution && run.state !== "running") {
      deadRun = { logsUrl: run.logsUrl };
    }
  }
  // A release that needs Cloud Shell: the commands, pinned to that release.
  const cloudShell =
    canUpgrade && latest.request?.status === "needs_cloud_shell"
      ? cloudShellUpgrade(process.env, latest.request.targetVersion)
      : null;

  type StepUpResult = { ok: boolean; purpose: string; message: string };
  let stepUpResult: StepUpResult | null = null;
  const flash = cookies.get(STEP_UP_RESULT_COOKIE);
  if (flash) {
    cookies.delete(STEP_UP_RESULT_COOKIE, { path: "/settings/updates" });
    try {
      stepUpResult = JSON.parse(flash) as StepUpResult;
    } catch {
      stepUpResult = null;
    }
  }

  return {
    status,
    canUpgrade,
    canInstall,
    upgrade,
    upgrader: upgrader.ok
      ? { available: upgrader.trigger !== null, problem: null }
      : { available: false, problem: `${upgrader.error} ${upgrader.nextStep}` },
    stepUp: stepUp
      ? stepUp.fresh
        ? { configured: true, fresh: true, freshUntil: stepUp.freshUntil, problem: null }
        : { configured: stepUp.configured, fresh: false, freshUntil: null, problem: stepUp.problem }
      : null,
    policyStepUp: policyStepUp
      ? policyStepUp.fresh
        ? { configured: true, fresh: true, freshUntil: policyStepUp.freshUntil }
        : { configured: policyStepUp.configured, fresh: false, freshUntil: null }
      : null,
    policy: policyResult.value as StoredUpdatePolicy,
    scheduler: schedulerResult.value as SchedulerStatus,
    stepUpResult,
    redirectUri: stepUpRedirectUri(url.origin),
    credentialsUrl: (() => {
      const project = installProjectId({ CAELO_UPGRADER_JOB: process.env.CAELO_UPGRADER_JOB });
      return project
        ? `https://console.cloud.google.com/apis/credentials?project=${project}`
        : "https://console.cloud.google.com/apis/credentials";
    })(),
    latest,
    deadRun,
    history,
    cloudShell,
  };
};

const STEP_UP_PURPOSES = ["platform_update", "update_policy", "step_up_client"] as const;
type Purpose = (typeof STEP_UP_PURPOSES)[number];

/** A failed op as a form result: step-up refusals flagged, so the page offers the sign-in. */
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

function policyStepUpMissing() {
  return fail(403, {
    error: "Confirm with a fresh Google sign-in first.",
    stepUpRequired: true,
    policy: true,
  });
}

export const actions: Actions = {
  /** Start a fresh Google sign-in; Google sends the browser back to the callback. */
  stepUp: async ({ request, locals, cookies, url }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const purpose = String(form.get("purpose") ?? "platform_update");
    if (!(STEP_UP_PURPOSES as readonly string[]).includes(purpose)) {
      return fail(400, { error: "Unknown confirmation." });
    }
    const r = await beginStepUp(locals, cookies, {
      purpose: purpose as Purpose,
      returnTo: "/settings/updates",
      origin: url.origin,
    });
    if (!r.ok) return fail(400, { error: r.error });
    throw redirect(303, r.location);
  },

  /** Request the newest release and start the upgrader job. */
  install: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const version = String(form.get("version") ?? "");
    const upgrader = upgraderTrigger();
    if (!upgrader.ok) return fail(500, { error: `${upgrader.error} ${upgrader.nextStep}` });
    if (!upgrader.trigger) {
      return fail(400, {
        error: "This install has no upgrader yet; run the upgrade command shown on this page.",
      });
    }
    const check = await requireStepUp(locals, cookies, "platform_update");
    if (!check.fresh) {
      return fail(403, {
        error: "Confirm with a fresh Google sign-in first.",
        stepUpRequired: true,
      });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_updates.request", {
      targetVersion: version,
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not request the update.");
    const requestId = (r.value as { requestId: string }).requestId;
    const started = await startUpgraderFor(
      registry,
      adapter,
      locals.ctx,
      requestId,
      upgrader.trigger,
    );
    if (!started.ok) {
      return fail(502, {
        error: `The upgrader could not be started: ${started.error} ${started.nextStep}`,
      });
    }
    return { ok: `Installing v${version} — follow along below.` };
  },

  /** Withdraw a request the upgrader has not picked up yet. */
  cancel: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const check = await requireStepUp(locals, cookies, "platform_update");
    if (!check.fresh) {
      return fail(403, {
        error: "Confirm with a fresh Google sign-in first.",
        stepUpRequired: true,
      });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_updates.cancel", {
      requestId: String(form.get("requestId") ?? ""),
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not cancel the update.");
    return { ok: "Update cancelled." };
  },

  /** Save the automatic-update policy (its own fresh Google sign-in). */
  savePolicy: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const check = await requireStepUp(locals, cookies, "update_policy");
    if (!check.fresh) return policyStepUpMissing();
    const windowOn = form.get("windowEnabled") === "on";
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_update_policy.set", {
      policy: {
        mode: String(form.get("mode") ?? ""),
        autoSecurity: form.get("autoSecurity") === "on",
        autoPatch: form.get("autoPatch") === "on",
        autoMinor: form.get("autoMinor") === "on",
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
    const check = await requireStepUp(locals, cookies, "update_policy");
    if (!check.fresh) return policyStepUpMissing();
    const days = String(form.get("pauseFor") ?? "");
    if (days !== "resume" && !PAUSE_DAYS.includes(Number(days))) {
      return fail(400, { error: "Choose how long to pause.", policy: true });
    }
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
    const check = await requireStepUp(locals, cookies, "update_policy");
    if (!check.fresh) return policyStepUpMissing();
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "platform_update_policy.resume", {
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Could not resume automatic updates.", { policy: true });
    return { ok: "Automatic updates resumed." };
  },

  /** Store the install's Google OAuth client for step-up sign-ins. */
  setClient: async ({ request, locals, cookies }) => {
    requirePermission(locals, "platform.update");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const check = await requireStepUp(locals, cookies, "step_up_client");
    if (!check.sessionHash) return fail(401, { error: "Sign in again first." });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "step_up.set_client", {
      clientId: String(form.get("clientId") ?? "").trim(),
      clientSecret: String(form.get("clientSecret") ?? "").trim(),
      sessionHash: check.sessionHash,
    });
    if (!r.ok) return opFailure(r.error, "Check the client ID and secret.");
    const replaced = (r.value as { replaced: boolean }).replaced;
    return {
      ok: replaced
        ? "Google sign-in client replaced."
        : "Google sign-in is set up. Updates are now confirmed with a fresh Google sign-in.",
    };
  },
};
