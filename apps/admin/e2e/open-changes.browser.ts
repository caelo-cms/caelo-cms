// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — Draft changes (/content/changes): the operator's own
 * conversations with changes that are not on staging yet.
 *
 * Seeded through the real ops: experiment chat A edits a module, draft
 * chat B edits the same module (B takes it over — A's unstaged change moves
 * into the shared draft), and draft chat C edits another module. The page
 * must show B with its count and, behind Show details, the module; hide A
 * (nothing unstaged any more) and another editor's chat (only the
 * operator's own are listed, decision 2026-11-17); and Discard C through
 * the real form action (routing + CSRF + chat.discard_branch). The
 * multi-chat Stage itself (merge, one staging build, one audit) is covered
 * by the admin-core integration suite (stage-chats-open-changes.integration.test.ts)
 * — the mock E2E stack has no staging build target to exercise.
 */

import { expect, test } from "@playwright/test";
import { acceptConfirm, clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);
// One seed shared by both tests: a second worker would re-run it with a
// colliding tag (two workers can load this file in the same millisecond).
test.describe.configure({ mode: "serial" });

const TAG = `e2e-oc-${Date.now()}`;

// Leave no open chats behind: other suites render /edit for the same
// owner, and a stack of foreign open chats changes that page's chrome.
test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const open = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx\`SELECT id::text AS id, created_by::text AS owner FROM chat_sessions
                 WHERE title LIKE \${process.env.OC_TAG + "%"}
                   AND discarded_at IS NULL AND published_at IS NULL\`;
    });
    await sql.end();
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    for (const s of open) {
      await execute(
        registry,
        adapter,
        { actorId: s.owner, actorKind: "human", requestId: "e2e-oc-cleanup" },
        "chat.discard_branch",
        { chatSessionId: s.id },
      );
    }
    await adapter.close();
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const like = process.env.OC_TAG + "%";
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE \${like})\`;
      await tx\`DELETE FROM pages WHERE slug LIKE \${like}\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE \${like})\`;
      await tx\`DELETE FROM templates WHERE slug LIKE \${like}\`;
    });
    await db.end();
    `,
    { OC_TAG: TAG },
  );
});
let chats: { a: string; b: string; c: string; d: string; e: string; other: string };

test.beforeAll(() => {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const tag = process.env.OC_TAG;
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    const ownerId = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx\`SELECT id::text AS id FROM users WHERE email = 'dev-owner@example.com'\`)[0].id;
    });
    await db.end();
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const human = { actorId: ownerId, actorKind: "human", requestId: tag };
    const run = async (ctx, op, input) => {
      const r = await execute(registry, adapter, ctx, op, input);
      if (!r.ok) throw new Error(op + ": " + JSON.stringify(r.error));
      return r.value;
    };
    // Two draft pages of their own: a section design counts where it shows
    // (on one page it is a change of that page, on none it is not listed).
    const { templateId } = await run(human, "templates.create", {
      pageType: "home", slug: tag + "-tpl", displayName: tag + " template",
      html: '<body><caelo-slot name="content">_</caelo-slot></body>',
    });
    const pageIds = [];
    for (const n of [1, 2]) {
      pageIds.push((await run(human, "pages.create", {
        slug: tag + "-page-" + n, title: tag + " page " + n, templateId, status: "draft",
      })).pageId);
    }
    const placeOnPages = async (moduleId) => {
      const db = new SQL(process.env.ADMIN_DATABASE_URL);
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        for (const pageId of pageIds) {
          const ci = (await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${moduleId}::uuid, '{}'::jsonb) RETURNING id\`)[0].id;
          await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
            VALUES (\${pageId}::uuid, 'content', (SELECT count(*)::int FROM page_modules WHERE page_id = \${pageId}::uuid), \${moduleId}::uuid, \${ci}::uuid, 'unsynced')\`;
        }
      });
      await db.end();
    };
    const shared = (await run(human, "modules.create", {
      slug: tag + "-shared", displayName: tag + " Shared hero", html: "<p>v0</p>",
    })).moduleId;
    await placeOnPages(shared);
    const own = (await run(human, "modules.create", {
      slug: tag + "-own", displayName: tag + " Own card", html: "<p>v0</p>",
    })).moduleId;
    await placeOnPages(own);
    const open = async (title, isolation) => {
      const s = await run(human, "chat.create_session", { title: tag + " " + title, ...(isolation ? { isolation } : {}) });
      return { id: s.chatSessionId, ctx: { ...human, actorKind: "ai", chatBranchId: s.chatBranchId, chatTaskId: s.chatSessionId } };
    };
    // A is an experiment (own branch); B and C work in the shared draft.
    const a = await open("Website", "experiment");
    const b = await open("Pricing");
    const c = await open("Scratch");
    await run(a.ctx, "modules.update", { moduleId: shared, html: "<p>from A</p>" });
    await run(b.ctx, "modules.update", { moduleId: shared, css: ".b{}" });
    await run(c.ctx, "modules.update", { moduleId: own, html: "<p>from C</p>" });
    // Another editor's chat with draft changes: not the operator's to
    // stage, so it is not listed at all.
    const colleagueId = crypto.randomUUID();
    const db2 = new SQL(process.env.ADMIN_DATABASE_URL);
    await db2.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`INSERT INTO actors (id, kind, display_name) VALUES (\${colleagueId}::uuid, 'human', 'e2e colleague')\`;
    });
    await db2.end();
    const colleague = { actorId: colleagueId, actorKind: "human", requestId: tag + "-colleague" };
    const theirs = (await run(colleague, "modules.create", {
      slug: tag + "-theirs", displayName: tag + " Theirs", html: "<p>v0</p>",
    })).moduleId;
    const oc = await run(colleague, "chat.create_session", { title: tag + " Colleague" });
    await run({ ...colleague, actorKind: "ai", chatBranchId: oc.chatBranchId, chatTaskId: oc.chatSessionId },
      "modules.update", { moduleId: theirs, html: "<p>from the colleague</p>" });
    // D and E share the draft and touch the same module: E builds on D's
    // change (its first write is a version conflict, the retry passes), so
    // discarding D would also undo E's later change.
    const layered = (await run(human, "modules.create", {
      slug: tag + "-layered", displayName: tag + " Layered", html: "<p>v0</p>",
    })).moduleId;
    const d = await open("Base work");
    const e = await open("Built on top");
    await run(d.ctx, "modules.update", { moduleId: layered, html: "<p>from D</p>" });
    await execute(registry, adapter, e.ctx, "modules.update", { moduleId: layered, css: ".e{}" });
    await run(e.ctx, "modules.update", { moduleId: layered, css: ".e{}" });
    await adapter.close();
    process.stdout.write(
      JSON.stringify({ a: a.id, b: b.id, c: c.id, d: d.id, e: e.id, other: oc.chatSessionId }),
    );
    `,
    { OC_TAG: TAG },
  );
  chats = JSON.parse(out) as typeof chats;
});

