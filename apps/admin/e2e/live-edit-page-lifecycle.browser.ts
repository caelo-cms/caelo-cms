// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.5 — full page-lifecycle scenario in one spec. Stages the AI
 * tool calls via the in-memory test-provider fixture and verifies the
 * DB state after each turn:
 *
 *   1. create_page — name + title + slug all distinct.
 *   2. rename_page — only `name` changes; title + slug unchanged.
 *   3. set_page_title — only `title` changes; name + slug unchanged.
 *   4. change_page_slug — slug changes, 301 redirect lands.
 *   5. delete_page (disposition=redirect) — soft-delete + 301 to /.
 *
 * Each step replays a single AI tool-call → end_turn fixture and
 * inspects pages / redirects rows directly so the assertions don't
 * depend on UI hydration timing.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

const ts = Date.now();
const PROVIDER = `lifecycle-${ts}`;
const BASE = "http://localhost:4173";
const NAME = `Lifecycle ${ts}`;
const TITLE = `Lifecycle Page ${ts}`;
const INITIAL_SLUG = `lifecycle-${ts}`;
const RENAMED_NAME = `${NAME} (renamed)`;
const NEW_TITLE = `Better Lifecycle Page ${ts}`;
const FINAL_SLUG = `lifecycle-${ts}-final`;

function querySingle(sql: string): unknown {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = await tx.unsafe(${JSON.stringify(sql)});
        process.stdout.write(JSON.stringify(rows));
      });
      await c.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout || "[]");
}

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM redirects WHERE from_path LIKE '/lifecycle-%'\`;
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${INITIAL_SLUG.replace(
        /'/g,
        "''",
      )}%')\`;
      await tx\`DELETE FROM pages WHERE slug LIKE '${INITIAL_SLUG.replace(/'/g, "''")}%'\`;
    });
    await c.end();
    `,
    {},
  );
});

test("page lifecycle: create → rename → set title → change slug + redirect → delete + redirect", async ({
  context,
  page,
}) => {
  // Resolve the home-template id and home page id for tool inputs.
  const tplRows = querySingle(
    "SELECT id::text AS id FROM templates WHERE slug = 'home-template' LIMIT 1",
  ) as { id: string }[];
  const templateId = tplRows[0]?.id;
  expect(templateId).toBeTruthy();

  // Five fixture turns, one per AI tool-call. Each ends in end_turn so
  // the runner finishes after the single tool result.
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_create_${ts}`,
        name: "create_page",
        arguments: {
          name: NAME,
          title: TITLE,
          slug: INITIAL_SLUG,
          locale: "en",
          templateId,
          status: "draft",
        },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Page created." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/edit");
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });

  // Turn 1: create_page.
  await page.locator("textarea").fill(`create page named ${NAME}`);
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("Page created.").first()).toBeVisible({ timeout: 30_000 });

  let pageRows = querySingle(
    `SELECT id::text AS id, name, title, slug FROM pages WHERE slug = '${INITIAL_SLUG}' AND deleted_at IS NULL LIMIT 1`,
  ) as { id: string; name: string; title: string; slug: string }[];
  expect(pageRows[0]).toBeDefined();
  const pageId = pageRows[0].id;
  expect(pageRows[0].name).toBe(NAME);
  expect(pageRows[0].title).toBe(TITLE);
  expect(pageRows[0].slug).toBe(INITIAL_SLUG);

  // Turn 2: rename_page (name only).
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_rename_${ts}`,
        name: "rename_page",
        arguments: { pageId, newName: RENAMED_NAME },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Renamed." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await page.locator("textarea").fill("rename it");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("Renamed.").first()).toBeVisible({ timeout: 30_000 });

  pageRows = querySingle(
    `SELECT id::text AS id, name, title, slug FROM pages WHERE id = '${pageId}'::uuid LIMIT 1`,
  ) as { id: string; name: string; title: string; slug: string }[];
  expect(pageRows[0].name).toBe(RENAMED_NAME);
  expect(pageRows[0].title).toBe(TITLE); // unchanged
  expect(pageRows[0].slug).toBe(INITIAL_SLUG); // unchanged
  // No redirect should have been created — rename is name-only.
  let redirectRows = querySingle(
    `SELECT from_path FROM redirects WHERE from_path = '/${INITIAL_SLUG}'`,
  ) as unknown[];
  expect(redirectRows.length).toBe(0);

  // Turn 3: set_page_title (<title> only).
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_title_${ts}`,
        name: "set_page_title",
        arguments: { pageId, newTitle: NEW_TITLE },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Title set." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await page.locator("textarea").fill("update the browser tab title");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("Title set.").first()).toBeVisible({ timeout: 30_000 });

  pageRows = querySingle(
    `SELECT name, title, slug FROM pages WHERE id = '${pageId}'::uuid LIMIT 1`,
  ) as { name: string; title: string; slug: string }[];
  expect(pageRows[0].name).toBe(RENAMED_NAME); // unchanged
  expect(pageRows[0].title).toBe(NEW_TITLE);
  expect(pageRows[0].slug).toBe(INITIAL_SLUG); // unchanged
  redirectRows = querySingle(
    `SELECT from_path FROM redirects WHERE from_path = '/${INITIAL_SLUG}'`,
  ) as unknown[];
  expect(redirectRows.length).toBe(0); // still no redirect

  // Turn 4: change_page_slug (URL changes; auto redirect).
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_slug_${ts}`,
        name: "change_page_slug",
        arguments: { pageId, newSlug: FINAL_SLUG, redirectFromOld: "auto" },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Slug changed; redirect created." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await page.locator("textarea").fill(`change the URL to /${FINAL_SLUG}`);
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/Slug changed/).first()).toBeVisible({ timeout: 30_000 });

  pageRows = querySingle(
    `SELECT name, title, slug FROM pages WHERE id = '${pageId}'::uuid LIMIT 1`,
  ) as { name: string; title: string; slug: string }[];
  expect(pageRows[0].slug).toBe(FINAL_SLUG);
  expect(pageRows[0].name).toBe(RENAMED_NAME); // unchanged
  expect(pageRows[0].title).toBe(NEW_TITLE); // unchanged
  redirectRows = querySingle(
    `SELECT from_path, to_path, status_code FROM redirects WHERE from_path = '/${INITIAL_SLUG}'`,
  ) as { from_path: string; to_path: string; status_code: number }[];
  expect(redirectRows.length).toBe(1);
  expect(redirectRows[0].to_path).toBe(`/${FINAL_SLUG}`);
  expect(redirectRows[0].status_code).toBe(301);

  // Turn 5: delete_page (disposition=redirect to /).
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_del_${ts}`,
        name: "delete_page",
        arguments: { pageId, disposition: "redirect", redirectTo: "/" },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Deleted with redirect." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await page.locator("textarea").fill("delete this page and redirect to home");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/Deleted with redirect/).first()).toBeVisible({ timeout: 30_000 });

  pageRows = querySingle(`SELECT deleted_at FROM pages WHERE id = '${pageId}'::uuid LIMIT 1`) as {
    deleted_at: string | null;
  }[];
  expect(pageRows[0].deleted_at).not.toBeNull();
  redirectRows = querySingle(
    `SELECT from_path, to_path FROM redirects WHERE from_path = '/${FINAL_SLUG}'`,
  ) as { from_path: string; to_path: string }[];
  expect(redirectRows.length).toBe(1);
  expect(redirectRows[0].to_path).toBe("/");
});
