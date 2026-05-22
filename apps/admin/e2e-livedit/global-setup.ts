// SPDX-License-Identifier: MPL-2.0

/**
 * Real-AI e2e-livedit global setup (issue #47). Three responsibilities:
 *
 * 1. Seeds the dev-owner + `ai_providers` row (reuses the shared
 *    SETUP_SCRIPT from `apps/admin/e2e/_seed.ts`). The provider row's
 *    dummy encryption triplet is left as-is; the resolver's env-var
 *    fallback bypasses DB decryption when `ANTHROPIC_API_KEY` is set.
 * 2. Asserts `ANTHROPIC_API_KEY_E2E` is set (loud failure with a
 *    message naming `.env.test` — no silent skip).
 * 3. Spawns the admin (`bun run build/index.js`) with stdio piped to
 *    `test-results/livedit/admin.log` and records its PID in a
 *    scratch file the matching `global-teardown.ts` reads.
 *
 * Webserver is NOT delegated to Playwright's `webServer` block — its
 * child-process stdio is not reachable from spec code, and the suite
 * needs to grep the admin's stderr for `[chat-runner]` diag lines as
 * regression guards (AC #7).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, runBun, SETUP_SCRIPT } from "../e2e/_seed.js";
import { E2E_LIVEDIT_MODEL } from "../playwright.livedit.config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = resolve(HERE, "..");
export const ADMIN_LOG_DIR = resolve(ADMIN_ROOT, "test-results/livedit");
export const ADMIN_LOG_PATH = resolve(ADMIN_LOG_DIR, "admin.log");
export const ADMIN_PID_PATH = resolve(ADMIN_LOG_DIR, "admin.pid");

const ADMIN_BASE_URL = "http://localhost:4173";
const ADMIN_READY_TIMEOUT_MS = 240_000;
const ADMIN_READY_POLL_MS = 1_000;

function loadDotEnvTestIfPresent(): void {
  const envTestPath = resolve(ADMIN_ROOT, "../../.env.test");
  if (!existsSync(envTestPath)) return;
  const text = readFileSync(envTestPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function pollAdminReady(): Promise<void> {
  const deadline = Date.now() + ADMIN_READY_TIMEOUT_MS;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ADMIN_BASE_URL}/login`, { method: "GET" });
      if (res.status >= 200 && res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, ADMIN_READY_POLL_MS));
  }
  throw new Error(
    `e2e-livedit: admin process did not become ready at ${ADMIN_BASE_URL}/login within ${ADMIN_READY_TIMEOUT_MS}ms (last error: ${lastError ?? "n/a"}). Check ${ADMIN_LOG_PATH}.`,
  );
}

export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  loadDotEnvTestIfPresent();

  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error(
      "e2e-livedit: ADMIN_DATABASE_URL must be set (compose stack up + .env loaded).",
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY_E2E;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "e2e-livedit: ANTHROPIC_API_KEY_E2E is not set.\n" +
        "  • Local: add it to apps/admin/.env.test or the repo-root .env.test\n" +
        "  • CI: configure the ANTHROPIC_API_KEY_E2E GitHub Actions secret\n" +
        "This suite drives the real Anthropic API; no key, no run.",
    );
  }

  runBun(SETUP_SCRIPT);

  mkdirSync(ADMIN_LOG_DIR, { recursive: true });
  // Truncate the log between runs so the diag-grep helper only sees
  // the current run's output.
  writeFileSync(ADMIN_LOG_PATH, "");
  const logFd = openSync(ADMIN_LOG_PATH, "a");

  const adminEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    PORT: "4173",
    ORIGIN: ADMIN_BASE_URL,
    ANTHROPIC_API_KEY: apiKey,
    // Pin the chat model + temperature via the resolver's env hooks.
    CAELO_CHAT_MODEL_OVERRIDE: E2E_LIVEDIT_MODEL,
    CAELO_CHAT_TEMPERATURE: "0",
  };

  // Spawn the admin from the built output. The npm script
  // (`apps/admin/package.json -> e2e-livedit`) runs `bun run build`
  // before invoking Playwright, so `build/index.js` is guaranteed
  // current.
  const child = spawn("bun", ["run", "build/index.js"], {
    cwd: ADMIN_ROOT,
    env: adminEnv,
    stdio: ["ignore", logFd, logFd],
    detached: false,
  });

  if (typeof child.pid !== "number") {
    throw new Error("e2e-livedit: failed to spawn admin (no PID returned).");
  }
  writeFileSync(ADMIN_PID_PATH, String(child.pid));

  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      // Don't throw here — global-setup has already returned; just
      // surface the unexpected exit so the spec's first DOM action
      // fails loudly with the captured log nearby.
      console.error(
        `[e2e-livedit] admin process exited unexpectedly: code=${code} signal=${signal}. See ${ADMIN_LOG_PATH}.`,
      );
    }
  });

  await pollAdminReady();
}
