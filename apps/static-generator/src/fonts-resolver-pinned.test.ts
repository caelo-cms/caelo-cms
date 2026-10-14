// SPDX-License-Identifier: MPL-2.0

/**
 * Pinned (font registry) faces through the shared resolver, with the
 * registry read stubbed: what a build ships for an acquired Google TTF.
 * The registry original must never reach the delivery tree — only WOFF2
 * unicode-range slices derived from it.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FontMetadata, type FontRef, inspectFontBytes } from "@caelo-cms/font-service";
import type { ThemeDocument } from "@caelo-cms/shared";
import fontverter from "fontverter";
import { clearFontResolverMemo, resolveThemeFonts } from "./fonts-resolver.js";
import { clearPinnedDeliveryMemo } from "./pinned-font-delivery.js";

const FIXTURES = new URL("../../../packages/font-service/src/fixtures/", import.meta.url);
const license = {
  name: "OFL-1.1",
  text: readFileSync(new URL("Inter-OFL.txt", FIXTURES), "utf8"),
  webEmbedding: true,
  documentEmbedding: true,
};
/** What `acquire_font` stores for a Google family: the complete TTF. */
const interTtf = new Uint8Array(
  await fontverter.convert(
    Buffer.from(
      readFileSync(new URL("InterVariable-mini.woff2.base64.txt", FIXTURES), "utf8").trim(),
      "base64",
    ),
    "sfnt",
  ),
);

function registryFace(bytes: Uint8Array): { ref: FontRef; metadata: FontMetadata } {
  const inspected = inspectFontBytes(bytes, license);
  const ref = { id: "0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f", sha256: inspected.sha256 };
  return {
    ref,
    metadata: {
      ...inspected,
      ...ref,
      license,
      source: "test",
      createdAt: "2026-10-14T00:00:00.000Z",
    },
  };
}

function pinnedTokens(ref: FontRef, cssFamily: string): ThemeDocument {
  return {
    typography: {
      body: {
        $type: "typography",
        $value: { fontFamily: cssFamily, fontWeight: 400 },
        $extensions: { "caelo.font": ref },
      },
    },
  } as unknown as ThemeDocument;
}

let cacheDir: string;
beforeEach(async () => {
  clearFontResolverMemo();
  clearPinnedDeliveryMemo();
  cacheDir = await mkdtemp(join(tmpdir(), "caelo-pinned-fonts-test-"));
});
afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

async function resolve(
  bytes: Uint8Array,
  preloadLanguage: string | null,
  face = registryFace(bytes),
) {
  return resolveThemeFonts({
    tokens: pinnedTokens(face.ref, face.metadata.cssFamily),
    cacheDir,
    publicBasePath: "/_assets/fonts",
    preloadLanguage,
    readFont: async () => ({ metadata: face.metadata, bytes }),
    fetcher: (() => {
      throw new Error("pinned faces never touch the network");
    }) as typeof fetch,
  });
}

describe("resolveThemeFonts — pinned registry faces", () => {
  it("ships WOFF2 unicode-range slices, never the registry TTF", async () => {
    const res = await resolve(interTtf, "de");
    expect(res.unresolved).toEqual([]);

    expect(res.css).not.toContain("truetype");
    expect(res.css).not.toMatch(/\.ttf/);
    const rules = res.css.split("\n").filter((r) => r.startsWith("@font-face"));
    expect(rules).toHaveLength(6); // other, cyrillic, greek, vietnamese, latin-ext, latin
    for (const rule of rules) {
      expect(rule).toContain('format("woff2")');
      expect(rule).toContain("font-weight:100 900"); // variable wght range survives
      expect(rule).toMatch(/unicode-range:U\+[0-9A-F]{4}/);
    }
    expect(rules.at(-1)).toContain("unicode-range:U+0000-00FF");

    const sourceHex = Buffer.from(interTtf).toString("hex");
    for (const file of res.files) {
      expect(file.relPath).not.toMatch(/\.(ttf|otf|woff)$/);
      if (file.relPath.endsWith(".license.txt")) continue;
      expect(file.relPath).toMatch(/^pinned\/[0-9a-f]{64}\.[a-z-]+\.[0-9a-f]{12}\.woff2$/);
      const bytes = await readFile(file.cachePath);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");
      expect(bytes.toString("hex")).not.toBe(sourceHex);
    }
    // Nothing in the delivery cache is a copy of the source either.
    for (const name of await readdir(join(cacheDir, "pinned"))) {
      expect(name).not.toMatch(/\.(ttf|otf)$/);
    }
  });

  it("preloads only the slice for the site language's script", async () => {
    const urlFor = async (lang: string | null) => (await resolve(interTtf, lang)).preloads;
    expect(await urlFor("de")).toEqual([expect.stringMatching(/\.latin\.[0-9a-f]{12}\.woff2$/)]);
    expect(await urlFor("vi")).toEqual([expect.stringMatching(/\.latin\.[0-9a-f]{12}\.woff2$/)]);
    expect(await urlFor("ru")).toEqual([expect.stringMatching(/\.cyrillic\.[0-9a-f]{12}\.woff2$/)]);
    expect(await urlFor("el")).toEqual([expect.stringMatching(/\.greek\.[0-9a-f]{12}\.woff2$/)]);
    expect(await urlFor("ja")).toEqual([]); // no slice for the script → no guess
    expect(await urlFor(null)).toEqual([]);
  });

  it("reuses cached slices across builds (keyed by source sha + toolchain)", async () => {
    const first = await resolve(interTtf, "en");
    const slice = first.files.find((f) => /\.latin\.[0-9a-f]{12}\.woff2$/.test(f.relPath));
    expect(slice).toBeDefined();
    const before = await stat(slice!.cachePath);
    clearPinnedDeliveryMemo(); // a fresh build process
    const second = await resolve(interTtf, "en");
    expect(second.files).toEqual(first.files);
    expect(second.css).toBe(first.css);
    expect((await stat(slice!.cachePath)).mtimeMs).toBe(before.mtimeMs); // not re-derived
  });

  it("reports a face that cannot be transcoded as unresolved and ships nothing for it", async () => {
    const broken = new Uint8Array(interTtf);
    // Corrupt `maxp` so harfbuzz refuses the face (the registry sha still matches
    // the bytes the stub hands back, so this is the transcoding step failing).
    const view = Buffer.from(broken.buffer);
    for (let i = 0; i < view.readUInt16BE(4); i++) {
      const entry = 12 + 16 * i;
      if (view.toString("ascii", entry, entry + 4) !== "maxp") continue;
      const offset = view.readUInt32BE(entry + 8);
      view.fill(0xff, offset, offset + view.readUInt32BE(entry + 12));
    }
    const face = registryFace(interTtf);
    const sha256 = createHash("sha256").update(broken).digest("hex");
    const res = await resolve(broken, "en", {
      ref: { ...face.ref, sha256 },
      metadata: { ...face.metadata, sha256 },
    });
    expect(res.unresolved).toEqual([
      expect.stringMatching(/^pinned:body:FontDeliveryFailed:[a-z-]+:TranscodeFailed:/),
    ]);
    expect(res.css).toBe("");
    expect(res.files).toEqual([]);
    expect(res.preloads).toEqual([]);
  });
});
