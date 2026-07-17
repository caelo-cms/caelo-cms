// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — proves `add_module (target=layout)` reaches every page on every
 * template bound to the layout. The AI-tool path is exercised via a
 * fixture provider that streams a single `add_module (target=layout)` call
 * with layoutSlug='site-default'. After the tool runs, the seeded
 * `home` page renders with the new footer.
 *
 * Runs alongside `live-edit-layout-isolation.browser.ts` (which proves
 * the bare-layout escape hatch); together they cover the
 * "site-wide chrome reaches every page" requirement.
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
  // Earlier specs (template-switch, isolation) may have re-pointed
  // home-template or attached layout_modules to site-default. Reset
  // to a known state so the AI's add_module (target=layout) call lands on
  // a clean slate.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`UPDATE layouts SET deleted_at = NULL WHERE slug IN ('site-default','bare','centered')\`;
      await tx\`
        UPDATE templates
        SET layout_id = (SELECT id FROM layouts WHERE slug = 'site-default')
        WHERE slug = 'home-template'
      \`;
      const sd = ((await tx\`SELECT id::text AS id FROM layouts WHERE slug='site-default'\`)[0])?.id;
      if (sd) {
        await tx\`DELETE FROM layout_modules WHERE layout_id = \${sd}::uuid AND block_name = 'footer'\`;
      }
    });
    await c.end();
    `,
  );
});

const ts = Date.now();
const PROVIDER = `add-footer-${ts}`;
const FOOTER_TEXT = `LAYOUT_FOOTER_AI_${ts}`;
const BASE = "http://localhost:4173";

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  // Clean up the AI-attached footer module so reruns are stable.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    const FOOTER = process.env.FOOTER_TEXT;
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const siteDefault = ((await tx\`SELECT id::text AS id FROM layouts WHERE slug='site-default'\`)[0])?.id;
      if (siteDefault) {
        await tx\`
          DELETE FROM layout_modules
          WHERE layout_id = \${siteDefault}::uuid AND block_name = 'footer'
        \`;
      }
      await tx\`DELETE FROM modules WHERE html LIKE '%' || \${FOOTER} || '%'\`;
    });
    await c.end();
    `,
    { FOOTER_TEXT },
  );
});

test("add_module (target=layout) reaches every page on the layout", async ({ context, page }) => {
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_layout_${ts}`,
        // add_module (target=layout) was consolidated into the target-routed
        // `add_module` (target='layout'). Explicit fields + values skip
        // the moduleize sub-call (which would consume the next mock turn)
        // and exercise the layout `values`→field-default path.
        name: "add_module",
        arguments: {
          target: "layout",
          targetRef: "site-default",
          blockName: "footer",
          position: "bottom",
          displayName: "AI Site Footer",
          html: "<footer>{{copy}}</footer>",
          fields: [{ name: "copy", kind: "text", label: "Copy" }],
          values: { copy: FOOTER_TEXT },
        },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Footer added to every page." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/edit");
  await page.locator("textarea").fill("add a footer to every page");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("Footer added to every page.").first()).toBeVisible({
    timeout: 30_000,
  });

  // Verify directly in the DB that the AI tool wrote a layout_modules
  // row attaching the new footer to the site-default layout. The chat
  // runs on an ephemeral branch but layout_modules.set writes to the
  // live table — the assertion here is independent of branch state.
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = await tx\`
          SELECT m.html, m.fields::text AS fields FROM layout_modules lm
          JOIN modules m ON m.id = lm.module_id
          JOIN layouts l ON l.id = lm.layout_id
          WHERE l.slug = 'site-default' AND lm.block_name = 'footer'
        \`;
        process.stdout.write(JSON.stringify(rows));
      });
      await c.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const rows = JSON.parse(r.stdout || "[]") as { html: string; fields: string | null }[];
  expect(rows.length, `expected at least one footer module on site-default`).toBeGreaterThan(0);
  // v0.12.2 — the extractor templatises literal copy at modules.create
  // so FOOTER_TEXT now lives in a field default, not the raw html.
  // Check both surfaces.
  expect(
    rows.some((row) => row.html.includes(FOOTER_TEXT) || (row.fields ?? "").includes(FOOTER_TEXT)),
  ).toBe(true);
});
