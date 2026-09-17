// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { readPluginPackage } from "./plugin-package.js";

test("compressed packages preserve the exact reviewed artifact and bound decompression", async () => {
  const artifact = { manifest: { slug: "example" }, source: "export default {};" };
  expect(
    await readPluginPackage(
      new File([brotliCompressSync(JSON.stringify(artifact))], "example.json.br"),
    ),
  ).toEqual(artifact);
  expect(
    await readPluginPackage(new File([gzipSync(JSON.stringify(artifact))], "example.json.gz")),
  ).toEqual(artifact);
  expect(await readPluginPackage(new File([JSON.stringify(artifact)], "example.json"))).toEqual(
    artifact,
  );
  await expect(
    readPluginPackage(new File([gzipSync(Buffer.alloc(20_000_001, 32))], "large.json.gz")),
  ).rejects.toThrow();
  await expect(readPluginPackage(new File(["invalid"], "broken.json.gz"))).rejects.toThrow();
});
