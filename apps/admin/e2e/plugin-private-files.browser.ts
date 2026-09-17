// SPDX-License-Identifier: MPL-2.0

import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { runBun } from "./_seed.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWOIqjhBEmIY1VAxGkpRwzVpAACJzZoQPNqOjQAAAABJRU5ErkJggg==";

test("private raster preview and attachment download require live author and plugin access", async ({
  page,
  browser,
}) => {
  const slug = `e2e-files-${Date.now()}`;
  const id = randomUUID();
  const bytes = Buffer.from(png, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const html = `<style>.story{position:absolute;top:0}</style><img src="caelo-file:${id}:${sha256}" alt="Private illustration"><p class="story">Separate editable text</p>`;
  const manifest = {
    slug,
    version: "1.0.0",
    tier: 2,
    schema: {},
    operations: ["preview"],
    requestedCapabilities: ["private_files"],
    capabilityReasons: { private_files: "Keep unpublished illustrations and downloads private" },
  };
  const source = `export default {slug:${JSON.stringify(slug)},version:"1.0.0",tier:2,operations:{preview:async()=>({html:${JSON.stringify(html)}})}};`;
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);
  await page.goto("/security/plugins/installations");
  await page.getByLabel("Plugin package (.json, .json.gz or .json.br)").setInputFiles({
    name: "files.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ manifest, source })),
  });
  await page.getByRole("button", { name: "Submit package for review" }).click();
  const review = page.getByTestId(`installation-${slug}`);
  await review.getByRole("checkbox", { name: /private_files/ }).check();
  await review.getByRole("button", { name: "Approve selected access and activate" }).click();
  await expect(page.getByRole("status")).toContainText("Approved package is running.");

  // Prepare the raster through the real private SDK, without a paid image provider.
  runBun(
    `
    import { SQL } from "bun";
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
    import { bootstrap, loadedPlugins, makePluginContext, resetPluginHost } from "@caelo-cms/plugin-host";
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const sql = new SQL(process.env.ADMIN_DATABASE_URL, {max:1});
    const root = await mkdtemp(join(tmpdir(), "private-file-browser-"));
    try {
      const owner = await sql.begin(async tx => { await tx.unsafe("SET LOCAL caelo.actor_kind='system'"); return (await tx\`SELECT id::text FROM users WHERE email='dev-owner@example.com'\`)[0].id; });
      const registry = new OperationRegistry(); registerAdminOps(registry);
      await bootstrap({ infra: {adapter,registry}, pluginsRoot: root, systemActorId: "00000000-0000-0000-0000-00000000ffff" });
      const context = await makePluginContext({plugin: loadedPlugins.bySlug(process.env.FILE_PLUGIN_SLUG), infra:{adapter,registry}, authorContext: { actor:{actorId:owner,actorKind:"human",requestId:"file-browser-fixture"},operatorActorId:owner} });
      const input = JSON.parse(process.env.FILE_METADATA);
      await context.privateFiles.begin(input);
      await context.privateFiles.writeChunk({id:input.id,offset:0,base64:process.env.FILE_PNG});
      await context.privateFiles.commit({id:input.id});
    } finally { resetPluginHost(); await adapter.close(); await sql.close(); await rm(root,{recursive:true,force:true}); }
  `,
    {
      FILE_PLUGIN_SLUG: slug,
      FILE_METADATA: JSON.stringify({
        id,
        mediaType: "image/png",
        sizeBytes: bytes.length,
        sha256,
      }),
      FILE_PNG: png,
    },
  );

  const previewPath = `/plugins/${slug}/preview`;
  const filePath = `/plugins/${slug}/files/${id}/${sha256}`;
  const anon = await browser.newContext();
  try {
    for (const path of [previewPath, filePath])
      expect(
        (await anon.request.get(new URL(path, page.url()).href, { maxRedirects: 0 })).status(),
      ).toBe(303);
  } finally {
    await anon.close();
  }
  const response = await page.goto(previewPath);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("sandbox;");
  const img = page.getByAltText("Private illustration");
  await expect(img).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await expect
    .poll(() => img.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(16);
  await expect(page.getByText("Separate editable text", { exact: true })).toBeVisible();
  const download = await page.request.get(filePath);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toContain("attachment;");
  expect(download.headers()["content-type"]).toBe("application/octet-stream");
  expect(download.headers()["cache-control"]).toBe("no-store");
  expect(await download.body()).toEqual(bytes);
  expect((await page.request.get(`/plugins/${slug}/files/${id}/${"a".repeat(64)}`)).status()).toBe(
    404,
  );
  await page.goto("/security/plugins/installations");
  await review.getByRole("button", { name: "Revoke private_files", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Access revoked.");
  expect((await page.request.get(filePath)).status()).toBe(404);
  expect((await page.goto(previewPath))?.status()).toBe(404);
});
