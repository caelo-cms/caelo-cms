// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #875 — which Lighthouse runner an install uses. Cloud installs run
 * every Lighthouse run in its own container in parallel
 * (`parallel-runner.ts`); self-hosted and dev installs have no extra
 * machines and keep the in-process child (`lighthouse-runner.ts`), whose
 * runs go one after another.
 */

import type { LighthouseRunner } from "./checks/registry.js";
import { gcpAuditLauncherFromEnv } from "./gcp-audit-launcher.js";
import { runAuditJob } from "./lighthouse-runner.js";
import { type AuditTaskLauncher, createParallelAuditRunner } from "./parallel-runner.js";

/**
 * The runner for this admin process.
 *
 * A cloud install whose audit job is not configured gets a runner that
 * fails every audit with the fix (`cms-provision upgrade`) instead of
 * silently auditing in-process: the in-process runs would share the admin's
 * CPU and measure it (no fallbacks pre-1.0).
 */
export function lighthouseRunnerFromEnv(env: NodeJS.ProcessEnv): LighthouseRunner {
  const provider = env.CAELO_PROVIDER ?? "";
  if (provider === "" || provider === "self-hosted") return runAuditJob;
  let launcher: AuditTaskLauncher | null;
  try {
    launcher = launcherFor(provider, env);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return async () => ({ ok: false, failure: { code: "child-failed", message } });
  }
  if (!launcher) {
    return async () => ({
      ok: false,
      failure: {
        code: "child-failed",
        message: `quality audits have no parallel audit job on provider "${provider}" — the audit is recorded as failed so the gap stays visible`,
      },
    });
  }
  return createParallelAuditRunner({ launcher });
}

function launcherFor(provider: string, env: NodeJS.ProcessEnv): AuditTaskLauncher | null {
  if (provider === "gcp" || provider === "gcp-firebase") return gcpAuditLauncherFromEnv(env);
  return null;
}
