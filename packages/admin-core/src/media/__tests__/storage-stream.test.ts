// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — LocalVolumeAdapter serves objects as streams with their size,
 * and reports a size without reading the object; a missing key throws up
 * front (before a response would start streaming).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalVolumeAdapter } from "../storage.js";

const root = mkdtempSync(join(tmpdir(), "caelo-1216-storage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("LocalVolumeAdapter streaming (#1216)", () => {
  it("streams an object's exact bytes with its size", async () => {
    const storage = new LocalVolumeAdapter(root);
    const bytes = new Uint8Array(256 * 1024).map((_, i) => i % 251);
    await storage.put("abc/orig.png", bytes, "image/png");
    expect(await storage.size("abc/orig.png")).toBe(bytes.byteLength);
    const { body, sizeBytes } = await storage.openStream("abc/orig.png");
    expect(sizeBytes).toBe(bytes.byteLength);
    const read = new Uint8Array(await new Response(body).arrayBuffer());
    expect(read).toEqual(bytes);
  });

  it("throws for a missing object before any stream exists", async () => {
    const storage = new LocalVolumeAdapter(root);
    await expect(storage.openStream("nope/orig.png")).rejects.toThrow();
    await expect(storage.size("nope/orig.png")).rejects.toThrow();
  });

  it("keeps the root containment guard", async () => {
    const storage = new LocalVolumeAdapter(root);
    await expect(storage.openStream("../escape")).rejects.toThrow(/escapes rootDir/);
  });
});
