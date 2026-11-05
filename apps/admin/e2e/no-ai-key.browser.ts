// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1460 — a fresh install without an AI key, from the wizard to an
 * agent's work and back to a key.
 *
 * Runs in its own Playwright project, after every other spec: it takes the
 * providers away from the whole install, which the parallel specs need.
 * Local run: `playwright test --project no-ai-key --no-deps`.
 */

import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.describe.configure({ mode: "serial", timeout: 180_000 });

const OWNER_EMAIL = "dev-owner@example.com";
const OWNER_PASSWORD = "dev owner password";
const TOKEN_NAME = `no-key-agent-${Date.now()}`;

/** State shared along the serial flow: what the Owner minted for the agent. */
let agentToken = "";
let agentSession = "";

function fixture(op: "no-provider" | "restore" | "count-providers"): string {
  return runBunInline(
    `
    import { SQL } from "bun";
    const op = process.env.E2E_OP;
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const out = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      if (op === "count-providers") {
        const rows = await tx\`SELECT count(*)::int AS n FROM ai_providers WHERE is_active\`;
        return String(rows[0].n);
      }
      await tx\`DELETE FROM mcp_only_mode\`;
      // As on a fresh install: no key anywhere, so "Activate" is disabled.
      await tx\`
        UPDATE ai_providers
           SET is_active = false, api_key_encrypted = NULL, api_key_iv = NULL,
               api_key_kek_fp = NULL, api_key_set_at = NULL
      \`;
      if (op === "restore") {
        await tx\`
          UPDATE ai_providers
             SET is_active = true, api_key_encrypted = decode('00', 'hex'),
                 api_key_iv = decode('00', 'hex'), api_key_kek_fp = 'e2e-seed', api_key_set_at = now()
           WHERE name IN ('anthropic', 'google')
        \`;
      }
      return "";
    });
    process.stdout.write(out);
    await sql.end();
    `,
    { E2E_OP: op },
  ).trim();
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
}

async function mcpPost<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(path, { headers: { "x-caelo-mcp-token": agentToken }, data });
  expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test.beforeAll(() => {
  fixture("no-provider");
});

// Every test signs in afresh; the limiter allows five logins in five minutes.
test.beforeEach(clearLoginRateBucket);

test.afterAll(() => {
  fixture("restore");
});

test("the wizard preselects no key and reaches Settings → MCP in one click", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/welcome\/ai$/, { timeout: 60_000 });

  await expect(page.getByRole("radio", { name: /No AI key/ })).toBeChecked();
  await expect(page.getByText(/Live Edit chat and the AI work of the install/)).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveCount(0);

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/settings\/mcp$/, { timeout: 60_000 });
  expect(fixture("count-providers")).toBe("0");
});

test("Settings → MCP leads with the token; a chat token is not on offer", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/edit/, { timeout: 60_000 });
  await page.goto("/settings/mcp");

  const lead = page.getByTestId("mcp-only-lead");
  await expect(lead).toBeVisible();
  await expect(page.getByTestId("mcp-only-command")).toContainText("claude mcp add caelo-admin");

  await expect(page.getByLabel("Scope")).toHaveValue("admin");
  await expect(page.locator('#scope option[value="chat"]')).toBeDisabled();
  await expect(page.getByTestId("mcp-chat-scope-unavailable")).toContainText("no AI key");

  await lead.getByLabel("Name").fill(TOKEN_NAME);
  await lead.getByRole("button", { name: "Create token" }).click();
  const created = page.locator("pre code").first();
  await expect(created).toBeVisible({ timeout: 60_000 });
  agentToken = (await created.textContent()) ?? "";
  expect(agentToken).toMatch(/^mcp_/);
  await expect(page.getByTestId("mcp-setup-claude-code")).toBeVisible();
});

test("Live Edit shows the notice instead of a composer and keeps everything else", async ({
  page,
}) => {
  await login(page);
  await expect(page).toHaveURL(/\/edit/, { timeout: 60_000 });

  const notice = page.getByTestId("chat-no-ai-key-notice");
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice.getByRole("link", { name: /Settings → AI/ })).toHaveAttribute(
    "href",
    "/settings/ai",
  );
  await expect(notice.getByRole("link", { name: /Settings → MCP/ })).toHaveAttribute(
    "href",
    "/settings/mcp",
  );
  await expect(page.getByTestId("chat-send")).toHaveCount(0);

  await page.goto("/settings/ai");
  await expect(page.getByTestId("ai-mcp-only-mode")).toContainText("Power-MCP only");
});

