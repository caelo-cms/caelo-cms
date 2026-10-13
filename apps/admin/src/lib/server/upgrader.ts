// SPDX-License-Identifier: MPL-2.0

/**
 * Which upgrader this admin can hand an update to (epic #696):
 *
 *   - Google Cloud: the install's Cloud Run job, which the admin may start
 *     (admin-core security/upgrader/job-trigger.ts);
 *   - self-hosted: the update agent on the server, which polls for the
 *     request the Owner writes (admin-core security/upgrader/agent-trigger.ts);
 *     available only while it checks in;
 *   - none — then Settings → Updates shows the command to run instead.
 *
 * Test-only stand-ins, honoured outside production only (same gate as
 * CAELO_FAKE_IMAGE_PROVIDER):
 *   - `CAELO_E2E_FAKE_UPGRADER=1` starts no Google Cloud job and reports a
 *     fake run, so the Playwright suite can drive "Install update" and feed
 *     the timeline itself;
 *   - with it, the `caelo_e2e_updates_provider` cookie switches the page to
 *     another provider for one browser (`self-hosted` / `gcp`), so the same
 *     admin build serves both install kinds to the suite.
 */

import {
  agentUpgraderTrigger,
  type UpgraderTrigger,
  UpgraderTriggerError,
  upgraderTriggerFromEnv,
} from "@caelo-cms/admin-core";
import type { PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import type { Cookies } from "@sveltejs/kit";
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

/** Whether the test-only stand-ins are on (never in production). */
function e2eStandIns(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.CAELO_E2E_FAKE_UPGRADER === "1";
}

/** The e2e cookie that picks the provider per browser (see the file comment). */
export const E2E_UPDATES_PROVIDER_COOKIE = "caelo_e2e_updates_provider";

/**
 * The environment Settings → Updates resolves the install's provider from:
 * the admin's own, plus — under the test-only stand-ins — the provider the
 * browser's e2e cookie names.
 */
export function updatesEnv(cookies: Cookies): UpgradePathEnv {
  const env: UpgradePathEnv = process.env;
  if (!e2eStandIns()) return env;
  const override = cookies.get(E2E_UPDATES_PROVIDER_COOKIE);
  return override === "self-hosted" || override === "gcp"
    ? { ...env, CAELO_E2E_UPDATES_PROVIDER: override }
    : env;
}

/** The upgrader of this install, null when it has none, or the setup problem. */
export function upgraderTrigger(
  env: UpgradePathEnv,
  readAgent: () => Promise<PlatformUpdateAgentStatus | null>,
):
  | { readonly ok: true; readonly trigger: UpgraderTrigger | null }
  | { readonly ok: false; readonly error: string; readonly nextStep: string } {
  // Self-hosted needs no stand-in: its trigger only reads the agent's
  // heartbeat, which the suite seeds.
  if (updatesProvider(env) === "self-hosted") {
    return { ok: true, trigger: agentUpgraderTrigger(readAgent) };
  }
  if (e2eStandIns()) return { ok: true, trigger: fakeTrigger };
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
