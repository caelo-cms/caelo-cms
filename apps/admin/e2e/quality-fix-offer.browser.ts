// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #685 — after a Stage, quality-check problems never start the Live
 * Edit AI on their own. The chat shows "Let the AI fix them?" and only the
 * operator's click starts a turn:
 *
 *   1. Operator Stage with findings → the card shows and NO /stream request
 *      goes out; "Fix with AI" sends one turn whose message carries the
 *      findings, the page and who staged.
 *   2. "Not now" → a status note, the card goes, nothing runs, Publish live
 *      stays blocked.
 *   3. An external agent works in the chat (#682) → the click is refused
 *      with a clear message and no turn starts.
 *
 * The settled audit of the Stage is seeded straight into the tables (the
 * shape the audit worker writes; Lighthouse does not run in this stack).
 * The Stage → enqueue → staged_by path itself is covered by the admin-core
 * integration suite (quality-gate / stage-chats-open-changes).
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
// Each test seeds the newest staging build; only the newest one's audit
// drives a chat, so the tests run one after another.
test.describe.configure({ mode: "serial" });

const BASE = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const PROVIDER = `quality-fix-offer-${Date.now()}`;
// This spec's own Owner, so its chats never become another spec's Live
// Edit chat (and the other way round).
const OWNER_EMAIL = "quality-offer-e2e-owner@example.com";
const seededRuns: string[] = [];

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  if (seededRuns.length === 0) return;
  // The deploy runs cascade to their audits: the site's staging gate is
  // back to what it was before this spec.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const id of JSON.parse(process.env.RUN_IDS)) {
        await tx\`DELETE FROM deploy_runs WHERE id = \${id}::uuid\`;
      }
    });
    await sql.end();
    `,
    { RUN_IDS: JSON.stringify(seededRuns) },
  );
});

async function login(page: Page): Promise<string> {
  const ownerId = ensureIsolatedOwner(OWNER_EMAIL);
  // Three logins in a row, next to parallel specs' logins: stay under the
  // per-IP login limit.
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  return ownerId;
}

async function newChat(page: Page): Promise<string> {
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  return page.url().split("/").pop() ?? "";
}

const SLUG = `qfo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const PAGE_PATH = `/${SLUG}`;

// The audited page: this spec's own published page (a fresh e2e database
// has none, and the audit must name a real page).
test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const s = process.env.SLUG;
      const lay = await tx\`INSERT INTO layouts (slug, display_name, html, css)
        VALUES (\${s + "-lay"}, 'L',
                '<!doctype html><html><head><title>{{title}}</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
                '') RETURNING id\`;
      const tpl = await tx\`INSERT INTO templates (slug, display_name, kind, html, css, layout_id)
        VALUES (\${s + "-tpl"}, 'T', 'content', '<main><caelo-slot name="content">_</caelo-slot></main>',
                '', \${lay[0].id}) RETURNING id\`;
      await tx\`INSERT INTO pages (slug, name, title, template_id, status, current_path)
        VALUES (\${s}, \${s}, 'Quality offer', \${tpl[0].id}, 'published', \${process.env.PAGE_PATH})\`;
    });
    await sql.end();
    `,
    { SLUG, PAGE_PATH },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const s = process.env.SLUG;
      await tx\`DELETE FROM pages WHERE slug = \${s}\`;
      await tx\`DELETE FROM templates WHERE slug = \${s + "-tpl"}\`;
      await tx\`DELETE FROM layouts WHERE slug = \${s + "-lay"}\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
});

/**
 * A settled audit of this chat's Stage that found one problem on this
 * spec's page: a fresh succeeded staging run (so it is the build Publish
 * would ship) plus its `problems` audit.
 */
function seedProblemAudit(
  chatSessionId: string,
  ownerId: string,
  stagedBy: "operator" | "other_agent",
): void {
  const runId = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const target = (await tx\`SELECT id FROM deploy_targets WHERE name = 'staging'\`)[0];
      if (!target) throw new Error("quality-fix-offer e2e: no staging deploy target");
      const page = (await tx\`SELECT id::text AS id FROM pages WHERE slug = \${process.env.SLUG}\`)[0];
      // Dated ahead so a Stage another spec runs meanwhile cannot replace
      // it as the build Publish would ship (that withdraws the offer). The
      // afterAll deletes it.
      const run = (await tx\`INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
        VALUES (\${target.id}, \${process.env.OWNER_ID}::uuid, 'succeeded', now() + interval '1 hour',
                now() + interval '1 hour', 'e2e-quality-offer')
        RETURNING id::text AS id\`)[0];
      const problems = [{ kind: "failing_audit", auditId: "color-contrast", title: "Low contrast text", score: 0, categories: ["accessibility"] }];
      const audit = (await tx\`INSERT INTO quality_audit_runs
          (deploy_run_id, chat_session_id, requested_by, status, classification, target_page_ids,
           problem_count, started_at, finished_at, fix_round, staged_by)
        VALUES (\${run.id}::uuid, \${process.env.CHAT_ID}::uuid, \${process.env.OWNER_ID}::uuid, 'problems',
          \${JSON.stringify({ auditNeeded: true, reasons: [], skipped: [] })}::jsonb,
          ARRAY[\${page.id}::uuid], 1, now(), now(), 0, \${process.env.STAGED_BY})
        RETURNING id::text AS id\`)[0];
      await tx\`INSERT INTO quality_audit_pages (audit_run_id, page_id, url, status, problems)
        VALUES (\${audit.id}::uuid, \${page.id}::uuid, 'http://staging.invalid/', 'problems',
          \${JSON.stringify(problems)}::jsonb)\`;
      return run.id;
    });
    process.stdout.write(id);
    await sql.end();
    `,
    { CHAT_ID: chatSessionId, OWNER_ID: ownerId, STAGED_BY: stagedBy, SLUG },
  ).trim();
  seededRuns.push(runId);
}

