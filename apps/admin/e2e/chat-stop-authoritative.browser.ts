// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #664 / #665 — Stop is authoritative, and the operator sees every
 * agent working in a chat.
 *
 *   1. A turn started by ANOTHER client (not this panel's stream) shows in
 *      the running-agents bar once the operator returns to the tab (#1215:
 *      no timer polling); its Stop ends the turn server-side — no
 *      further tool call lands — and a later auto-sent nudge is refused.
 *      The stream that started the turn stays connected the whole time, so
 *      only the server-side Stop can have ended it (on 2026-10-12 the
 *      browser's fetch abort never reached the server behind Cloud Run).
 *   2. An external Power-MCP agent working in the chat is listed; the Live
 *      Edit AI does not start while it works; Stop blocks the agent's next
 *      call until "Allow again".
 */

import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  mintAdminMcpToken,
  registerTestProvider,
  runBunInline,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const BASE = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const PROVIDER = `stop-authoritative-${Date.now()}`;
const PROVIDER_ANSWER = `stop-authoritative-answer-${Date.now()}`;

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  await clearTestProvider(BASE, PROVIDER_ANSWER);
});

// Issue #665 — this spec's own Owner: its long turn and its external agent
// must never land in a parallel spec's Live Edit chat (Live Edit resumes the
// operator's most recent chat).
const OWNER_EMAIL = "stop-e2e-owner@example.com";

async function login(page: Page): Promise<void> {
  ensureIsolatedOwner(OWNER_EMAIL);
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

/** Tool rows the server persisted for the chat (what the AI actually did). */
function toolRowCount(sessionId: string): number {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const n = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`SELECT count(*)::int AS n FROM chat_messages
        WHERE chat_session_id = \${process.env.SESSION_ID}::uuid AND role = 'tool'\`;
      return rows[0].n;
    });
    process.stdout.write(String(n));
    await sql.end();
    `,
    { SESSION_ID: sessionId },
  );
  return Number(out.trim());
}

