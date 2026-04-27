// SPDX-License-Identifier: MPL-2.0

/**
 * Site memory proposal end-to-end:
 *   - AI proposes a memory addition mid-chat (tool call site_memory.propose)
 *   - Owner sees the queue at /security/ai/memory-proposals
 *   - Owner accepts → memory body updates
 *   - The accepted body shows up at /security/ai/memory
 */

import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  runBunInline,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
const PROPOSAL_BODY = `use sentence case for CTAs ${ts}`;
const PROPOSAL_RATIONALE = `user repeatedly fixed CTA capitalization ${ts}`;
const PROVIDER = `site-memory-proposal-${ts}`;
const BASE = "http://localhost:4173";

test.afterEach(async () => {
  await clearTestProvider(BASE, PROVIDER);
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

test("AI proposes memory → Owner accepts → memory updates", async ({ context, page }) => {
  await registerTestProvider(BASE, PROVIDER, [
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
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.locator("textarea").fill("propose a memory addition");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/Queued a memory proposal/i)).toBeVisible({ timeout: 15_000 });

  await page.goto("/security/ai/memory-proposals");
  await expect(page.getByText(PROPOSAL_BODY)).toBeVisible();
  await expect(page.getByText(PROPOSAL_RATIONALE)).toBeVisible();

  const acceptForm = page
    .locator("li")
    .filter({ hasText: PROPOSAL_BODY })
    .locator("form")
    .filter({ hasText: "Accept" })
    .first();
  await acceptForm.getByRole("button", { name: /accept/i }).click();
  await expect(page.getByText(/Decision recorded/i)).toBeVisible();

  await page.goto("/security/ai/memory");
  const instructionsTextarea = page
    .locator("form")
    .filter({ has: page.locator('input[name="slot"][value="instructions"]') })
    .locator("textarea");
  await expect(instructionsTextarea).toHaveValue(PROPOSAL_BODY);
});
