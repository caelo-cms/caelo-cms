// SPDX-License-Identifier: MPL-2.0

/**
 * Settings → SEO: the Owner keeps the search results pages out of the live
 * robots.txt (#1706). The rules are written as robots.txt lines, checked
 * strictly, shown as the live file they make, and saved without going
 * live (docs/dev/robots-rules.md).
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

test("Owner adds robots.txt rules, sees the live file, and a broken line is refused", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);

  await page.goto("/settings/seo");
  const card = page.getByTestId("robots-rules");
  await expect(card).toBeVisible();
  const rules = card.getByLabel("Rules");
  const save = card.getByRole("button", { name: "Save robots.txt rules" });

  await rules.fill("User-agent: *\nDisallow: /de/suche/\nDisallow: /en/search/");
  await save.click();
  await expect(page.getByRole("alert").getByText(/robots\.txt rules saved/)).toBeVisible();
  await page.reload();
  await expect(rules).toHaveValue("User-agent: *\nDisallow: /de/suche/\nDisallow: /en/search/");
  const preview = page.getByTestId("robots-txt-preview");
  // The live file: the Owner's * group, and no `Allow: /` that would undo it.
  expect(await preview.textContent()).toMatch(
    /^User-agent: \*\nDisallow: \/de\/suche\/\nDisallow: \/en\/search\/\n/,
  );

  // A line that is no rule never reaches the file; the field keeps what was typed.
  await rules.fill("User-agent: *\nSitemap: https://elsewhere.example/sitemap.xml");
  await save.click();
  await expect(
    page.getByRole("alert").getByText(/only User-agent, Content-Signal, Allow and Disallow/),
  ).toBeVisible();
  await expect(rules).toHaveValue("User-agent: *\nSitemap: https://elsewhere.example/sitemap.xml");

  // #1758 — the training preference token and a Content-Signal are taken,
  // shown in the live file, and noted as preferences.
  await rules.fill(
    "User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n\nUser-agent: __usage_ai-training\nDisallow: /",
  );
  await save.click();
  await expect(page.getByRole("alert").getByText(/robots\.txt rules saved/)).toBeVisible();
  await page.reload();
  expect(await page.getByTestId("robots-txt-preview").textContent()).toContain(
    "User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n\nUser-agent: __usage_ai-training\nDisallow: /",
  );
  await expect(page.getByTestId("robots-note").first()).toContainText("keeps no crawler out");
  // A signal with a word it does not know is refused with its line.
  await rules.fill("User-agent: *\nContent-Signal: train=no\nAllow: /");
  await save.click();
  await expect(page.getByRole("alert").getByText(/line 2: Content-Signal names/)).toBeVisible();

  // A rule that takes the whole site out of search is said so.
  await rules.fill("User-agent: *\nDisallow: /");
  await save.click();
  await expect(page.getByRole("alert").getByText(/robots\.txt rules saved/)).toBeVisible();
  await expect(
    page.getByRole("alert").getByText(/every crawler may crawl nothing of this site/),
  ).toBeVisible();

  // Back to none, where a new site starts.
  await rules.fill("");
  await save.click();
  await expect(page.getByRole("alert").getByText(/robots\.txt rules saved/)).toBeVisible();
  await page.reload();
  expect(await page.getByTestId("robots-txt-preview").textContent()).toMatch(
    /^User-agent: \*\nAllow: \/\n/,
  );
});
