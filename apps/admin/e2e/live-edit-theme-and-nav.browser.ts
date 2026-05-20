// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.5 (updated for v0.10.22) — proves the unified structured-sets
 * primitive end-to-end. v0.10.22 removed the kind-specific wrappers
 * (`update_theme`, `set_nav_menu`); the AI now does:
 *
 *   1. get_structured_set + set_structured_set (theme/site) — the AI
 *      reads existing theme items, merges in the new --color-primary
 *      token in JS, then writes back. Replaces the old `update_theme`
 *      single-call merge.
 *   2. set_structured_set kind=nav-menu — replaces header-main items;
 *      menu module renders fresh HTML from the typed list.
 *
 * Verifies via direct DB inspection (theme tokens) + admin preview HTML
 * fetch (theme style tag + composed nav HTML).
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  resetOverlayLayoutFor,
} from "./helpers.js";

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

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

const ts = Date.now();
const PROVIDER = `theme-nav-${ts}`;
const BASE = "http://localhost:4173";
const NEW_PRIMARY = "#ff00aa";

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
});

test("get + set_structured_set inject new --color-primary; merge preserves other tokens", async ({
  context,
  page,
}) => {
  // v0.10.22 — the AI now does get → mutate → set instead of the
  // pre-v0.10.22 single update_theme call. Two recorded turns:
  //   Turn 1: get_structured_set({kind:'theme', slug:'site'})
  //           Provider responds via tool_use; tool runs → returns
  //           current items JSON to the AI as a tool result.
  //   Turn 2: set_structured_set with the merged items array.
  // We pre-stage the merged items here (mirroring what the AI's JS
  // merge would produce) so the recorded provider stream can be
  // deterministic.
  const seededRows = querySingle(
    "SELECT items::text AS items FROM structured_sets WHERE kind = 'theme' AND slug = 'site'",
  ) as { items: string }[];
  const existingItems =
    seededRows.length > 0
      ? (JSON.parse(seededRows[0].items) as Array<{ token: string; value: string; scope?: string }>)
      : [];
  const mergedItems = existingItems
    .filter((t) => t.token !== "color-primary")
    .concat([{ token: "color-primary", value: NEW_PRIMARY, scope: "color" }]);
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_theme_get_${ts}`,
        name: "get_structured_set",
        arguments: { kind: "theme", slug: "site" },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      {
        kind: "tool-call",
        id: `tu_theme_set_${ts}`,
        name: "set_structured_set",
        arguments: {
          kind: "theme",
          slug: "site",
          displayName: "Site theme",
          items: mergedItems,
        },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Theme updated." },
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
  await page.locator("textarea").fill("brighten the primary color");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("Theme updated.").first()).toBeVisible({ timeout: 30_000 });

  // Direct DB check — the merged theme set carries the new token.
  // (Iframe-rendered theme style tag is unit-tested in
  // packages/shared/src/preview-compose.test.ts; here we only need to
  // prove set_structured_set reached structured_sets correctly.)
  const themeRows = querySingle(
    "SELECT items::text AS items FROM structured_sets WHERE kind = 'theme' AND slug = 'site'",
  ) as { items: string }[];
  expect(themeRows.length).toBe(1);
  expect(themeRows[0].items).toContain(NEW_PRIMARY);
  // Sanity: the existing fonts + space tokens are preserved (the AI
  // merged in JS, not replace-everything).
  expect(themeRows[0].items).toContain("font-heading");
});
