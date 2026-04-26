// SPDX-License-Identifier: MPL-2.0

/**
 * Site memory proposal end-to-end:
 *   - AI proposes a memory addition mid-chat (tool call site_memory.propose)
 *   - Owner sees the queue at /security/ai/memory-proposals
 *   - Owner accepts → memory body updates
 *   - The accepted body shows up at /security/ai/memory
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const FIXTURE_PATH = "/tmp/caelo-ai-fixture.json";
const PROPOSAL_BODY = "use sentence case for CTAs";
const PROPOSAL_RATIONALE = "user repeatedly fixed CTA capitalization";

test.afterEach(() => {
  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
  // Clean up the slot + proposal — independent of the test outcome.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM site_memory_proposals WHERE rationale = \${process.env.RATIONALE}\`;
      await tx\`DELETE FROM site_ai_memory WHERE slot = 'instructions' AND body = \${process.env.BODY}\`;
    });
    await sql.end();
    `,
    { RATIONALE: PROPOSAL_RATIONALE, BODY: PROPOSAL_BODY },
  );
});

test("AI proposes memory → Owner accepts → memory updates", async ({ page }) => {
  // Single-shot fixture: one tool call to site_memory.propose, then end_turn.
  // The chat-runner loop expects a continuation after a tool_use stop, so
  // ship a second iteration that just acknowledges.
  writeFileSync(
    FIXTURE_PATH,
    JSON.stringify([
      [
        {
          kind: "tool-call",
          id: "tu_mem",
          name: "site_memory.propose",
          arguments: {
            slot: "instructions",
            body: PROPOSAL_BODY,
            rationale: PROPOSAL_RATIONALE,
          },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "Queued a memory proposal for your review." },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]),
  );

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Drive the chat to fire the tool call.
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.locator("textarea").fill("propose a memory addition");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/Queued a memory proposal/i)).toBeVisible({ timeout: 15_000 });

  // Owner reviews the proposal queue.
  await page.goto("/security/ai/memory-proposals");
  await expect(page.getByText(PROPOSAL_BODY)).toBeVisible();
  await expect(page.getByText(PROPOSAL_RATIONALE)).toBeVisible();

  // Accept it.
  const acceptForm = page
    .locator("li")
    .filter({ hasText: PROPOSAL_BODY })
    .locator("form")
    .filter({ hasText: "Accept" })
    .first();
  await acceptForm.getByRole("button", { name: /accept/i }).click();
  await expect(page.getByText(/Decision recorded/i)).toBeVisible();

  // Memory editor now shows the accepted body in the instructions slot.
  // Textarea content is the value attribute / inner text — Playwright's
  // toHaveValue is the right matcher.
  await page.goto("/security/ai/memory");
  // Each slot has its own form; the instructions one is identified by
  // the matching <h2>instructions</h2> heading just above its textarea.
  const instructionsTextarea = page
    .locator("form")
    .filter({ has: page.locator('input[name="slot"][value="instructions"]') })
    .locator("textarea");
  await expect(instructionsTextarea).toHaveValue(PROPOSAL_BODY);
});