const toolStep = (i: number) => [
  { kind: "tool-call", id: `tc-stop-${i}`, name: "list_pages", arguments: {} },
  { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
  { kind: "done", stopReason: "tool_use" },
];

test("Stop in the running-agents bar ends a turn another client started, server-side", async ({
  context,
  page,
}) => {
  // Step 0 answers the panel's first message (to learn the CSRF token);
  // steps 1-8 are the long turn: eight tool calls, 1.5 s apart.
  await registerTestProvider(
    BASE,
    PROVIDER,
    [
      [
        { kind: "text-delta", text: "Ready." },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
      ...Array.from({ length: 8 }, (_, i) => toolStep(i)),
      [
        { kind: "text-delta", text: "Built." },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ],
    1_500,
  );
  await attachTestProviderHeader(context, PROVIDER);
  await login(page);
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  const sessionId = page.url().split("/").pop() ?? "";

  const composer = page.getByTestId("chat-composer");
  await composer.fill("hello");
  const reqPromise = page.waitForRequest(/\/content\/chat\/[^/]+\/stream$/);
  await composer.press("Enter");
  const csrfToken = (await reqPromise).headers()["x-csrf-token"] ?? "";
  await expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "idle", {
    timeout: 20_000,
  });

  // Another client starts the long turn; its stream stays open.
  const other = page.request.post(`${BASE}/content/chat/${sessionId}/stream`, {
    headers: { "x-csrf-token": csrfToken, "x-caelo-test-provider": PROVIDER },
    data: { content: "Build the pricing page.", chips: [] },
    timeout: 60_000,
  });

  const row = page.getByTestId("chat-agent-row").filter({ hasText: "Live Edit AI" });
  // #1215 — an idle tab polls nothing, so it learns of a turn another
  // client started when the operator comes back to it (focus / visibility).
  // From then on it waits on that running agent and follows it live.
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(row).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 10_000 });
  await expect.poll(() => toolRowCount(sessionId), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await row.getByTestId("chat-agent-stop").click();

  const stoppedAt = Date.now();
  const res = await other;
  expect(Date.now() - stoppedAt).toBeLessThan(10_000);
  expect(await res.text()).toContain('"kind":"interrupted"');
  const afterStop = toolRowCount(sessionId);
  expect(afterStop).toBeLessThan(8);
  // Long enough for two more steps had the turn gone on.
  await page.waitForTimeout(4_000);
  expect(toolRowCount(sessionId)).toBe(afterStop);
  await expect(page.getByTestId("chat-agents-bar")).toHaveCount(0, { timeout: 10_000 });

  // An auto-sent nudge (any tab, any client) does not restart the AI.
  const nudge = await page.request.post(`${BASE}/content/chat/${sessionId}/stream`, {
    headers: { "x-csrf-token": csrfToken, "x-caelo-test-provider": PROVIDER },
    data: {
      content: "Approved: proposal abcd1234 applied. Please continue.",
      chips: [],
      origin: "system",
    },
  });
  expect(await nudge.text()).toContain("chat-stopped");
});

async function mcpTool(
  request: APIRequestContext,
  token: string,
  chatSessionId: string,
  toolName: string,
  args: object,
): Promise<{ ok: boolean; content: string }> {
  const res = await request.post("/api/mcp/tool", {
    headers: { "x-caelo-mcp-token": token },
    data: { chatSessionId, toolName, args },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as { ok: boolean; content: string };
}

test("an external agent working in the chat is listed, keeps the Live Edit AI out, and Stop blocks it", async ({
  context,
  page,
  request,
}) => {
  // A configured (fake) AI, so the refusal comes from the running-agents
  // gate and not from a missing provider.
  await registerTestProvider(BASE, PROVIDER_ANSWER, [
    [
      { kind: "text-delta", text: "On it." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER_ANSWER);
  const token = mintAdminMcpToken(ensureIsolatedOwner(OWNER_EMAIL), "stop-e2e agent");
  const sessionRes = await request.post("/api/mcp/session", {
    headers: { "x-caelo-mcp-token": token },
    data: { newSession: true, title: `stop-e2e-${Date.now()}` },
  });
  expect(sessionRes.ok()).toBe(true);
  const { chatSessionId } = (await sessionRes.json()) as { chatSessionId: string };
  const slug = `stop-e2e-${Date.now().toString(36)}`;
  // Any routine write that needs no AI and no fixture page: a redirect to
  // the site root (always a valid target). This spec is about Stop.
  const write = (s: string) => ({
    items: [{ fromPath: `/${s}`, toPath: "/", statusCode: 301 }],
  });
  expect(
    (await mcpTool(request, token, chatSessionId, "bulk_create_redirects", write(slug))).ok,
  ).toBe(true);

  await login(page);
  await page.goto(`/content/chat/${chatSessionId}`);
  const agent = page.getByTestId("chat-agent-row").filter({ hasText: "stop-e2e agent" });
  await expect(agent).toBeVisible({ timeout: 10_000 });

  // The Live Edit AI does not start while the external agent works.
  const composer = page.getByTestId("chat-composer");
  await composer.fill("Build the homepage.");
  await composer.press("Enter");
  await expect(page.getByTestId("chat-error")).toContainText("external agent", { timeout: 15_000 });

  await agent.getByTestId("chat-agent-stop").click();
  await expect(agent.getByTestId("chat-agent-allow")).toBeVisible({ timeout: 10_000 });
  const refused = await mcpTool(
    request,
    token,
    chatSessionId,
    "bulk_create_redirects",
    write(`${slug}-b`),
  );
  expect(refused.ok).toBe(false);
  expect(refused.content).toContain("stopped_by_operator");

  await agent.getByTestId("chat-agent-allow").click();
  await expect(agent.getByTestId("chat-agent-allow")).toHaveCount(0, { timeout: 10_000 });
  expect(
    (await mcpTool(request, token, chatSessionId, "bulk_create_redirects", write(`${slug}-c`))).ok,
  ).toBe(true);
});
