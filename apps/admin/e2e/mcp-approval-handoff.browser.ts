// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — an external agent (Power-MCP) queues an approval-gated
 * proposal in the operator's chat session; the operator decides in that
 * chat. The card says the external agent asked, Approve/Reject never
 * starts a turn of the chat's own AI (no stream request), the strip shows
 * the hand-back, and the agent reads the decision over /api/mcp/approval.
 */

import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  clearLoginRateBucket,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  mintAdminMcpToken,
  runBunInline,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

// Issue #665 — its own Owner: the external agent's work keeps the Live Edit
// AI out of this chat, which must never be a parallel spec's Live Edit chat.
const OWNER_EMAIL = "mcp-handoff-e2e-owner@example.com";

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
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

test("an external agent's proposal is decided in the chat and handed back to the agent", async ({
  page,
  request,
}) => {
  const token = mintAdminMcpToken(ensureIsolatedOwner(OWNER_EMAIL), "mcp-handoff-e2e");
  const session = await mcpPost<{ chatSessionId: string }>(request, token, "/api/mcp/session", {
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
  // A transcript note says so — local to the panel, never sent to the AI.
  await expect(page.getByText(/Approved the external agent's \(MCP\) request/)).toBeVisible();
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

/** Creates `count` draft pages (system actor) and returns their ids. */
function seedPages(prefix: string, count: number): string[] {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const templateId = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`SELECT id::text AS id FROM templates ORDER BY created_at LIMIT 1\`;
      return rows[0]?.id;
    });
    await sql.end();
    if (!templateId) throw new Error("no template to seed pages with");
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const registry = new OperationRegistry(); registerAdminOps(registry);
    const ids = [];
    for (let i = 0; i < Number(process.env.COUNT); i++) {
      const r = await execute(registry, adapter, { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e-seed-pages" }, "pages.create", { slug: process.env.PREFIX + "-" + i, title: process.env.PREFIX + " " + i, templateId });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      ids.push(r.value.pageId);
    }
    process.stdout.write(JSON.stringify(ids));
    await adapter.close();
    `,
    { PREFIX: prefix, COUNT: String(count) },
  );
  return JSON.parse(out.trim()) as string[];
}

// Issue #687 — an SDK-style gated tool (no propose op of its own) called
// over MCP: delete_pages_many with 5+ pages queues in the generic
// tool-approval queue, its card shows in the operator's chat as the
// external agent's, and Approve runs it through the shared apply path
// (approveQueuedToolCall) — the same path an approval-declared plugin tool
// such as set_locales takes.
test("an external agent's needs-approval tool call is approved in the chat and handed back", async ({
  page,
  request,
}) => {
  const token = mintAdminMcpToken(ensureIsolatedOwner(OWNER_EMAIL), "mcp-gated-e2e");
  const session = await mcpPost<{ chatSessionId: string }>(request, token, "/api/mcp/session", {
    title: `mcp-gated-e2e-${Date.now()}`,
  });
  const pageIds = seedPages(`e2e-mcp-gated-${Date.now()}`, 5);
  const called = await mcpPost<{
    ok: boolean;
    content: string;
    approval: { proposalId: string; domain: string } | null;
  }>(request, token, "/api/mcp/tool", {
    toolName: "delete_pages_many",
    args: { items: pageIds.map((pageId) => ({ pageId, disposition: "404" })) },
    chatSessionId: session.chatSessionId,
  });
  expect(called.ok, called.content).toBe(true);
  expect(called.approval?.domain).toBe("tool_approvals");
  const proposalId = called.approval!.proposalId;
  const outcome = async () =>
    (await mcpPost<{ outcome: string }>(request, token, "/api/mcp/approval", { proposalId }))
      .outcome;
  expect(await outcome()).toBe("pending");

  const streamPosts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/stream")) streamPosts.push(r.url());
  });
  await login(page);
  await page.goto(`/content/chat/${session.chatSessionId}`);
  const row = page
    .getByTestId("chat-pending-strip")
    .locator("li")
    .filter({ hasText: proposalId.slice(0, 8) });
  await expect(row.getByTestId("pending-external-agent")).toHaveText(
    "Requested by the external agent (MCP)",
  );
  await row.getByTestId("pending-approve").click();
  await expect(
    page.getByTestId("chat-mcp-handoff").filter({ hasText: "Approved and applied" }),
  ).toBeVisible({ timeout: 15_000 });
  expect(await outcome()).toBe("applied");
  expect(streamPosts).toEqual([]);
});
