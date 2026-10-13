// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — what the operator's Approve continues:
 *
 *   1. The chat's own AI paused on an approval card. The operator pressed
 *      Stop, reloaded, and still sees the card; Approve resumes that turn
 *      (the answer to the AI's own question is the go-ahead) and the change
 *      is applied.
 *   2. An external agent's caelo_chat turn paused on an approval card in the
 *      operator's chat. The card says so; Approve records the decision for
 *      the agent (which reads it over /api/mcp/chat/approval) and starts NO
 *      turn of this chat's AI — only a local note in the transcript.
 */

import { expect, type Page, test } from "@playwright/test";
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
const PROVIDER = `approval-resume-${Date.now()}`;

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
});

// Its own Owner (issue #665): Live Edit resumes the operator's most recent
// chat, which must never be a parallel spec's.
const OWNER_EMAIL = "approval-resume-e2e-owner@example.com";

async function login(page: Page): Promise<string> {
  const actorId = ensureIsolatedOwner(OWNER_EMAIL);
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  return actorId;
}

function tokensNamed(displayName: string): number {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const n = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`SELECT count(*)::int AS n FROM mcp_tokens WHERE display_name = \${process.env.NAME}\`;
      return rows[0].n;
    });
    process.stdout.write(String(n));
    await sql.end();
    `,
    { NAME: displayName },
  );
  return Number(out.trim());
}

test("the chat's own AI resumes on Approve after Stop and a reload", async ({ context, page }) => {
  const minted = `approval-resume-live-${Date.now()}`;
  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "I'll mint that token." },
      {
        kind: "tool-call",
        id: `tc-mint-${Date.now()}`,
        name: "propose_create_mcp_token",
        arguments: { displayName: minted },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Minted." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);
  await login(page);
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  const sessionId = page.url().split("/").pop() ?? "";

  const composer = page.getByTestId("chat-composer");
  await composer.fill("Mint a token for the agency.");
  const reqPromise = page.waitForRequest(/\/content\/chat\/[^/]+\/stream$/);
  await composer.press("Enter");
  const csrfToken = (await reqPromise).headers()["x-csrf-token"] ?? "";
  const card = page.getByTestId("chat-approval-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute("data-requested-via", "chat");

  // Stop the chat (what the running-agents bar's Stop posts), then reload.
  const stopped = await page.request.post(`${BASE}/content/chat/${sessionId}/agents`, {
    headers: { "x-csrf-token": csrfToken },
    data: { action: "cancel" },
  });
  expect(stopped.ok(), await stopped.text()).toBe(true);
  await page.reload();
  await expect(card).toBeVisible({ timeout: 15_000 });
  expect(tokensNamed(minted)).toBe(0);

  const resume = page.waitForRequest(
    (r) =>
      r.method() === "POST" &&
      /\/stream$/.test(r.url()) &&
      (r.postData() ?? "").includes('"resumeApproval"'),
  );
  await card.getByTestId("chat-approval-approve").click();
  await resume;
  await expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "idle", {
    timeout: 20_000,
  });
  await expect(page.getByText("Minted.")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => tokensNamed(minted), { timeout: 10_000 }).toBe(1);
  await expect(card).toHaveCount(0);
});

test("an external agent's caelo_chat card records the decision for the agent and starts no chat turn", async ({
  page,
  request,
}) => {
  const actorId = await login(page);
  const agentName = `approval-resume-agent-${Date.now()}`;
  const token = mintAdminMcpToken(actorId, agentName);
  const sessionRes = await request.post("/api/mcp/session", {
    headers: { "x-caelo-mcp-token": token },
    data: { newSession: true, title: `approval-resume-e2e-${Date.now()}` },
  });
  expect(sessionRes.ok()).toBe(true);
  const { chatSessionId } = (await sessionRes.json()) as { chatSessionId: string };
  // The agent's caelo_chat turn paused on this card (the runner records it
  // exactly like this as it pauses — see approval-resume-semantics.integration).
  const approvalId = `e2e-approval-${Date.now()}`;
  runBunInline(
    `
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const tokenId = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`SELECT id::text AS id FROM mcp_tokens WHERE display_name = \${process.env.AGENT}\`;
      return rows[0].id;
    });
    await sql.end();
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const registry = new OperationRegistry(); registerAdminOps(registry);
    const r = await execute(registry, adapter, { actorId: process.env.ACTOR_ID, actorKind: "human", requestId: "e2e-seed-card" }, "chat.record_turn_approvals", {
      chatSessionId: process.env.CHAT_ID, source: "mcp_chat", mcpTokenId: tokenId,
      approvals: [{ approvalId: process.env.APPROVAL_ID, toolCallId: "tc-agent-1", toolName: "propose_create_mcp_token",
        preview: "Create an MCP token\\n  displayName: agency", requiredPermissions: [] }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    await adapter.close();
    `,
    { AGENT: agentName, ACTOR_ID: actorId, CHAT_ID: chatSessionId, APPROVAL_ID: approvalId },
  );
  const agentState = async () => {
    const res = await request.post("/api/mcp/chat/approval", {
      headers: { "x-caelo-mcp-token": token },
      data: { chatSessionId },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { state: string }).state;
  };
  expect(await agentState()).toBe("pending");

  // Any chat-AI turn would POST to the session's stream endpoint.
  const streamPosts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/stream")) streamPosts.push(r.url());
  });
  await page.goto(`/content/chat/${chatSessionId}`);
  const card = page.getByTestId("chat-approval-card");
  await expect(card).toHaveAttribute("data-requested-via", "mcp_chat", { timeout: 15_000 });
  await expect(card.getByTestId("chat-approval-external-agent")).toHaveText(
    "Requested by the external agent (MCP)",
  );

  const decided = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/approvals$/.test(r.url()),
  );
  await card.getByTestId("chat-approval-approve").click();
  expect((await decided).ok()).toBe(true);
  await expect(
    page.getByText("Approved the external agent's (MCP) request: Create an MCP token"),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(await agentState()).toBe("decided");
  await expect(
    page.getByTestId("chat-mcp-handoff").filter({ hasText: "handed back to the external agent" }),
  ).toBeVisible({ timeout: 15_000 });
  // The click started no turn of this chat's AI.
  expect(streamPosts).toEqual([]);
});
