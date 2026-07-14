// SPDX-License-Identifier: MPL-2.0

/**
 * issue #303 — empty "Status:" notes and crawl-wait status spam.
 *
 *   1. The stream endpoint rejects empty/whitespace content with a 400
 *      naming the contract ("must not post"), so no producer can persist
 *      a contentless system-origin row.
 *   2. Legacy empty system-origin rows (persisted before the boundary
 *      landed) never render — no bare "Status:" label in the transcript.
 *   3. Consecutive near-identical crawl-wait ticks collapse to ONE
 *      status line (the latest), while distinct statuses stay visible.
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
const PROVIDER = `status-notes-${ts}`;
const BASE = "http://localhost:4173";

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
});

test("no empty status notes render; crawl ticks collapse; boundary 400s empty content", async ({
  context,
  page,
}) => {
  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "Understood — standing by." },
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

  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  const sessionId = page.url().split("/").pop() ?? "";
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

  // Drive one mock-AI turn and capture the CSRF token the panel sends,
  // so the boundary probe below runs as a fully-authenticated client.
  // Target the composer by its testid: the chat route now also renders a
  // rename `input[name="title"]`, so a bare getByRole("textbox") matches
  // two elements and fails Playwright strict mode.
  const composer = page.getByTestId("chat-composer");
  await composer.fill("hello");
  const reqPromise = page.waitForRequest(/\/content\/chat\/[^/]+\/stream$/);
  await composer.press("Enter");
  const streamReq = await reqPromise;
  const csrfToken = streamReq.headers()["x-csrf-token"] ?? "";
  expect(csrfToken).not.toBe("");
  await expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "idle", {
    timeout: 20_000,
  });

  // (1) Boundary: empty + whitespace content → 400 naming the contract,
  // for both operator and system-origin sends. Nothing is persisted.
  for (const body of [
    { content: "", chips: [] },
    { content: "   \n\t ", chips: [], origin: "system" },
  ]) {
    const res = await page.request.fetch(`${BASE}/content/chat/${sessionId}/stream`, {
      method: "post",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      data: body,
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("must not post");
  }

  // (2)+(3) Seed transcript rows straight into chat_messages, bypassing
  // the Zod boundary — exactly what legacy pre-#303 rows look like:
  // one EMPTY system-origin row, two near-identical crawl ticks, one
  // distinct final status.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const content of [
        "",
        "Crawling… 5/50 pages",
        "Crawling… 31/50 pages",
        "Crawl finished: run reached ready_for_review (31 pages staged).",
      ]) {
        await tx\`
          INSERT INTO chat_messages (chat_session_id, role, content, origin, status)
          VALUES (\${process.env.SESSION_ID}::uuid, 'user', \${content}, 'system', 'complete')\`;
      }
    });
    await sql.end();
    `,
    { SESSION_ID: sessionId },
  );

  await page.reload();
  const notes = page.getByTestId("chat-status-note");
  // Empty row dropped; two crawl ticks collapsed into one; the distinct
  // final status stays → exactly 2 rendered notes.
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText("Crawling… 31/50 pages");
  await expect(notes.nth(1)).toContainText("Crawl finished");
  for (const text of await notes.allInnerTexts()) {
    // No bare "Status:" label — every rendered note carries a body.
    expect(text.replace(/^\s*Status:\s*/i, "").trim().length).toBeGreaterThan(0);
  }
});
