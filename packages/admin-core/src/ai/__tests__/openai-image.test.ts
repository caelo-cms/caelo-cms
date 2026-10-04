// SPDX-License-Identifier: MPL-2.0

/**
 * #528 — the OpenAI image adapter goes through the AI SDK's generateImage:
 * a generation hits /v1/images/generations, an edit /v1/images/edits with
 * the source image and the mask in the multipart body.
 */

import { expect, test } from "bun:test";
import { OpenAiImageProvider } from "../image-provider.js";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
    "base64",
  ),
);
const B64 = Buffer.from(PNG).toString("base64");

function recorder() {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body });
    return Response.json({
      created: 1,
      data: [{ b64_json: B64 }],
      usage: { input_tokens: 50, output_tokens: 1000, total_tokens: 1050 },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("a generation is sent to images/generations and returns inline bytes", async () => {
  const { calls, fetchImpl } = recorder();
  const provider = new OpenAiImageProvider({ model: "dall-e-3" });
  const result = await provider.generate({
    prompt: "a lighthouse",
    model: "dall-e-3",
    apiKey: "test",
    size: "1792x1024",
    fetchImpl,
  });
  expect(calls[0]!.url).toContain("/v1/images/generations");
  expect(JSON.parse(String(calls[0]!.body))).toMatchObject({
    model: "dall-e-3",
    size: "1792x1024",
  });
  expect(result.imageUrl).toStartWith("data:image/png;base64,");
});

test("an edit with a mask is sent to images/edits with the source and the mask", async () => {
  const { calls, fetchImpl } = recorder();
  const provider = new OpenAiImageProvider({ model: "gpt-image-1" });
  const result = await provider.generate({
    prompt: "make the sky dusk",
    model: "gpt-image-1",
    apiKey: "test",
    size: "1792x1024",
    editSource: { data: PNG, mediaType: "image/png" },
    mask: { data: PNG, mediaType: "image/png" },
    fetchImpl,
  });
  expect(calls[0]!.url).toContain("/v1/images/edits");
  const form = calls[0]!.body as FormData;
  expect(form.get("model")).toBe("gpt-image-1");
  expect(form.get("size")).toBe("1536x1024");
  expect(form.getAll("image").length + form.getAll("image[]").length).toBeGreaterThan(0);
  expect(form.get("mask")).not.toBeNull();
  expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 1000 });
});

test("references or a mask without a source are refused (OpenAI takes them only when editing)", async () => {
  const provider = new OpenAiImageProvider({ model: "gpt-image-1" });
  await expect(
    provider.generate({
      prompt: "x",
      model: "gpt-image-1",
      apiKey: "test",
      referenceImages: [{ data: PNG, mediaType: "image/png" }],
    }),
  ).rejects.toThrow("only when editing");
});
