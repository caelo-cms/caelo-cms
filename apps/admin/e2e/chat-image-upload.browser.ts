// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { attachTestProviderHeader, clearTestProvider, registerTestProvider } from "./helpers.js";

const base = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const fixture = `chat-image-upload-${Date.now()}`;

function mintToken(scope: "chat" | "admin"): { id: string; plaintextToken: string } {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    const actorId = await db.begin(async tx => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`SELECT id::text FROM users WHERE email = 'dev-owner@example.com'\`;
      return rows[0].id;
    });
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const registry = new OperationRegistry(); registerAdminOps(registry);
    const r = await execute(registry, adapter, { actorId, actorKind: 'human', requestId: 'upload-e2e' }, 'mcp_tokens.create', { displayName: 'upload-e2e', scope: process.env.UPLOAD_TEST_SCOPE });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    process.stdout.write(JSON.stringify(r.value));
    await adapter.close(); await db.end();
  `,
    ],
    { env: { ...process.env, UPLOAD_TEST_SCOPE: scope }, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

test.afterAll(async () => {
  await clearTestProvider(base, fixture);
});

test("picker, paste, drop, image-only send, HTTP retry and reload preserve attachments", async ({
  page,
  context,
}) => {
  await registerTestProvider(base, fixture, [
    { kind: "text-delta", text: "Reference received." },
    { kind: "usage", inputTokens: 10, outputTokens: 3, cachedTokens: 0 },
    { kind: "done", stopReason: "end_turn" },
  ]);
  await attachTestProviderHeader(context, fixture);
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit");
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page.getByTestId("chat-attach-images")).toBeEnabled();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3399ee" } })
    .png()
    .toBuffer();
  let releaseUpload: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route(
    "**/api/chat/images",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  const uploadRequest = page.waitForRequest("**/api/chat/images");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("chat-attach-images").click();
  await (await chooser).setFiles({ name: "reference.png", mimeType: "image/png", buffer: png });
  const csrf = (await uploadRequest).headers()["x-csrf-token"]!;
  await expect(page.getByTestId("chat-attach-images")).toBeDisabled();
  await page.getByTestId("chat-composer").fill("Do not send before the image arrives");
  await expect(page.getByTestId("chat-send")).toBeDisabled();
  await page.getByTestId("chat-composer").clear();
  releaseUpload();
  const pending = page.getByTestId("chat-pending-attachments");
  await expect(pending.locator("img")).toHaveCount(1);
  await expect(page.getByTestId("chat-send")).toBeEnabled();
  const imgUrl = await pending.locator("img").getAttribute("src");
  expect((await page.request.get(imgUrl!)).ok()).toBe(true);

  // Same bytes do not crash Svelte's keyed list or create duplicate chips.
  await page
    .getByTestId("chat-image-input")
    .setInputFiles({ name: "duplicate.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("chat-attach-images")).toBeEnabled();
  await expect(pending.locator("img")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove reference.png" }).click();
  await expect(pending).toHaveCount(0);

  await page.getByTestId("chat-composer").evaluate((el, base64) => {
    const data = new DataTransfer();
    data.items.add(
      new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "pasted.png", {
        type: "image/png",
      }),
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, png.toString("base64"));
  await expect(pending.locator("img")).toHaveCount(1);

  await page.route(
    "**/stream",
    (route) => route.fulfill({ status: 503, body: "temporarily unavailable" }),
    { times: 1 },
  );
  await page.getByTestId("chat-send").click();
  await expect(page.getByText("Your draft is ready to retry.", { exact: false })).toBeVisible();
  await expect(pending.locator("img")).toHaveCount(1);
  await page.getByTestId("chat-send").click();
  await expect(page.getByText("Reference received.", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("chat-turn-status")).toHaveAttribute("data-turn-state", "idle");
  await page.reload();
  await expect(page.getByTestId("chat-attach-images")).toBeEnabled();
  await expect(page.locator(`img[src="${imgUrl}"]`)).toHaveCount(1);

  await page.getByTestId("chat-composer").evaluate((el, base64) => {
    const data = new DataTransfer();
    data.items.add(
      new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "dropped.png", {
        type: "image/png",
      }),
    );
    el.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  }, png.toString("base64"));
  await expect(pending.locator("img")).toHaveCount(1);

  const extraImages = await Promise.all(
    ["#110000", "#220000", "#330000", "#440000"].map(async (background, i) => ({
      name: `extra-${i}.png`,
      mimeType: "image/png",
      buffer: await sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer(),
    })),
  );
  await page.getByTestId("chat-image-input").setInputFiles(extraImages);
  await expect(pending.locator("img")).toHaveCount(4);
  await expect(page.getByTestId("chat-upload-error")).toContainText("Max 4 images");

  // Direct requests bypass browser hints: sniffing, decoding, size and CSRF remain enforced.
  for (const [name, mimeType, buffer, status] of [
    ["fake.png", "image/png", Buffer.from("this is not an image"), 415],
    ["unsafe.svg", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 415],
    ["large.png", "image/png", Buffer.alloc(5 * 1024 * 1024 + 1), 413],
  ] as const) {
    const response = await page.request.post("/api/chat/images", {
      headers: { "x-csrf-token": csrf, origin: base },
      multipart: { file: { name, mimeType, buffer } },
    });
    expect(response.status()).toBe(status);
  }
  const noCsrf = await page.request.post("/api/chat/images", {
    headers: { origin: base },
    multipart: { file: { name: "image.png", mimeType: "image/png", buffer: png } },
  });
  expect(noCsrf.status()).toBe(403);
});

test("real MCP stdio clients upload images with both token scopes and return usable media references", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit");
  const request = page.request;
  // A real image larger than the adapter's former 512 KiB default.
  const png = await sharp(randomBytes(768 * 768 * 3), {
    raw: { width: 768, height: 768, channels: 3 },
  })
    .png()
    .toBuffer();
  for (const mode of ["chat", "admin"] as const) {
    const token = mintToken(mode);
    const client = new Client({ name: "upload-e2e", version: "1" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [
        resolve("../../packages/mcp-server/src/index.ts"),
        ...(mode === "admin" ? ["admin"] : []),
      ],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        CAELO_ADMIN_URL: base,
        CAELO_MCP_TOKEN: token.plaintextToken,
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "caelo_upload_images")).toBe(true);
      const response = await client.callTool({
        name: "caelo_upload_images",
        arguments: { images: [{ base64: png.toString("base64"), filename: "mcp-reference.png" }] },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const content = response.content as { type: string; text: string }[];
      const { attachments } = JSON.parse(content[0]!.text);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].mime).toBe("image/png");
      const image = await request.get(`/_caelo/media/${attachments[0].assetId}/orig`);
      expect(image.ok()).toBe(true);
      expect(image.headers()["content-type"]).toBe("image/png");
      expect(
        await sharp(await image.body())
          .raw()
          .toBuffer(),
      ).toEqual(await sharp(png).raw().toBuffer());
    } finally {
      await client.close();
    }
  }
  const missing = await request.post("/api/mcp/images", {
    headers: { "content-type": "application/octet-stream" },
    data: png,
  });
  expect(missing.status()).toBe(401);
  const unknown = await request.post("/api/mcp/images", {
    headers: {
      "content-type": "application/octet-stream",
      "x-caelo-mcp-token": "mcp_unknown_token",
    },
    data: png,
  });
  expect(unknown.status()).toBe(401);
});
