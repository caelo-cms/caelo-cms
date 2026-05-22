// SPDX-License-Identifier: MPL-2.0

/**
 * Playwright + DB + log helpers shared by every e2e-livedit scenario
 * (issue #47). All assertions are deterministic; the only AI call is
 * the closing vision verdict in `verifyPublishedPageWithVision`,
 * which lives in `./lib/vision-verdict.ts` for unit-testability.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Page, Response } from "@playwright/test";
import { expect } from "@playwright/test";
import { ADMIN_LOG_PATH } from "./global-setup.js";
import { fetchVisionVerdict, type VisionVerdict } from "./lib/vision-verdict.js";

// Re-export for spec convenience (parallel to apps/admin/e2e/helpers.ts).
export const DEV_OWNER_EMAIL = "dev-owner@example.com";
export const DEV_OWNER_PASSWORD = "dev owner password";

/**
 * Run a small Bun subprocess so specs (Node-side Playwright) can hit
 * Postgres via bun:SQL — same pattern as the existing e2e helpers.
 * Pass user-supplied values through `extraEnv`; reading them via
 * `process.env.X` inside the script avoids template-injection issues
 * with Bun's tagged-template SQL parser.
 */
function runBunInline(script: string, extraEnv: Record<string, string> = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const result = spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun -e failed (status ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Logs into the admin as dev-owner via the form on `/login`. Leaves
 * the page on whichever route the post-login redirect lands on.
 */
export async function loginAsDevOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(DEV_OWNER_EMAIL);
  await page.getByLabel(/password/i).fill(DEV_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

/**
 * Wait for the chat composer's status to be `idle` — set by the
 * `data-turn-state` attribute on `[data-testid="chat-turn-status"]`
 * in ChatPanel.svelte. After a send() click the attribute flips to
 * `streaming`; when the SSE turn finishes (the streaming $state goes
 * false), it flips back to `idle`.
 *
 * 240s default handles a multi-tool homepage build at Sonnet 4.6.
 */
export async function waitForChatTurnIdle(page: Page, timeoutMs = 240_000): Promise<void> {
  // The status element is `hidden`; assert against the attribute, not
  // visibility.
  await expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "idle", {
    timeout: timeoutMs,
  });
}

/**
 * Send a prompt into the chat composer and wait for the SSE turn to
 * complete (the `data-turn-state` flips streaming → idle).
 */
export async function sendChatPromptAndWait(page: Page, prompt: string): Promise<void> {
  // Wait for the composer to be ready first (rules out a still-streaming
  // prior turn from previous scenario state).
  await waitForChatTurnIdle(page);
  await page.getByTestId("chat-composer").fill(prompt);
  // Wait for the streaming state to actually flip before believing
  // the turn has started; otherwise a fast first-event arrival can
  // make us think the turn is already idle.
  await Promise.all([
    expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "streaming", {
      timeout: 30_000,
    }),
    page.getByTestId("chat-send").click(),
  ]);
  await waitForChatTurnIdle(page);
}

/** Capture the URL of the most recent chat SSE stream this page initiated. */
export interface ChatSessionTracker {
  /** Last sessionId observed in a `/content/chat/<id>/stream` POST. */
  readonly currentSessionId: () => string | null;
}

export function attachChatSessionTracker(page: Page): ChatSessionTracker {
  let current: string | null = null;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const m = req.url().match(/\/content\/chat\/([^/]+)\/stream(\?|$)/);
    if (m) current = m[1] ?? null;
  });
  return { currentSessionId: () => current };
}

/**
 * Click the Stage modal trigger + confirm; resolves when the
 * `?/stageAndDeployStaging` action returns. The action awaits
 * `chat.merge_to_main` + `deploy.trigger` synchronously, so the HTTP
 * response landing is the "staging build is on disk" signal —
 * subsequent `fetch(getStagingUrl())` sees the new content.
 *
 * We deliberately do NOT parse the response body. Reading the
 * staging URL via `getStagingUrl()` (env-based) keeps the helper
 * free of SvelteKit/devalue wire-format coupling.
 */
export async function awaitStageComplete(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(
    (r: Response) => r.url().includes("?/stageAndDeployStaging") && r.request().method() === "POST",
    { timeout: 180_000 },
  );
  await page.getByTestId("stage-btn").click();
  await page.getByTestId("stage-submit-btn").click();
  const res = await responsePromise;
  if (res.status() < 200 || res.status() >= 300) {
    throw new Error(
      `awaitStageComplete: stageAndDeployStaging returned HTTP ${res.status()}. Response: ${(await res.text()).slice(0, 500)}`,
    );
  }
}

