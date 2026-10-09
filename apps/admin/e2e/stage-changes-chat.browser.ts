// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part B (PR #624 review) — the AI Stages through the REAL
 * browser chat: the chat stream endpoint runs the turn, the scripted
 * provider calls `stage_changes`, and the tool runs exactly as in
 * production — with the browser chat's AI actor, which is NOT the chat's
 * creator, plus the operator's context. Before the fix the tool ran its
 * ops as the AI actor and every one of them answered "not one of your
 * open chats"; the admin-core suites called the tool with the owner's id
 * and never saw it.
 *
 * Asserted: the tool got past the chat selection and the merge (its result
 * is the Stage's own outcome — the build may or may not run in this stack),
 * and the merge opened the AI production hold for exactly this chat.
 */

import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

const ts = Date.now();
const PROVIDER = `stage-changes-${ts}`;
const BASE = "http://localhost:4173";
const REPLY = `Staged for your review ${ts}.`;
const startedAt = new Date().toISOString();

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  // An open AI hold would stop every later spec's automatic publish.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`UPDATE ai_stage_holds SET released_at = now()
               WHERE released_at IS NULL AND created_at >= \${process.env.STARTED_AT}::timestamptz\`;
    });
    await c.end();
    `,
    { STARTED_AT: startedAt },
  );
});

test("the AI stages from the browser chat and the Stage opens the production hold", async ({
  context,
  page,
}) => {
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_stage_${ts}`,
        name: "stage_changes",
        arguments: { scope: "this_chat" },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: REPLY },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.locator("textarea").fill("stage it");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(REPLY).first()).toBeVisible({ timeout: 60_000 });

  const out = runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    let payload = "{}";
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tool = await tx\`
        SELECT m.chat_session_id::text AS chat, m.content
        FROM chat_messages m
        WHERE m.role = 'tool' AND m.tool_call_id = \${process.env.TOOL_CALL_ID}
        ORDER BY m.created_at DESC LIMIT 1\`;
      const chat = tool[0]?.chat ?? null;
      const holds = chat === null ? [] : await tx\`
        SELECT count(*)::int AS n FROM ai_stage_holds
        WHERE \${chat}::uuid = ANY(chat_session_ids) AND released_at IS NULL\`;
      payload = JSON.stringify({ content: tool[0]?.content ?? null, holds: holds[0]?.n ?? 0 });
    });
    await c.end();
    process.stdout.write(payload);
    `,
    { TOOL_CALL_ID: `tu_stage_${ts}` },
  );
  const { content, holds } = JSON.parse(out) as { content: string | null; holds: number };
  expect(content, "the stage_changes tool result was not recorded").not.toBeNull();
  // Past selection and merge: the result is the Stage's own outcome.
  expect(content).not.toContain("not one of your open chats");
  expect(content).toMatch(/Staging rebuilt|Staged \d+ change|Stage failed \(deploy\)/);
  expect(holds).toBe(1);
});
