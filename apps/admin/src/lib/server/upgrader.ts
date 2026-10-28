// SPDX-License-Identifier: MPL-2.0

/**
 * Which upgrader this admin can hand an update to (epic #696):
 *
 *   - Google Cloud: the install's Cloud Run job, which the admin may start
 *     (admin-core security/upgrader/job-trigger.ts) — the upgrader job, or
 *     for a release that changes the cloud setup the converge job (#819;
 *     {@link convergeTrigger}, routed by admin-core update-route.ts);
 *   - self-hosted: the update agent on the server, which polls for the
 *     request the Owner writes (admin-core security/upgrader/agent-trigger.ts);
 *     available only while it checks in;
 *   - none — then Settings → Updates shows the command to run instead.
 *
 * Test-only stand-ins, honoured outside production only (same gate as
 * CAELO_FAKE_IMAGE_PROVIDER):
 *   - `CAELO_E2E_FAKE_UPGRADER=1` starts no Google Cloud job and reports a
 *     fake run (for both jobs), so the Playwright suite can drive "Install
 *     update" and feed the timeline itself; release manifests then come
 *     from the stand-in in release-check.ts (`releaseManifestReader`);
 *   - with it, the `caelo_e2e_updates_provider` cookie switches the page to
 *     another provider for one browser (`self-hosted` / `gcp`), so the same
 *     admin build serves both install kinds to the suite;
 *   - the `caelo_e2e_upgrader_run=ended` cookie makes the fake report
 *     its run `e2e-upgrader-ended` as over (crashed without reporting back),
 *     so the suite can show a request whose run died (#861 `interrupted`),
 *     and `caelo_e2e_upgrader_run=start_fails` makes starting it fail, so
 *     the suite can show a request whose job never started;
 *   - and the `caelo_e2e_converge_job=absent` cookie shows an install
 *     without the converge job (#819: one set up before it existed, or
 *     without a caelo-provisioner), whose cloud-setup releases stay a step
 *     by hand.
 */

