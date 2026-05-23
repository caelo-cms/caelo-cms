// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit globalTeardown (issue #47).
 *
 * Reads the PID written by `global-setup.ts`, sends SIGTERM, and gives
 * the admin process a short grace window before SIGKILL. The
 * Playwright HTML reporter still has its own files under
 * `test-results/livedit/playwright-report/`; the admin's captured
 * stdout/stderr remain in `test-results/livedit/admin.log` for triage.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_PID_PATH = resolve(HERE, "../test-results/livedit/admin.pid");
const SIGKILL_GRACE_MS = 5_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(ADMIN_PID_PATH)) return;
  const raw = readFileSync(ADMIN_PID_PATH, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  unlinkSync(ADMIN_PID_PATH);
  if (!Number.isInteger(pid) || pid <= 1) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + SIGKILL_GRACE_MS;
  while (Date.now() < deadline && pidAlive(pid)) {
    await sleep(100);
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
