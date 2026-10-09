// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — the Open changes overview (/content/changes).
 *
 * Seeded through the real ops: experiment chat A edits a module, draft
 * chat B edits the same module (B takes it over — A's unstaged change moves
 * into the shared draft), and draft chat C edits another module. The overview must show B with the module
 * and the visible takeover note, hide A (nothing unstaged, nothing held
 * any more), and Discard C through the real form action (routing + CSRF +
 * chat.discard_branch). The multi-chat Stage itself (merge, one staging
 * build, one audit) is covered by the admin-core integration suite
 * (stage-chats-open-changes.integration.test.ts) — the mock E2E stack has
 * no staging build target to exercise.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const TAG = `e2e-oc-${Date.now()}`;
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
    const shared = (await run(human, "modules.create", {
      slug: tag + "-shared", displayName: tag + " Shared hero", html: "<p>v0</p>",
    })).moduleId;
    const own = (await run(human, "modules.create", {
      slug: tag + "-own", displayName: tag + " Own card", html: "<p>v0</p>",
    })).moduleId;
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
    // Another editor's chat with open work: listed read-only, not a link
    // (/edit only resumes the operator's own chats).
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

test("lists open chats with the takeover note and discards a chat", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/content/changes");
  await expect(page.getByRole("heading", { name: "Open changes" })).toBeVisible();

  const cardB = page.locator(`[data-chat-id="${chats.b}"]`);
  await expect(cardB).toBeVisible();
  await expect(cardB).toContainText(`${TAG} Shared hero`);
  await expect(cardB.getByTestId("takeovers")).toContainText(
    `Adopted module '${TAG} Shared hero' from chat '${TAG} Website'`,
  );
  // A's change moved into B: A has nothing unstaged and holds nothing.
  await expect(page.locator(`[data-chat-id="${chats.a}"]`)).toHaveCount(0);

  // Another editor's chat: read-only, its title is not a link.
  const cardOther = page.locator(`[data-chat-id="${chats.other}"]`);
  await expect(cardOther).toContainText("another editor");
  await expect(cardOther.getByTestId("foreign-chat-title")).toBeVisible();
  await expect(cardOther.locator("a")).toHaveCount(0);
  await expect(cardOther.getByTestId("discard-chat")).toHaveCount(0);

  const cardC = page.locator(`[data-chat-id="${chats.c}"]`);
  await expect(cardC).toContainText(`${TAG} Own card`);

  // "Stage selected" with nothing ticked is refused, not silently ignored.
  await page.getByTestId("stage-selected").click();
  await expect(page.getByText("Select at least one chat to stage.").first()).toBeVisible({
    timeout: 15_000,
  });

  page.once("dialog", (d) => d.accept());
  await page.locator(`[data-chat-id="${chats.c}"]`).getByTestId("discard-chat").click();
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
  const cardD = page.locator(`[data-chat-id="${chats.d}"]`);
  await expect(cardD).toContainText(`${TAG} Layered`);
  page.once("dialog", (d) => d.accept());
  await cardD.getByTestId("discard-chat").click();
  // Refused with the overlap named — nothing discarded yet.
  await expect(page.getByText(`'${TAG} Built on top'`).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-chat-id="${chats.d}"]`)).toBeVisible();

  await page.getByTestId("discard-anyway").click();
  await expect(page.locator(`[data-chat-id="${chats.d}"]`)).toHaveCount(0, { timeout: 15_000 });
  // E's change on the same module was built on D's, so it went too.
  await expect(page.locator(`[data-chat-id="${chats.e}"]`)).toHaveCount(0);
});
