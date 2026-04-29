// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — upload an image via the multipart endpoint, verify the list
 * grid shows it and the detail page renders the variant grid + alt
 * editor. Uses a tiny PNG generated in-test (one black pixel) so the
 * spec doesn't need a fixture file on disk.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const ALT_TEXT = `p7-upload-test-${ts}`;
const BASE = "http://localhost:4173";

// 1×1 black PNG (smallest valid image — file-type sniffer accepts).
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFAAH/0E5p3wAAAABJRU5ErkJggg==",
  "base64",
);

test.beforeAll(() => {
  clearLoginRateBucket();
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM media_assets WHERE alt = \${process.env.ALT_TEXT}\`;
    });
    await sql.end();
    `,
    { ALT_TEXT },
  );
});

test("upload via /api/media/upload → list grid → detail page renders variants", async ({
  page,
  request,
}) => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', "dev-owner@example.com");
  await page.fill('input[name="password"]', "dev-owner-password");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`);

  // Pull the cookie and CSRF for the multipart POST.
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const upload = await request.post(`${BASE}/api/media/upload`, {
    multipart: {
      file: { name: `p7-${ts}.png`, mimeType: "image/png", buffer: PNG_1x1 },
      alt: ALT_TEXT,
    },
    headers: { cookie: cookieHeader },
  });
  expect(upload.ok()).toBe(true);
  const json = (await upload.json()) as { assetId: string; deduped: boolean };
  expect(json.deduped).toBe(false);

  await page.goto(`${BASE}/content/media`);
  await expect(page.getByText(`p7-${ts}.png`).first()).toBeVisible();

  await page.goto(`${BASE}/content/media/${json.assetId}`);
  await expect(page.getByText("Variants")).toBeVisible();
  await expect(page.getByText("orig")).toBeVisible();
  // Alt editor surfaces the seeded value.
  const altField = page.locator('textarea[name="alt"]');
  await expect(altField).toHaveValue(ALT_TEXT);
});
