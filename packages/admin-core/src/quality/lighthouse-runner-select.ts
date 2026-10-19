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
        message: `quality audits have no parallel audit job on provider "${provider}" yet (${PENDING_AUDIT_JOB_ISSUE[provider] ?? "no tracking issue"}) — the audit is recorded as failed so the gap stays visible`,
      },
    });
  }
  return createParallelAuditRunner({ launcher });
}

/** Where each provider's missing audit job is tracked (its stack's FIXME). */
const PENDING_AUDIT_JOB_ISSUE: Readonly<Record<string, string>> = {
  aws: "issue #749: a Fargate task per run",
  azure: "issue #750: a Container Apps job per run",
};

function launcherFor(provider: string, env: NodeJS.ProcessEnv): AuditTaskLauncher | null {
  if (provider === "gcp" || provider === "gcp-firebase") return gcpAuditLauncherFromEnv(env);
  return null;
}
