// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PluginPrivateFiles } from "@caelo-cms/plugin-sdk";
import sharp from "sharp";
import { resolvePrivatePreviewImages } from "./private-preview-images.js";

test("private previews resolve a book with bounded concurrent authorized reads", async () => {
  const bytes = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "orange" },
  })
    .jpeg()
    .toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
  let active = 0,
    peak = 0,
    checked = 0;
  const unused = async () => {
    throw new Error("No writes permitted in preview");
  };
  const files: PluginPrivateFiles = {
    begin: unused,
    writeChunk: unused,
    commit: unused,
    remove: unused,
    async stat({ id }) {
      active++;
      peak = Math.max(peak, active);
      checked++;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active--;
      return { id, sha256, status: "ready", sizeBytes: bytes.length, mediaType: "image/jpeg" };
    },
    async readChunk() {
      return { base64: bytes.toString("base64") };
    },
  };
  const html = ids.map((id) => `<img src="caelo-file:${id}:${sha256}">`).join("");
  const result = await resolvePrivatePreviewImages(html, async () => files);
  expect(result.size).toBe(8);
  expect(checked).toBe(8);
  expect(peak).toBe(4);
  for (const value of result.values())
    expect(value.startsWith("data:image/webp;base64,")).toBe(true);
});
