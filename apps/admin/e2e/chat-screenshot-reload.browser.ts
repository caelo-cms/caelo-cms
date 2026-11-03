// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #359 — a screenshot card keeps its image after a reload.
 *
 * A tool's screenshot is stored under `chat-images/` and referenced from
 * the tool row (#356). The spec writes exactly that state — the object in
 * the media store, an assistant row calling `screenshot_page`, the tool row
 * with the attachment — then opens the chat twice (load + reload) and
 * checks the card renders the stored bytes both times. It also checks the
 * route answers only for the chat that owns the message, and that a client
 * cannot attach a stored chat image to its own message by key.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { clearLoginRateBucket, openOwnerChat, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

/** The admin server's media root: `MEDIA_ROOT_DIR`, else `data/media` under apps/admin. */
const MEDIA_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  process.env.MEDIA_ROOT_DIR ?? "data/media",
);

/** Seed a screenshot_page call + its tool row carrying the stored image. */
function seedScreenshotTurn(chatSessionId: string, storageKey: string): string {
  return runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
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
    const ctx = { actorId: ownerId, actorKind: "human", requestId: "e2e-359" };
    const toolCallId = "tc-359-" + crypto.randomUUID();
    const rows = [
      { role: "user", content: "Take a screenshot of the home page" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: toolCallId, name: "screenshot_page", arguments: { path: "/" } }],
      },
      {
        role: "tool",
        content: "Screenshot of / captured.",
        toolCallId,
        attachments: [{ storageKey: process.env.STORAGE_KEY, mime: "image/png" }],
      },
    ];
    let toolMessageId = "";
    for (const row of rows) {
      const r = await execute(registry, adapter, ctx, "chat.append_message", {
        chatSessionId: process.env.CHAT_ID,
        ...row,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      toolMessageId = r.value.messageId;
    }
    await adapter.close();
    process.stdout.write(toolMessageId);
    `,
    { CHAT_ID: chatSessionId, STORAGE_KEY: storageKey },
  ).trim();
}

test("a screenshot card shows its stored image after a reload", async ({ page }) => {
  const png = await sharp({
    create: { width: 48, height: 32, channels: 3, background: `#${randomUUID().slice(0, 6)}` },
  })
    .png()
    .toBuffer();
  const sha = createHash("sha256").update(png).digest("hex");
  const storageKey = `chat-images/${new Date().toISOString().slice(0, 10)}/${sha}.png`;
  mkdirSync(dirname(resolve(MEDIA_ROOT, storageKey)), { recursive: true });
  writeFileSync(resolve(MEDIA_ROOT, storageKey), png);

  const chat = openOwnerChat(`e2e-screenshot-reload-${Date.now()}`);
  const messageId = seedScreenshotTurn(chat, storageKey);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  const imageUrl = `/content/chat/${chat}/images/${messageId}/0`;
  for (const open of [() => page.goto(`/content/chat/${chat}`), () => page.reload()]) {
    await open();
    const card = page.getByTestId("tool-card-screenshot");
    await expect(card).toHaveAttribute("open", "");
    const img = card.getByTestId("tool-card-screenshot-image");
    await expect(img).toHaveAttribute("src", imageUrl);
    await img.scrollIntoViewIfNeeded();
    // Loaded, not a broken image: the browser decoded the stored PNG.
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(48);
  }

  const served = await page.request.get(imageUrl);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(served.headers()["cache-control"]).toBe("private, no-store");
  expect(Buffer.from(await served.body()).equals(png)).toBe(true);

  // The same message addressed through another chat is not found.
  const otherChat = openOwnerChat(`e2e-screenshot-reload-other-${Date.now()}`);
  const foreign = await page.request.get(`/content/chat/${otherChat}/images/${messageId}/0`);
  expect(foreign.status()).toBe(404);

  // A client cannot attach a chat image by key to its own message: only
  // operator uploads (assetId) pass the stream boundary.
  const { token } = (await (await page.request.get("/_caelo/csrf-token")).json()) as {
    token: string;
  };
  const smuggled = await page.request.post(`/content/chat/${otherChat}/stream`, {
    headers: { "content-type": "application/json", "x-csrf-token": token },
    data: { content: "look", attachments: [{ storageKey, mime: "image/png" }] },
  });
  expect(smuggled.status()).toBe(400);
  expect(await smuggled.text()).toContain("Use uploaded media assets");
});
