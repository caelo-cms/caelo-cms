// SPDX-License-Identifier: MPL-2.0
import { brotliDecompressSync, gunzipSync } from "node:zlib";

/** Compression affects transport only; review and receipts bind the decoded artifact. */
export async function readPluginPackage(file: File): Promise<unknown> {
  if (file.size > 20_000_000) throw new Error("Package upload exceeds 20 MB");
  const bytes = Buffer.from(await file.arrayBuffer());
  const decoded = file.name.endsWith(".gz")
    ? gunzipSync(bytes, { maxOutputLength: 20_000_000 })
    : file.name.endsWith(".br")
      ? brotliDecompressSync(bytes, { maxOutputLength: 20_000_000 })
      : bytes;
  return JSON.parse(decoded.toString("utf8"));
}