test("lists the operator's own conversations with their changes and discards one", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/content/changes");
  await expect(page.getByRole("heading", { name: "Draft changes" })).toBeVisible();

  const cardB = page.locator(`[data-testid="draft-chat"][data-chat-id="${chats.b}"]`);
  await expect(cardB).toBeVisible();
  // Counted as the operator sees it: one module on two pages is one site-wide change.
  await expect(cardB.getByTestId("draft-chat-stats")).toContainText("1 site-wide change");
  await expect(cardB.getByTestId("draft-chat-details")).toHaveCount(0);
  await cardB.getByTestId("draft-chat-details-toggle").click();
  await expect(cardB.getByTestId("draft-chat-details")).toContainText(`${TAG} Shared hero`);
  await expect(cardB.getByTestId("draft-chat-details")).toContainText(
    "Section design · on 2 pages",
  );
  // Open chat goes to the conversation itself (it has no page of its own).
  await expect(cardB.getByTestId("open-chat-link")).toHaveAttribute(
    "href",
    `/edit?chat=${chats.b}`,
  );
  // A's change moved into B: A has nothing unstaged and holds nothing.
  await expect(page.locator(`[data-chat-id="${chats.a}"]`)).toHaveCount(0);
  // Another editor's conversation is theirs to stage: not listed.
  await expect(page.locator(`[data-chat-id="${chats.other}"]`)).toHaveCount(0);

  const cardC = page.locator(`[data-testid="draft-chat"][data-chat-id="${chats.c}"]`);
  await cardC.getByTestId("draft-chat-details-toggle").click();
  await expect(cardC.getByTestId("draft-chat-details")).toContainText(`${TAG} Own card`);

  // Nothing is ticked on this page, so "Stage selected" waits for a tick.
  await expect(page.getByTestId("stage-selected")).toBeDisabled();
  await cardC.getByTestId("draft-chat-select").check();
  await expect(page.getByTestId("stage-selected")).toBeEnabled();
  await cardC.getByTestId("draft-chat-select").uncheck();

  await cardC.getByTestId("discard-chat").click();
  await acceptConfirm(page);
  await expect(page.locator(`[data-chat-id="${chats.c}"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(`[data-chat-id="${chats.b}"]`)).toBeVisible();
});

test("asks before a discard also undoes another draft chat's later change", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/content/changes");
  const cardD = page.locator(`[data-testid="draft-chat"][data-chat-id="${chats.d}"]`);
  await expect(cardD).toContainText(`${TAG} Base work`);
  await cardD.getByTestId("discard-chat").click();
  await acceptConfirm(page);
  // Refused with the overlap named — nothing discarded yet.
  await expect(page.getByText(`'${TAG} Built on top'`).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-chat-id="${chats.d}"]`)).toBeVisible();

  await page.getByTestId("discard-anyway").click();
  await expect(page.locator(`[data-chat-id="${chats.d}"]`)).toHaveCount(0, { timeout: 15_000 });
  // E's change on the same module was built on D's, so it went too.
  await expect(page.locator(`[data-chat-id="${chats.e}"]`)).toHaveCount(0);
});
