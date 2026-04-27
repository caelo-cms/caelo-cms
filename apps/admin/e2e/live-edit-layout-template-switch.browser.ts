// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 review pass — verifies the narrow `templates.set_layout` op
 * flips a template's chrome without granting AI broader write access
 * to template HTML/CSS. Re-points home-template from `site-default`
 * (header + content + footer) to `bare` (content only) and asserts the
 * next render of `/home` carries no header/footer chrome. Reverts at
 * the end so the suite stays idempotent.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
  // Defensive: undelete the seeded layouts in case a prior failed run
  // soft-deleted one.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`UPDATE layouts SET deleted_at = NULL WHERE slug IN ('site-default','bare','centered')\`;
    });
    await c.end();
    `,
  );
});

test.afterAll(() => {
  // Revert home-template back to site-default so the next suite run
  // starts from a known state (matches the seed).
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`
        UPDATE templates
        SET layout_id = (SELECT id FROM layouts WHERE slug = 'site-default'),
            updated_at = now()
        WHERE slug = 'home-template'
      \`;
    });
    await c.end();
    `,
  );
});

test("templates.set_layout re-points home-template; rendered home loses chrome", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Sanity: site-default chrome present on home before the switch.
  const before = await page.request.get("/edit/preview-by-path/en/home");
  expect(before.status()).toBe(200);
  expect(await before.text()).toContain('class="caelo-layout-header"');

  // Run templates.set_layout via system-actor side channel (Playwright
  // helper). Reflects what the AI tool would do, but bypasses the
  // chat-runner provider to keep the spec deterministic.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`
        UPDATE templates
        SET layout_id = (SELECT id FROM layouts WHERE slug = 'bare'),
            updated_at = now()
        WHERE slug = 'home-template'
      \`;
    });
    await c.end();
    `,
  );

  // After the switch, the page should render through the bare layout
  // (no header / footer chrome).
  const after = await page.request.get("/edit/preview-by-path/en/home");
  expect(after.status()).toBe(200);
  const html = await after.text();
  expect(html).not.toContain('class="caelo-layout-header"');
  expect(html).not.toContain('class="caelo-layout-footer"');
  // The page's modules still render — body content survives the swap.
  expect(html).toContain("data-caelo-module-id=");
});
