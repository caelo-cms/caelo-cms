// SPDX-License-Identifier: MPL-2.0
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendChat } from "./chat-bridge.js";
import { uploadedImageSchema, uploadImages, uploadImagesInput } from "./image-upload.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
  "base64",
);
const assetId = "11111111-1111-4111-8111-111111111111";
let chatBody: unknown;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    expect(request.headers.get("x-caelo-mcp-token")).toBe("test-token");
    if (new URL(request.url).pathname === "/api/mcp/chat") {
      chatBody = await request.json();
      return Response.json({ assistant: "ok" });
    }
    expect(request.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await request.arrayBuffer())).toEqual(png);
    return Response.json({ assetId, mime: "image/png", deduped: false });
  },
});
const opts = { adminUrl: server.url.toString(), token: "test-token" };
const dir = await mkdtemp(join(tmpdir(), "caelo-mcp-upload-"));
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true });
});

test("base64 upload returns references and caelo_chat forwards them", async () => {
  const result = await uploadImages(opts, {
    images: [{ base64: png.toString("base64"), filename: "reference.png" }],
  });
  const { attachments } = JSON.parse(result.content[0]!.text);
  expect(attachments).toEqual([{ assetId, mime: "image/png", alt: "reference.png" }]);
  await sendChat({ ...opts, message: "Use this character", attachments });
  expect(chatBody).toEqual({ message: "Use this character", attachments });
});

test("local files avoid passing large base64 through the calling model; partial errors retain successes", async () => {
  const filePath = join(dir, "character.png");
  await writeFile(filePath, png);
  const result = await uploadImages(opts, {
    images: [{ filePath }, { filePath: join(dir, "missing.png") }],
  });
  const body = JSON.parse(result.content[0]!.text);
  expect(body.attachments).toHaveLength(1);
  expect(body.results[1].error).toContain("ENOENT");
  expect(result.isError).toBeUndefined();
});

test("rejects oversized files before HTTP upload", async () => {
  const filePath = join(dir, "oversized.png");
  await writeFile(filePath, Buffer.alloc(5 * 1024 * 1024 + 1));
  const result = await uploadImages(opts, { images: [{ filePath }] });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain("5 MiB");
});

test("rejects ambiguous inputs, malformed base64, unsupported references and batches over four", () => {
  for (const image of [
    {},
    { filePath: "x", base64: "AAAA" },
    { base64: "data:image/png;base64,AAAA" },
    { base64: "%%%=" },
  ]) {
    expect(uploadImagesInput.safeParse({ images: [image] }).success).toBe(false);
  }
  expect(uploadImagesInput.safeParse({ images: Array(5).fill({ base64: "AAAA" }) }).success).toBe(
    false,
  );
  expect(
    uploadedImageSchema.safeParse({ storageKey: "private/image", mime: "image/png" }).success,
  ).toBe(false);
  expect(uploadedImageSchema.safeParse({ assetId, mime: "image/svg+xml" }).success).toBe(false);
});
