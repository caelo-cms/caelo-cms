// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fetchFontSource } from "./catalog.js";
import { inspectFontBytes, missingCharacters, openFont } from "./inspect.js";

const bytes = Buffer.from(
  readFileSync(new URL("./fixtures/NotoSans-Regular.base64.txt", import.meta.url), "utf8").trim(),
  "base64",
);
const license = { name: "OFL-1.1", text: "fixture", webEmbedding: true, documentEmbedding: true };
test("parses actual font metadata and checks German glyph coverage", () => {
  const font = inspectFontBytes(bytes, license);
  expect(font.family).toBe("Noto Sans");
  expect(font.weight).toBe(400);
  expect(font.format).toBe("woff");
  expect(missingCharacters(bytes, "Grüße ÄÖÜ ß\n123")).toEqual([]);
  expect(missingCharacters(bytes, "🦄🦄")).toEqual(["🦄"]);
  expect(inspectFontBytes(bytes, { ...license, documentEmbedding: false }).embedding.document).toBe(
    false,
  );
});
test("rejects malformed containers and declared decompression bombs before parsing", () => {
  expect(() => openFont(new Uint8Array(48))).toThrow("FontFormatUnsupported");
  const bad = Buffer.from(bytes);
  bad.writeUInt32BE(0x7fffffff, 16);
  expect(() => openFont(bad)).toThrow("FontContainerInvalid");
  expect(() => openFont(bytes.subarray(0, 100))).toThrow("FontContainerInvalid");
});
test("font network acquisition rejects redirects, other origins and oversized streams", async () => {
  let calls = 0;
  const fake = (async (_url: unknown, options: RequestInit) => {
    calls++;
    expect(options.redirect).toBe("error");
    return new Response(new Uint8Array(101));
  }) as typeof fetch;
  await expect(fetchFontSource("http://127.0.0.1/secret", 100, fake)).rejects.toThrow(
    "FontSourceNotAllowed",
  );
  await expect(
    fetchFontSource("https://raw.githubusercontent.com/other/repo/main/font.ttf", 100, fake),
  ).rejects.toThrow("FontSourceNotAllowed");
  expect(calls).toBe(0);
  await expect(
    fetchFontSource(
      "https://raw.githubusercontent.com/google/fonts/main/ofl/test/font.ttf",
      100,
      fake,
    ),
  ).rejects.toThrow("FontSourceTooLarge");
});
