// SPDX-License-Identifier: MPL-2.0

/**
 * Cache keying of pinned-face slices: since the axis policy exists,
 * slices are no longer a pure function of the source bytes, so the
 * effective spec must be part of every cache name.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveAxisSpec } from "@caelo-cms/shared";
import {
  axisSpecHash,
  cachedPinnedFaceSlices,
  clearPinnedDeliveryMemo,
  pinnedFaceSlices,
} from "./pinned-font-delivery.js";

const inter = Buffer.from(
  readFileSync(
    new URL(
      "../../../packages/font-service/src/fixtures/InterVariable-mini.woff2.base64.txt",
      import.meta.url,
    ),
    "utf8",
  ).trim(),
  "base64",
);
const sha256 = createHash("sha256").update(inter).digest("hex");
const FULL: EffectiveAxisSpec = {
  opsz: { mode: "full", min: 14, max: 32 },
  wght: { mode: "full", min: 100, max: 900 },
};
const DEFAULT: EffectiveAxisSpec = {
  opsz: { mode: "pin", value: 14 },
  wght: { mode: "range", min: 400, max: 900 },
};

let cacheDir: string;
beforeEach(async () => {
  clearPinnedDeliveryMemo();
  cacheDir = await mkdtemp(join(tmpdir(), "caelo-pinned-delivery-test-"));
});
afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

describe("pinned slice cache", () => {
  it("hashes the spec canonically and distinguishes specs", () => {
    expect(axisSpecHash(DEFAULT)).toMatch(/^[0-9a-f]{12}$/);
    expect(axisSpecHash({ wght: DEFAULT.wght!, opsz: DEFAULT.opsz! })).toBe(axisSpecHash(DEFAULT));
    expect(axisSpecHash(FULL)).not.toBe(axisSpecHash(DEFAULT));
  });

  it("never answers one spec with slices cut for another", async () => {
    expect(await cachedPinnedFaceSlices({ cacheDir, sha256, axisSpec: DEFAULT })).toBeNull();
    const full = await pinnedFaceSlices({ cacheDir, sha256, bytes: inter, axisSpec: FULL });
    // Same source, different spec: no cache hit, new names.
    expect(await cachedPinnedFaceSlices({ cacheDir, sha256, axisSpec: DEFAULT })).toBeNull();
    const reduced = await pinnedFaceSlices({ cacheDir, sha256, bytes: inter, axisSpec: DEFAULT });
    const fullPaths = new Set(full.slices.map((s) => s.relPath));
    for (const slice of reduced.slices) {
      expect(fullPaths.has(slice.relPath)).toBe(false);
      expect(slice.relPath).toContain(`.${axisSpecHash(DEFAULT)}.`);
      expect((await readFile(join(cacheDir, slice.relPath))).length).toBe(slice.bytes);
    }
    // The read-only lookup reports sizes from disk without deriving (fresh process).
    clearPinnedDeliveryMemo();
    expect(await cachedPinnedFaceSlices({ cacheDir, sha256, axisSpec: DEFAULT })).toEqual(reduced);
    const latin = (m: typeof full) => m.slices.find((s) => s.subset === "latin")!.bytes;
    expect(latin(reduced)).toBeLessThan(latin(full));
  });
});
