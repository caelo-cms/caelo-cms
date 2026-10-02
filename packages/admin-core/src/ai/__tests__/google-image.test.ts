// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import { GeminiSdkImageProvider } from "../image-provider.js";

for (const model of [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
]) {
  test(`${model}: SDK sends key, image modality and portrait ratio`, async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchImpl = (async (url, init) => {
      expect(String(url)).toContain(`${model}:generateContent`);
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-google-key");
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      });
    }) as typeof fetch;
    const result = await new GeminiSdkImageProvider({ model }).generate({
      model,
      prompt: "A fox, without text",
      size: "1024x1792",
      apiKey: "test-google-key",
      fetchImpl,
    });
    expect(requestBody.generationConfig).toMatchObject({
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "9:16" },
    });
    expect(result.imageUrl).toBe("data:image/png;base64,aW1hZ2U=");
  });
}

test("a paid image request is not silently retried", async () => {
  let calls = 0;
  const provider = new GeminiSdkImageProvider({ model: "gemini-3-pro-image" });
  await expect(
    provider.generate({
      model: provider.model,
      prompt: "Fox",
      apiKey: "test-google-key",
      fetchImpl: (async () => {
        calls++;
        return new Response("Unavailable", { status: 503 });
      }) as typeof fetch,
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test("text-only replies do not masquerade as generated images", async () => {
  const provider = new GeminiSdkImageProvider({ model: "gemini-3-pro-image" });
  await expect(
    provider.generate({
      model: provider.model,
      prompt: "Fox",
      apiKey: "test-google-key",
      fetchImpl: (async () =>
        Response.json({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Cannot generate" }] },
              finishReason: "STOP",
            },
          ],
        })) as typeof fetch,
    }),
  ).rejects.toThrow("no image");
});

test("native image request sends reference bytes and resolution, and ignores thought images", async () => {
  let sent: Record<string, unknown> = {};
  const result = await new GeminiSdkImageProvider({ model: "gemini-3.1-flash-image" }).generate({
    model: "gemini-3.1-flash-image",
    prompt: "Illustration only, no text",
    apiKey: "test-key",
    referenceImages: [{ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
    imageSize: "2K",
    fetchImpl: (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { thought: true, inlineData: { mimeType: "image/png", data: "dGhvdWdodA==" } },
                { inlineData: { mimeType: "image/png", data: "ZmluYWw=" } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      });
    }) as typeof fetch,
  });
  expect(sent.contents).toEqual([
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: "AQID" } },
        { text: "Illustration only, no text" },
      ],
    },
  ]);
  expect(sent.generationConfig).toMatchObject({
    imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
  });
  expect(result.imageUrl).toBe("data:image/png;base64,ZmluYWw=");
});

test("unsupported resolution and excess reference inputs fail before a paid request", async () => {
  let calls = 0;
  const provider = new GeminiSdkImageProvider({ model: "gemini-2.5-flash-image" });
  const input = {
    model: provider.model,
    prompt: "Fox",
    apiKey: "test-key",
    fetchImpl: (async () => {
      calls++;
      return Response.json({});
    }) as typeof fetch,
  };
  await expect(provider.generate({ ...input, imageSize: "4K" })).rejects.toThrow(
    "Native resolution",
  );
  await expect(
    provider.generate({
      ...input,
      referenceImages: Array.from({ length: 4 }, () => ({
        data: new Uint8Array([1]),
        mediaType: "image/png" as const,
      })),
    }),
  ).rejects.toThrow("Too many reference images");
  expect(calls).toBe(0);
});
