// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — the editor does not poll the admin on a timer (CLAUDE.md
 * §11.B: every request keeps an instance up).
 *
 *   1. An idle editor tab — the chat page and Live Edit — makes no request
 *      at all for longer than every former poll interval (agents 3 s,
 *      indicator 5 s, pending 10 s).
 *   2. During a turn the surfaces still update live: the turn's own stream
 *      carries `{kind: "live"}` topics, the running-agents bar shows the
 *      turn while it runs and drops it when it ends, and the tab holds no
 *      separate wait meanwhile (the stream stands in for it).
 *
 * The approval card and the one-time credentials during a turn are covered
 * by credential-handoff.browser.ts; a running quality audit settling into
 * the chat by quality-fix-offer.browser.ts.
 */

import { expect, type Page, type Request, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  registerTestProvider,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const BASE = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const PROVIDER = `live-refresh-${Date.now()}`;
// Its own Owner: Live Edit resumes the operator's most recent chat, which
// must never be a parallel spec's.
const OWNER_EMAIL = "live-refresh-e2e-owner@example.com";
/** Longer than every former poll interval (3 s, 5 s, 10 s) together with slack. */
const IDLE_WINDOW_MS = 12_000;

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
});

async function login(page: Page): Promise<void> {
  ensureIsolatedOwner(OWNER_EMAIL);
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

async function newChat(page: Page): Promise<string> {
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  return page.url().split("/").pop() ?? "";
}

/** Every request the page (and its frames) sends to the admin from now on. */
function recordAdminRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(BASE)) seen.push(r);
  });
  return seen;
}

const describe = (rs: Request[]) => rs.map((r) => `${r.method()} ${r.url().slice(BASE.length)}`);

test("an idle editor tab makes no request to the admin", async ({ page }) => {
  test.setTimeout(90_000);
  // The header indicator lists every chat's agents for an Owner, and a tab
  // rightly waits on a running one — parallel specs run agents all the
  // time. Seen from this tab, nothing runs.
  await page.route("**/api/agents", (route) => route.fulfill({ json: { runs: [] } }));
  await login(page);
  await newChat(page);
  await page.waitForLoadState("networkidle");
  const onChat = recordAdminRequests(page);
  await page.waitForTimeout(IDLE_WINDOW_MS);
  expect(describe(onChat)).toEqual([]);

  // Live Edit: the preview, the toolbar's quality gate, the header's
  // agents indicator and notification bell — still nothing on a clock.
  await page.goto("/edit");
  await page.waitForLoadState("networkidle");
  const onEdit = recordAdminRequests(page);
  await page.waitForTimeout(IDLE_WINDOW_MS);
  expect(describe(onEdit)).toEqual([]);
});

test("during a turn the stream's live topics keep the agents bar current", async ({
  context,
  page,
}) => {
  // Three steps 1.5 s apart: long enough to watch the turn run.
  await registerTestProvider(
    BASE,
    PROVIDER,
    [
      [
        { kind: "tool-call", id: `tc-live-1-${Date.now()}`, name: "list_pages", arguments: {} },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "tool-call", id: `tc-live-2-${Date.now()}`, name: "list_pages", arguments: {} },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "All pages listed." },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ],
    1_500,
  );
  await attachTestProviderHeader(context, PROVIDER);
  // As above: parallel specs' agents would make the header indicator wait.
  await page.route("**/api/agents", (route) => route.fulfill({ json: { runs: [] } }));
  await login(page);
  const sessionId = await newChat(page);
  const composer = page.getByTestId("chat-composer");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("List the pages.");
  const streamBody = page
    .waitForResponse(
      (r) =>
        r.url().endsWith(`/content/chat/${sessionId}/stream`) && r.request().method() === "POST",
    )
    .then((r) => r.text());
  const requests = recordAdminRequests(page);
  await composer.press("Enter");

  // The running turn shows up in the bar while it runs …
  const row = page.getByTestId("chat-agent-row").filter({ hasText: "Live Edit AI" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Still mid-turn (three steps 1.5 s apart): what the tab asked for so far.
  await page.waitForTimeout(1_500);
  const duringTurn = describe(requests);
  await expect(page.getByText("All pages listed.")).toBeVisible({ timeout: 20_000 });
  // … and the turn leaves the bar once it has ended.
  await expect(page.getByTestId("chat-agents-bar")).toHaveCount(0, { timeout: 10_000 });

  // The stream carried the topics (the agent run registered and finished).
  const body = await streamBody;
  expect(body).toMatch(/"kind":"live","topics":\[[^\]]*"agents"/);

  // The tab held no wait of its own while its stream was open: the
  // stream's topics stood in for it, and the agents reads were reactions.
  expect(duringTurn.filter((p) => p.includes("/api/live-events"))).toEqual([]);
  expect(duringTurn).toContain(`GET /content/chat/${sessionId}/agents`);
});