export async function awaitPublishComplete(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(
    (r: Response) => r.url().includes("?/promoteToProduction") && r.request().method() === "POST",
    { timeout: 180_000 },
  );
  // Both `promote-btn` (chat-not-published case) and `promote-only-btn`
  // (chat-already-published case) map to the same form action. Click
  // whichever is in the DOM.
  const promote = page.getByTestId("promote-btn").or(page.getByTestId("promote-only-btn")).first();
  await promote.click();
  const res = await responsePromise;
  if (res.status() < 200 || res.status() >= 300) {
    throw new Error(
      `awaitPublishComplete: promoteToProduction returned HTTP ${res.status()}. Response: ${(await res.text()).slice(0, 500)}`,
    );
  }
}

/**
 * Assert `chat_entity_locks` has no rows for this chat session.
 * Guards against the v0.10.19 regression class where the AI's
 * tool-call left a row in `chat_entity_locks` that should have been
 * released at Stage time.
 */
export function assertNoOrphanLocks(chatSessionId: string): void {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`
        SELECT count(*)::int AS n FROM chat_entity_locks
        WHERE chat_session_id = \${process.env.CHAT_SESSION_ID}::uuid
      \`;
      process.stdout.write(String(rows[0]?.n ?? 0));
    });
    await sql.end();
    `,
    { CHAT_SESSION_ID: chatSessionId },
  );
  const n = Number.parseInt(out.trim(), 10);
  if (n !== 0) {
    throw new Error(
      `assertNoOrphanLocks: chat_entity_locks has ${n} rows for chat session ${chatSessionId} after Stage/Publish (v0.10.19 regression class).`,
    );
  }
}

/**
 * Grep the captured admin stderr for the two diag-log strings the
 * chat-runner emits when something went wrong:
 *
 *   - `[chat-runner] empty-response`  (v0.10.17 regression class)
 *   - `[chat-runner] passive-response-diag`  (v0.10.21 regression class)
 *
 * Either appearance fails the scenario with a quoted snippet of the
 * matching line so the operator can act on it.
 */
const DIAG_PATTERNS = [
  /\[chat-runner\] empty-response\b.*/,
  /\[chat-runner\] passive-response-diag\b.*/,
] as const;

export function assertNoChatRunnerDiagWarnings(): void {
  if (!existsSync(ADMIN_LOG_PATH)) {
    throw new Error(
      `assertNoChatRunnerDiagWarnings: ${ADMIN_LOG_PATH} not found — global-setup did not capture admin stderr.`,
    );
  }
  const log = readFileSync(ADMIN_LOG_PATH, "utf8");
  for (const pattern of DIAG_PATTERNS) {
    const m = log.match(pattern);
    if (m) {
      throw new Error(
        `assertNoChatRunnerDiagWarnings: regression-guard pattern hit. Matched: "${m[0].slice(0, 200)}". See ${ADMIN_LOG_PATH} for the full context.`,
      );
    }
  }
}

/**
 * `getStagingUrl()` / `getProductionUrl()` resolve the URLs the
 * scenario fetches after Stage / Publish. The Stage action's response
 * already includes `previewUrl`, but the production URL is a stack
 * config (no form-action returns it), so we read it from env.
 */
export function getStagingUrl(): string {
  return process.env.CAELO_STAGING_BASE_URL ?? "http://localhost:8081";
}

export function getProductionUrl(): string {
  return process.env.CAELO_PRODUCTION_BASE_URL ?? "http://localhost:8082";
}

/**
 * Take a full-page screenshot of the published page and ask Anthropic
 * vision whether it renders correctly. Returns the parsed verdict so
 * the scenario can call `expect(verdict.ok).toBe(true)` and surface
 * `verdict.reason` on failure.
 *
 * The HTTP / parsing / retry logic lives in `./lib/vision-verdict.ts`
 * (Playwright-free, unit-tested).
 */
export async function verifyPublishedPageWithVision(page: Page): Promise<VisionVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY_E2E;
  if (!apiKey) {
    throw new Error(
      "verifyPublishedPageWithVision: ANTHROPIC_API_KEY_E2E is unset (global-setup should have caught this).",
    );
  }
  const buffer = await page.screenshot({ fullPage: true, type: "png" });
  return fetchVisionVerdict({
    apiKey,
    screenshotBase64: buffer.toString("base64"),
    mediaType: "image/png",
  });
}
