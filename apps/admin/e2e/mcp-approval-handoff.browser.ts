// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — an external agent (Power-MCP) queues an approval-gated
 * proposal in the operator's chat session; the operator decides in that
 * chat. The card says the external agent asked, Approve/Reject never
 * starts a turn of the chat's own AI (no stream request), the strip shows
 * the hand-back, and the agent reads the decision over /api/mcp/approval.
 */

import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

function mintAdminToken(): string {
  const out = runBunInline(`
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    const actorId = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`SELECT id::text FROM users WHERE email = 'dev-owner@example.com'\`;
      return rows[0].id;
    });
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const registry = new OperationRegistry(); registerAdminOps(registry);
    const r = await execute(registry, adapter, { actorId, actorKind: "human", requestId: "mcp-handoff-e2e" }, "mcp_tokens.create", { displayName: "mcp-handoff-e2e", scope: "admin" });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    process.stdout.write(r.value.plaintextToken);
    await adapter.close(); await db.end();
  `);
  return out.trim();
}

async function mcpPost<T>(
  request: APIRequestContext,
  token: string,
  path: string,
  data: unknown,
): Promise<T> {
  const res = await request.post(path, { headers: { "x-caelo-mcp-token": token }, data });
  expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

test("an external agent's proposal is decided in the chat and handed back to the agent", async ({
  page,
  request,
}) => {
  const token = mintAdminToken();
  const session = await mcpPost<{ chatSessionId: string }>(request, token, "/api/mcp/session", {
    newSession: true,
    title: `mcp-handoff-e2e-${Date.now()}`,
  });
  const propose = async (displayName: string) =>
    (
      await mcpPost<{ approval: { proposalId: string } | null; content: string }>(
        request,
        token,
        "/api/mcp/tool",
        {
          toolName: "propose_create_mcp_token",
          args: { displayName },
          chatSessionId: session.chatSessionId,
        },
      )
    ).approval?.proposalId;
  const approveId = await propose(`e2e-approve-${Date.now()}`);
  const rejectId = await propose(`e2e-reject-${Date.now()}`);
  expect(approveId).toBeTruthy();
  expect(rejectId).toBeTruthy();

  const outcome = async (proposalId: string) =>
    (
      await mcpPost<{ outcome: string }>(request, token, "/api/mcp/approval", {
        proposalId,
      })
    ).outcome;
  expect(await outcome(approveId!)).toBe("pending");

  // Any chat-AI turn would POST to the session's stream endpoint.
  const streamPosts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/stream")) streamPosts.push(r.url());
  });

  await login(page);
  await page.goto(`/content/chat/${session.chatSessionId}`);
  const strip = page.getByTestId("chat-pending-strip");
  const row = (id: string) => strip.locator("li").filter({ hasText: id.slice(0, 8) });
  await expect(row(approveId!).getByTestId("pending-external-agent")).toHaveText(
    "Requested by the external agent (MCP)",
  );

  await row(approveId!).getByTestId("pending-approve").click();
  const handoff = page.getByTestId("chat-mcp-handoff").filter({ hasText: "Approved and applied" });
  await expect(handoff).toBeVisible({ timeout: 15_000 });
  await expect(handoff).toContainText("handed back to the external agent");
  expect(await outcome(approveId!)).toBe("applied");

  await row(rejectId!).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByTestId("chat-mcp-handoff").filter({ hasText: "Rejected" })).toBeVisible({
    timeout: 15_000,
  });
  expect(await outcome(rejectId!)).toBe("rejected");

  // The agent picked both decisions up; a refresh shows that.
  await page.reload();
  await expect(page.locator('[data-testid="chat-mcp-handoff"][data-delivered="true"]')).toHaveCount(
    2,
  );
  await expect(page.getByTestId("chat-mcp-handoff").first()).toContainText(
    "received the result and continues from there",
  );

  // Neither click started a turn of this chat's own AI.
  expect(streamPosts).toEqual([]);
});
