// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { localPluginPreview, previewFromResult } from "./plugin-preview.js";

test("only local plugin documents open in the editor, with canonical bounded arguments", () => {
  const origin = "https://cms.test";
  expect(
    localPluginPreview(
      "/plugins/example/preview?args=%7B%22id%22%3A%221%22%7D&channel=forged",
      origin,
    ),
  ).toBe("/plugins/example/preview?args=%7B%22id%22%3A%221%22%7D");
  for (const input of [
    "https://other.test/plugins/example/preview",
    "//other.test/plugins/example/preview",
    "javascript:alert(1)",
    "/security/ai",
    "/plugins/example/preview?args=[]",
    "/plugins/example/preview?args=null",
    "/plugins/example/preview?args=" + "x".repeat(3000),
  ])
    expect(localPluginPreview(input, origin)).toBeNull();
  expect(previewFromResult('{"previewUrl":"/plugins/example/preview"}', origin)).toBe(
    "/plugins/example/preview?args=%7B%7D",
  );
  expect(previewFromResult("not json", origin)).toBeNull();
});
