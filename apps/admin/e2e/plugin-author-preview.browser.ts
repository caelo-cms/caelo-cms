// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

test("plugin preview is authenticated, read-only and inert even when opened directly", async ({
  page,
  browser,
}) => {
  const slug = `e2e-preview-${Date.now()}`;
  const manifest = {
    slug,
    version: "1.0.0",
    tier: 2,
    schema: {},
    adminSchema: { notes: { body: "text" } },
    operations: ["preview"],
    requestedCapabilities: ["cms_admin_schema", "companion_skills"],
    skills: [
      {
        slug: `${slug}-authoring`,
        displayName: `Create with ${slug}`,
        description: "Private creative projects",
        body: "Guide the author through a private creative project.",
        allowlistedTools: [],
      },
    ],
    capabilityReasons: {
      cms_admin_schema: "Read private drafts",
      companion_skills: "Offer the reviewed author workflow",
    },
  };
  const html =
    '<style>p{color:rgb(10,20,30)}</style><p class="story">Private story</p><script>window.previewEscaped=true</script><a href="https://example.com/leak">Leave</a><img src="https://example.com/leak">';
  const source = `export default {slug:${JSON.stringify(slug)},version:"1.0.0",tier:2,operations:{preview:async ctx=>{let denied=false;try{await ctx.adminQuery.insert("notes",{body:"should not exist"})}catch(e){denied=e.message.includes("PluginPreviewReadOnly")}const rows=await ctx.adminQuery.list("notes");if(!denied||rows.length)throw new Error("preview wrote data");return {html:${JSON.stringify(html)}}}}};`;
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);
  await page.goto("/security/plugins/installations");
  await page.getByLabel("Plugin package (.json)").setInputFiles({
    name: "preview.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ manifest, source })),
  });
  await page.getByRole("button", { name: "Submit package for review" }).click();
  const review = page.getByTestId(`installation-${slug}`);
  await review.getByRole("checkbox", { name: /cms_admin_schema/ }).check();
  await review.getByRole("checkbox", { name: /companion_skills/ }).check();
  await review.getByRole("button", { name: "Approve selected access and activate" }).click();
  await expect(page.getByRole("status")).toContainText("Approved package is running.");
  await page.goto("/edit");
  await expect(
    page.getByRole("button", { name: `Create with ${slug}`, exact: true }),
  ).toBeVisible();
  const previewPath = `/plugins/${slug}/preview`;
  const anon = await browser.newContext();
  try {
    const response = await anon.request.get(new URL(previewPath, page.url()).href, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
  } finally {
    await anon.close();
  }
  const response = await page.goto(previewPath);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  expect(response?.headers()["content-security-policy"]).toContain("sandbox;");
  await expect(page.getByText("Private story", { exact: true })).toBeVisible();
  await expect(page.locator("a,script")).toHaveCount(0);
  await expect(page.locator("img[src]")).toHaveCount(0);
  await page.goto("/security/plugins/installations");
  await review.getByRole("button", { name: "Revoke cms_admin_schema", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Access revoked.");
  expect((await page.goto(previewPath))?.status()).toBe(404);
  await page.goto("/edit");
  await expect(page.getByRole("button", { name: `Create with ${slug}`, exact: true })).toHaveCount(
    0,
  );
});
