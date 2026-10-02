// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { previewContext } from "./preview-context.js";

test("preview exposes reads but strips effects, cross-plugin calls and elevated providers", async () => {
  let writes = 0;
  const write = async () => {
    writes++;
  };
  const query = {
    list: async () => [{ title: "Private draft" }],
    insert: write,
    update: write,
    delete: write,
    compareAndSwap: async () => {
      writes++;
      return true;
    },
  };
  const ctx = {
    query,
    adminQuery: query,
    api: { list: write, get: write },
    captcha: { requireProof: write },
    theme: {},
    visitor: {},
    ai: { generate: write },
    cms: { call: write },
  } as unknown as PluginContextTier1;
  const preview = previewContext(ctx);
  expect(await preview.adminQuery!.list("books")).toEqual([{ title: "Private draft" }]);
  await expect(preview.adminQuery!.insert("books", {})).rejects.toThrow("PluginPreviewReadOnly");
  await expect(preview.query.delete("books", {})).rejects.toThrow("PluginPreviewReadOnly");
  expect(preview.ai).toBeUndefined();
  expect(preview.cms).toBeUndefined();
  expect(writes).toBe(0);
});
