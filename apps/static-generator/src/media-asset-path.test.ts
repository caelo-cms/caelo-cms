// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { isContentHashedPath } from "@caelo-cms/shared";
import { mediaAssetRelPath, mediaContentHash } from "./media-asset-path.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("published media names (#667)", () => {
  const hash = mediaContentHash(sha256(new Uint8Array([1, 2, 3])));

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

  it("change with the bytes, so replaced media never hides behind a cached URL", () => {
    const name = (bytes: number[]) =>
      mediaAssetRelPath({
        ref: "logo",
        isSlug: true,
        variant: "orig",
        format: "png",
        contentHash: mediaContentHash(sha256(new Uint8Array(bytes))),
      });
    expect(name([1, 2, 3])).not.toBe(name([1, 2, 4]));
    expect(name([1, 2, 3])).toBe(name([1, 2, 3]));
  });

  it("take the stored sha256 only (#1271: no read of the file)", () => {
    expect(() => mediaContentHash("not-a-digest")).toThrow("not a sha256 digest");
  });
});