test("an agent builds and stages with no key; its approval card works in the chat", async ({
  page,
  request,
}) => {
  const session = await mcpPost<{ chatSessionId: string }>(request, "/api/mcp/session", {
    title: `no-key-agent-${Date.now()}`,
  });
  agentSession = session.chatSessionId;
  const tool = (toolName: string, args: unknown) =>
    mcpPost<{ ok: boolean; content: string; approval: { proposalId: string } | null }>(
      request,
      "/api/mcp/tool",
      { toolName, args, chatSessionId: agentSession },
    );

  const context = await mcpPost<{ systemContext: string }>(request, "/api/mcp/context", {});
  expect(context.systemContext).toContain("This install runs without an AI key");

  const slug = `no-key-${Date.now()}`;
  const built = await tool("build_page", {
    page: {
      slug,
      title: "Built without a key",
      pageType: "home",
      status: "published",
      metaDescription: "A page an external agent built on an install without an AI key.",
    },
    modules: [
      {
        blockName: "content",
        displayName: `No key hero ${slug}`,
        kind: "hero",
        description: "The hero of the page the no-key flow builds.",
        html: "<section><h1>{{hero_title}}</h1></section>",
        fields: [{ name: "hero_title", kind: "text", label: "Hero title" }],
        content: { source: "inline", values: { hero_title: "Built without a key" } },
      },
    ],
  });
  expect(built.ok, built.content).toBe(true);

  const staged = await tool("stage_changes", {});
  expect(staged.content).not.toContain("AI provider not configured");
  expect(staged.content).not.toContain("NoInstallAi:");
  const audit = await tool("get_quality_audit", {});
  expect(audit.content).not.toContain("AI provider not configured");

  const image = await tool("generate_image", { prompt: "a red square" });
  expect(image.ok).toBe(false);
  expect(image.content).toContain("AiDelegated:");

  const card = await tool("propose_create_mcp_token", {
    displayName: `no-key-approved-${Date.now()}`,
    scope: "admin",
  });
  const proposalId = card.approval?.proposalId;
  expect(proposalId).toBeTruthy();

  await login(page);
  await expect(page).toHaveURL(/\/edit/, { timeout: 60_000 });
  // The page the agent built opens in Live Edit, with Stage and Publish live.
  await expect(page.getByTestId("stage-deploy")).toBeVisible({ timeout: 60_000 });
  await page.goto(`/content/chat/${agentSession}`);
  await expect(page.getByTestId("chat-no-ai-key-notice")).toBeVisible();
  const row = page
    .getByTestId("chat-pending-strip")
    .locator("li")
    .filter({ hasText: (proposalId as string).slice(0, 8) });
  await row.getByTestId("pending-approve").click();
  await expect(
    page.getByTestId("chat-mcp-handoff").filter({ hasText: "Approved and applied" }),
  ).toBeVisible({ timeout: 60_000 });
});

test("the stream refuses with the mode's error", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/edit/, { timeout: 60_000 });
  await page.goto("/settings/mcp");
  const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
  const res = await page.request.post(`/content/chat/${agentSession}/stream`, {
    headers: { "x-csrf-token": csrf },
    data: { content: "hello" },
  });
  const body = await res.text();
  expect(body).toContain('"code":"no_install_ai"');
  expect(body).not.toContain("AI provider not configured");
});

test("a key under Settings → AI brings the composer back at once", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/edit/, { timeout: 60_000 });
  await page.goto("/settings/ai");
  const form = page
    .locator("form")
    .filter({ has: page.locator('input[value="anthropic"]') })
    .first();
  await form.locator('input[name="apiKey"]').fill("sk-ant-e2e-no-key-flow");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("ai-mcp-only-mode")).toHaveCount(0, { timeout: 60_000 });

  await page.goto("/edit");
  await expect(page.getByTestId("chat-send")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-no-ai-key-notice")).toHaveCount(0);
});
