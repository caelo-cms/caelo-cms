// SPDX-License-Identifier: MPL-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContentHashedPath } from "@caelo-cms/shared";
import {
  mediaAssetRelPath,
  mediaContentHash,
  readStoredMedia,
  writePublishedMedia,
} from "./media-asset-path.js";

const root = mkdtempSync(join(tmpdir(), "caelo-media-asset-path-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("published media names (#667)", () => {
  const hash = mediaContentHash(new Uint8Array([1, 2, 3]));

  it("keep the readable slug and add the content hash", () => {
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(
      mediaAssetRelPath({
        ref: "searchviu-logo",
        isSlug: true,
        variant: "orig",
        format: "png",
        contentHash: hash,
      }),
    ).toBe(`_assets/searchviu-logo.${hash}.png`);
    expect(
      mediaAssetRelPath({
        ref: "hero",
        isSlug: true,
        variant: "webp-800",
        format: "webp",
        contentHash: hash,
      }),
    ).toBe(`_assets/hero/webp-800.${hash}.webp`);
    const id = "0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f";
    expect(
      mediaAssetRelPath({
        ref: id,
        isSlug: false,
        variant: "orig",
        format: "jpeg",
        contentHash: hash,
      }),
    ).toBe(`_assets/${id}/orig.${hash}.jpg`);
  });

  it("are served immutable by every publisher (shared cache policy)", () => {
    for (const p of [
      mediaAssetRelPath({
        ref: "searchviu-logo",
        isSlug: true,
        variant: "orig",
        format: "png",
        contentHash: hash,
      }),
      mediaAssetRelPath({
        ref: "hero",
        isSlug: true,
        variant: "webp-1600",
        format: "webp",
        contentHash: hash,
      }),
      mediaAssetRelPath({
        ref: "brand-font",
        isSlug: true,
        variant: "orig",
        format: "woff2",
        contentHash: hash,
      }),
    ]) {
      expect(isContentHashedPath(p)).toBe(true);
    }
  });

  it("change with the bytes, so replaced media never hides behind a cached URL", async () => {
    const build = join(root, "build");
    const a = await writePublishedMedia({
      buildDir: build,
      ref: "logo",
      isSlug: true,
      variant: "orig",
      format: "png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    const b = await writePublishedMedia({
      buildDir: build,
      ref: "logo",
      isSlug: true,
      variant: "orig",
      format: "png",
      bytes: new Uint8Array([1, 2, 4]),
    });
    expect(a).not.toBe(b);
    expect(new Uint8Array(await readFile(join(build, a)))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads stored files, null when missing, and refuses keys escaping the media root", async () => {
    const media = join(root, "media");
    await mkdir(join(media, "abc"), { recursive: true });
    await writeFile(join(media, "abc", "orig.png"), new Uint8Array([9]));
    expect(await readStoredMedia(media, "abc/orig.png")).toEqual(new Uint8Array([9]));
    expect(await readStoredMedia(media, "abc/missing.png")).toBeNull();
    await expect(readStoredMedia(media, "../outside.png")).rejects.toThrow("escapes mediaRoot");
  });
});