import {
  agentUpgraderTrigger,
  chooseUpdateRoute,
  convergeTriggerFromEnv,
  type LastUpdateAttempt,
  readReleaseFacts,
  type UpdateRoute,
  type UpgraderTrigger,
  UpgraderTriggerError,
  upgraderTriggerFromEnv,
} from "@caelo-cms/admin-core";
import { CAELO_VERSION, type PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import type { Cookies } from "@sveltejs/kit";
import { releaseManifestReader } from "#lib/server/release-check.js";
import { type UpgradePathEnv, updatesProvider } from "#lib/upgrade-path.js";

let fakeRuns = 0;

const fakeTrigger: UpgraderTrigger = {
  async start() {
    fakeRuns += 1;
    return `e2e-upgrader-${fakeRuns}`;
  },
  async latest() {
    return fakeRuns === 0
      ? null
      : {
          execution: `e2e-upgrader-${fakeRuns}`,
          state: "running",
          logsUrl: "https://console.cloud.google.com/run/jobs",
        };
  },
};

/** The stand-in whose only run (`e2e-upgrader-ended`) died without reporting back. */
const endedFakeTrigger: UpgraderTrigger = {
  async start() {
    return "e2e-upgrader-ended";
  },
  async latest() {
    return {
      execution: "e2e-upgrader-ended",
      state: "failed",
      logsUrl: "https://console.cloud.google.com/run/jobs/e2e-upgrader-ended",
    };
  },
};

/** The stand-in whose job cannot be started (the request is recorded, the start fails). */
const failingFakeTrigger: UpgraderTrigger = {
  async start() {
    throw new Error("e2e stand-in: the job could not be started.");
  },
  async latest() {
    return null;
  },
};

/** The fake trigger the `caelo_e2e_upgrader_run` cookie picks. */
function fakeTriggerFor(env: UpdatesEnv): UpgraderTrigger {
  if (env.CAELO_E2E_UPGRADER_RUN === "ended") return endedFakeTrigger;
  if (env.CAELO_E2E_UPGRADER_RUN === "start_fails") return failingFakeTrigger;
  return fakeTrigger;
}

/** Whether the test-only stand-ins are on (never in production). */
function e2eStandIns(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.CAELO_E2E_FAKE_UPGRADER === "1";
}

/** The e2e cookie that picks the provider per browser (see the file comment). */
export const E2E_UPDATES_PROVIDER_COOKIE = "caelo_e2e_updates_provider";

/** The e2e cookie that makes the fake upgrader's run a dead one (see the file comment). */
export const E2E_UPGRADER_RUN_COOKIE = "caelo_e2e_upgrader_run";

/** The e2e cookie that hides the stand-in converge job (see the file comment). */
export const E2E_CONVERGE_JOB_COOKIE = "caelo_e2e_converge_job";

/** {@link UpgradePathEnv} plus the test-only choices of the fake jobs. */
export interface UpdatesEnv extends UpgradePathEnv {
  /** `ended`: the fake upgrader's run died; `start_fails`: it cannot start (test-only stand-ins only). */
  readonly CAELO_E2E_UPGRADER_RUN?: string;
  /** `absent`: this install has no converge job (test-only stand-ins only). */
  readonly CAELO_E2E_CONVERGE_JOB?: string;
}

/**
 * The environment Settings → Updates resolves the install's provider from:
 * the admin's own, plus — under the test-only stand-ins — the provider the
 * browser's e2e cookie names.
 */
export function updatesEnv(cookies: Cookies): UpdatesEnv {
  const env: UpdatesEnv = process.env;
  if (!e2eStandIns()) return env;
  const override = cookies.get(E2E_UPDATES_PROVIDER_COOKIE);
  const runCookie = cookies.get(E2E_UPGRADER_RUN_COOKIE);
  const run = runCookie === "ended" || runCookie === "start_fails" ? runCookie : undefined;
  const noConverge = cookies.get(E2E_CONVERGE_JOB_COOKIE) === "absent";
  return {
    ...env,
    ...(override === "self-hosted" || override === "gcp"
      ? { CAELO_E2E_UPDATES_PROVIDER: override }
      : {}),
    ...(run ? { CAELO_E2E_UPGRADER_RUN: run } : {}),
    ...(noConverge ? { CAELO_E2E_CONVERGE_JOB: "absent" } : {}),
  };
}

/**
 * The converge job of this install (#819), null when it has none (not
 * Google Cloud, or set up before the job existed), or the setup problem.
 * Under the test-only stand-ins it is the same fake as the upgrader, so the
 * `caelo_e2e_upgrader_run=ended` cookie also kills a converge run.
 */
export function convergeTrigger(
  env: UpdatesEnv,
):
  | { readonly ok: true; readonly trigger: UpgraderTrigger | null }
  | { readonly ok: false; readonly error: string; readonly nextStep: string } {
  if (updatesProvider(env) === "self-hosted") return { ok: true, trigger: null };
  if (e2eStandIns()) {
    if (env.CAELO_E2E_CONVERGE_JOB === "absent") return { ok: true, trigger: null };
    return { ok: true, trigger: fakeTriggerFor(env) };
  }
  try {
    return {
      ok: true,
      trigger: convergeTriggerFromEnv({
        CAELO_PROVIDER: process.env.CAELO_PROVIDER,
        CAELO_CONVERGE_JOB: process.env.CAELO_CONVERGE_JOB,
      }),
    };
  } catch (e) {
    if (e instanceof UpgraderTriggerError) {
      return { ok: false, error: e.message, nextStep: e.nextStep };
    }
    throw e;
  }
}

/** The upgrader of this install, null when it has none, or the setup problem. */
export function upgraderTrigger(
  env: UpdatesEnv,
  readAgent: () => Promise<PlatformUpdateAgentStatus | null>,
):
  | { readonly ok: true; readonly trigger: UpgraderTrigger | null }
  | { readonly ok: false; readonly error: string; readonly nextStep: string } {
  // Self-hosted needs no stand-in: its trigger only reads the agent's
  // heartbeat, which the suite seeds.
  if (updatesProvider(env) === "self-hosted") {
    return { ok: true, trigger: agentUpgraderTrigger(readAgent) };
  }
  if (e2eStandIns()) {
    return { ok: true, trigger: fakeTriggerFor(env) };
  }
  try {
    return {
      ok: true,
      trigger: upgraderTriggerFromEnv({
        CAELO_PROVIDER: process.env.CAELO_PROVIDER,
        CAELO_UPGRADER_JOB: process.env.CAELO_UPGRADER_JOB,
      }),
    };
  } catch (e) {
    if (e instanceof UpgraderTriggerError) {
      return { ok: false, error: e.message, nextStep: e.nextStep };
    }
    throw e;
  }
}

/**
 * Which job installs `targetVersion` from Settings → Updates (#819): the
 * release manifests (read, network) and the last attempt decide, through
 * admin-core update-route.ts.
 *
 * It lives here rather than in the route because the page is its only
 * caller: reached through the admin-core barrel from a `+page.server.ts`
 * alone, the bundler hoists update-route.ts into the page's chunk and
 * re-exports it from there, which SvelteKit refuses (`invalid_export`).
 */
export async function updateRouteFor(input: {
  readonly env: UpdatesEnv;
  readonly targetVersion: string;
  readonly lastAttempt: LastUpdateAttempt | null;
  readonly convergeAvailable: boolean;
}): Promise<UpdateRoute> {
  const provider = updatesProvider(input.env);
  const facts = await readReleaseFacts(
    { installedVersion: CAELO_VERSION, targetVersion: input.targetVersion, provider },
    releaseManifestReader(),
  );
  return chooseUpdateRoute({
    provider,
    targetVersion: input.targetVersion,
    infraChange: "unavailable" in facts ? null : facts.infraChange,
    lastAttempt: input.lastAttempt,
    convergeAvailable: input.convergeAvailable,
  });
}
