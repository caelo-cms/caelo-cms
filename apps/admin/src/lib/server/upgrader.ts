// SPDX-License-Identifier: MPL-2.0

/**
 * Which upgrader job this admin can start (epic #696): the install's Cloud
 * Run job (admin-core security/upgrader/job-trigger.ts), or none — then
 * Settings → Updates shows the command to run instead.
 *
 * Test-only stand-in: `CAELO_E2E_FAKE_UPGRADER=1` outside production starts
 * nothing and reports a fake run, so the Playwright suite can drive "Install
 * update" and feed the timeline itself. Same gate as
 * CAELO_FAKE_IMAGE_PROVIDER: ignored when NODE_ENV=production.
 */

import {
  type UpgraderTrigger,
  UpgraderTriggerError,
  upgraderTriggerFromEnv,
} from "@caelo-cms/admin-core";

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

/** The upgrader of this install, null when it has none, or the setup problem. */
export function upgraderTrigger():
  | { readonly ok: true; readonly trigger: UpgraderTrigger | null }
  | { readonly ok: false; readonly error: string; readonly nextStep: string } {
  if (process.env.NODE_ENV !== "production" && process.env.CAELO_E2E_FAKE_UPGRADER === "1") {
    return { ok: true, trigger: fakeTrigger };
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