/** Every chat-turn request this page sends from now on. */
function watchStreamRequests(page: Page, chatSessionId: string): { body: string }[] {
  const sent: { body: string }[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith(`/content/chat/${chatSessionId}/stream`)) {
      sent.push({ body: req.postData() ?? "" });
    }
  });
  return sent;
}

async function qualityStatus(
  request: APIRequestContext,
  chatSessionId: string,
): Promise<{ notified: boolean; gate: { open: boolean } | null }> {
  const res = await request.get(`/content/chat/${chatSessionId}/quality-audit`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { notified: boolean; gate: { open: boolean } | null };
}

test("an operator Stage with findings asks first; only 'Fix with AI' starts the AI", async ({
  context,
  page,
}) => {
  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "Fixing the contrast now." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);
  const ownerId = await login(page);
  const chatSessionId = await newChat(page);
  seedProblemAudit(chatSessionId, ownerId, "operator");
  const path = PAGE_PATH;
  const sent = watchStreamRequests(page, chatSessionId);
  await page.reload();

  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Quality check found 1 issue(s) on 1 page(s)");
  await expect(card).toContainText(`${path} (Low contrast text)`);
  await expect(card).toContainText("Staged by you.");
  await expect(card).toContainText("Let the AI fix them?");
  // Long enough for the old auto-send (it fired as soon as the chat was idle).
  await page.waitForTimeout(5_000);
  expect(sent).toHaveLength(0);

  await card.getByTestId("quality-fix-offer-fix").click();
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1);
  const body = JSON.parse(sent[0]?.body ?? "{}") as {
    content: string;
    origin?: string;
    trigger?: string;
  };
  expect(body.trigger).toBe("operator");
  expect(body.content).toContain("Fix round 1 of 2");
  expect(body.content).toContain(`- ${path}: Low contrast text`);
  expect(body.content).toContain("I staged this build myself");
  expect(body.content).toContain("can also contain changes made outside this conversation");
  await expect(page.getByText("Fixing the contrast now.")).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await qualityStatus(page.request, chatSessionId)).notified, {
      timeout: 15_000,
    })
    .toBe(true);
  expect(sent).toHaveLength(1);
});

test("'Not now' leaves a note and runs nothing; Publish live stays blocked", async ({ page }) => {
  const ownerId = await login(page);
  const chatSessionId = await newChat(page);
  seedProblemAudit(chatSessionId, ownerId, "operator");
  const sent = watchStreamRequests(page, chatSessionId);
  await page.reload();

  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("quality-fix-offer-dismiss").click();
  await expect(page.getByText("Not now — the AI was not asked to fix")).toBeVisible({
    timeout: 15_000,
  });
  await expect(card).toHaveCount(0);
  const st = await qualityStatus(page.request, chatSessionId);
  expect(st.notified).toBe(true);
  expect(st.gate?.open).toBe(false);
  // The decision holds across a reload, and nothing ever started the AI.
  await page.reload();
  await expect(page.getByText("Not now — the AI was not asked to fix")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(3_000);
  await expect(card).toHaveCount(0);
  expect(sent).toHaveLength(0);
});

test("'Fix with AI' is refused while an external agent works in the chat", async ({
  page,
  request,
}) => {
  const ownerId = ensureIsolatedOwner(OWNER_EMAIL);
  const token = mintAdminMcpToken(ownerId, "quality-offer agent");
  const sessionRes = await request.post("/api/mcp/session", {
    headers: { "x-caelo-mcp-token": token },
    data: { newSession: true, title: `quality-offer-${Date.now()}` },
  });
  expect(sessionRes.ok()).toBe(true);
  const { chatSessionId } = (await sessionRes.json()) as { chatSessionId: string };
  // One call marks the agent as working in the chat.
  const tool = await request.post("/api/mcp/tool", {
    headers: { "x-caelo-mcp-token": token },
    data: { chatSessionId, toolName: "list_pages", args: {} },
  });
  expect(tool.ok(), await tool.text()).toBe(true);
  seedProblemAudit(chatSessionId, ownerId, "other_agent");

  await login(page);
  const sent = watchStreamRequests(page, chatSessionId);
  await page.goto(`/content/chat/${chatSessionId}`);
  const card = page.getByTestId("quality-fix-offer");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Staged by another agent working in this chat.");
  await card.getByTestId("quality-fix-offer-fix").click();
  await expect(page.getByTestId("quality-fix-offer-error")).toContainText(
    "is working in this chat right now",
    { timeout: 15_000 },
  );
  expect(sent).toHaveLength(0);
  expect((await qualityStatus(page.request, chatSessionId)).notified).toBe(false);
});
