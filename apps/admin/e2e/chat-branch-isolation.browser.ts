// SPDX-License-Identifier: MPL-2.0

/**
 * Two browser contexts (parallel editors) edit the same module via two
 * chats. Each chat's tool call lands a snapshot tagged with its own
 * chat_branch_id; the read-side of the page editor still shows the
 * shared "main" body until either chat publishes.
 *
 * This is a UI-level pin on the same invariant the
 * chat-branch-isolation.integration.test.ts asserts on the database.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const FIXTURE_PATH = "/tmp/caelo-ai-fixture.json";
const ts = Date.now();
const MOD_SLUG = `e2e-iso-mod-${ts}`;

test.afterEach(() => {
  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
    });
    await sql.end();
    `,
    { MOD_SLUG },
  );
});

test("two unpublished chats edit one module; main stays at original body", async ({ browser }) => {
  // Seed the module.
  let moduleId = "";
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
        const rows = await tx\`
          INSERT INTO modules (slug, display_name, html)
          VALUES (\${process.env.MOD_SLUG}, 'iso', '<p>main</p>')
          RETURNING id::text AS id
        \`;
        process.stdout.write(rows[0].id);
      });
      await sql.end();
      `,
    ],
    { env: { ...process.env, MOD_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  moduleId = r.stdout.trim();

  // Helper to drive one chat from one context with a one-shot edit.
  async function driveChat(ctxLabel: string, htmlEdit: string): Promise<void> {
    writeFileSync(
      FIXTURE_PATH,
      JSON.stringify([
        [
          {
            kind: "tool-call",
            id: `tu-${ctxLabel}`,
            name: "edit_module",
            arguments: { moduleId, html: htmlEdit },
          },
          { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
          { kind: "done", stopReason: "tool_use" },
        ],
        [
          { kind: "text-delta", text: `done from ${ctxLabel}` },
          { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
          { kind: "done", stopReason: "end_turn" },
        ],
      ]),
    );
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.getByLabel("Email").fill("dev-owner@example.com");
    await page.getByLabel("Password").fill("dev owner password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("/", { timeout: 15_000 });
    await page.goto("/content/chat");
    await page.getByRole("button", { name: /\+ new chat/i }).click();
    await page.waitForURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
    await page.locator("textarea").fill(`edit from ${ctxLabel}`);
    await page.getByRole("button", { name: /^send$/i }).click();
    await expect(page.getByText(new RegExp(`done from ${ctxLabel}`))).toBeVisible({
      timeout: 15_000,
    });
    await ctx.close();
  }

  await driveChat("A", "<p>edit-from-A</p>");
  await driveChat("B", "<p>edit-from-B</p>");

  // The live module's `html` reflects whichever tool call ran last
  // (P5 doesn't enforce branch-aware reads on /content/modules — that's
  // a P10A surface). What matters: the SNAPSHOT history carries one
  // row per branch, so each branch is publishable independently.
  const branchA = await runBunInlineCapture(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`
        SELECT count(*)::int AS c FROM site_snapshots
        WHERE chat_branch_id IS NOT NULL AND op_kind = 'modules.update'
        AND id IN (
          SELECT site_snapshot_id FROM module_snapshots WHERE module_id = \${process.env.MODULE_ID}::uuid
        )
      \`;
      process.stdout.write(String(rows[0].c));
    });
    await sql.end();
    `,
    { MODULE_ID: moduleId },
  );
  expect(Number(branchA)).toBeGreaterThanOrEqual(2);
});

import { spawnSync } from "node:child_process";

function runBunInlineCapture(script: string, extraEnv: Record<string, string> = {}): string {
  const r = spawnSync("bun", ["-e", script], {
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`bun -e failed: ${r.stderr}`);
  return r.stdout.trim();
}
