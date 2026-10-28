// SPDX-License-Identifier: MPL-2.0

/**
 * Pinned (font registry) faces through the shared resolver, with the
 * registry read stubbed: what a build ships for an acquired Google TTF.
 * The registry original must never reach the delivery tree — only WOFF2
 * unicode-range slices derived from it, instanced to the face's axis
 * policy (default or operator override).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FontMetadata,
  type FontRef,
  inspectFontBytes,
  openFont,
} from "@caelo-cms/font-service";
import {
  isContentHashedPath,
  isPinnedFontSliceFile,
  type SiteFontUsage,
  scanSiteFontUsage,
  type ThemeDocument,
} from "@caelo-cms/shared";
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

function pinnedTokens(
  ref: FontRef,
  cssFamily: string,
  roles: Record<string, { weight: number; axes?: unknown }> = { body: { weight: 400 } },
): ThemeDocument {
  return {
    typography: Object.fromEntries(
      Object.entries(roles).map(([role, { weight, axes }]) => [
        role,
        {
          $type: "typography",
          $value: { fontFamily: cssFamily, fontWeight: weight },
          $extensions: {
            "caelo.font": ref,
            ...(axes === undefined ? {} : { "caelo.fontAxes": axes }),
          },
        },
      ]),
    ),
  } as unknown as ThemeDocument;
}

function axesOfFile(path: string): Promise<Record<string, { min: number; max: number }>> {
  return readFile(path).then(
    (bytes) =>
      (
        openFont(bytes).font as unknown as {
          variationAxes: Record<string, { min: number; max: number }>;
        }
      ).variationAxes,
  );
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

/** The scan of a site with nothing but the theme: weights 400/700/900. */
function themeOnlyUsage(tokens: ThemeDocument): SiteFontUsage {
  return scanSiteFontUsage({ tokens, sources: [] });
}

async function resolve(
  bytes: Uint8Array,
  preloadLanguage: string | null,
  face = registryFace(bytes),
  options: {
    roles?: Parameters<typeof pinnedTokens>[2];
    usage?: (tokens: ThemeDocument) => SiteFontUsage;
  } = {},
) {
  const tokens = pinnedTokens(face.ref, face.metadata.cssFamily, options.roles);
  return resolveThemeFonts({
    tokens,
    loadFontUsage: async () => (options.usage ?? themeOnlyUsage)(tokens),
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
      // Default policy: wght clamped to the weights in use (400, UA 700,
      // bolder → 900); the descriptor matches the delivered file.
      expect(rule).toContain("font-weight:400 900");
      expect(rule).toMatch(/unicode-range:U\+[0-9A-F]{4}/);
    }
    expect(rules.at(-1)).toContain("unicode-range:U+0000-00FF");

    const sourceHex = Buffer.from(interTtf).toString("hex");
    for (const file of res.files) {
      expect(file.relPath).not.toMatch(/\.(ttf|otf|woff)$/);
      if (file.relPath.endsWith(".license.txt")) continue;
      expect(file.relPath).toMatch(
        /^pinned\/[0-9a-f]{64}\.[0-9a-f]{12}\.[a-z-]+\.[0-9a-f]{12}\.woff2$/,
      );
      // The emitted name must satisfy both consumers of the shared shape:
      // the admin's preview font route (/_caelo/fonts/pinned/<file>) and
      // the published site's immutable cache policy. #793 changed the name
      // without them and every pinned font 404'd in the editor preview
      // (e2e-livedit run 38915969785).
      expect(isPinnedFontSliceFile(file.relPath.slice("pinned/".length))).toBe(true);
      expect(isContentHashedPath(`_assets/fonts/${file.relPath}`)).toBe(true);
      const bytes = await readFile(file.cachePath);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");
      expect(bytes.toString("hex")).not.toBe(sourceHex);
      // opsz pinned to its default (14) → gone; wght clamped.
      expect(await axesOfFile(file.cachePath)).toEqual({
        wght: expect.objectContaining({ min: 400, max: 900 }),
      });
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

  it("reuses cached slices across builds (keyed by source sha + axis spec + toolchain)", async () => {
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

  it("an operator override replaces the default per axis and moves to new cache names", async () => {
    const byDefault = await resolve(interTtf, "en");
    const keepOpsz = await resolve(interTtf, "en", registryFace(interTtf), {
      roles: { body: { weight: 400, axes: { opsz: "full" } } },
    });
    expect(keepOpsz.unresolved).toEqual([]);
    // wght still follows the default; opsz is kept.
    expect(keepOpsz.css).toContain("font-weight:400 900");
    const latin = keepOpsz.files.find((f) => /\.latin\./.test(f.relPath))!;
    expect(await axesOfFile(latin.cachePath)).toEqual({
      opsz: expect.objectContaining({ min: 14, max: 32 }),
      wght: expect.objectContaining({ min: 400, max: 900 }),
    });
    // A policy change can never be answered with the old slices.
    const slices = (r: typeof byDefault) =>
      r.files.map((f) => f.relPath).filter((p) => p.endsWith(".woff2"));
    for (const path of slices(keepOpsz)) expect(slices(byDefault)).not.toContain(path);

    const pinnedWeight = await resolve(interTtf, "en", registryFace(interTtf), {
      roles: { body: { weight: 500, axes: { wght: 500 } } },
    });
    expect(pinnedWeight.unresolved).toEqual([]);
    expect(pinnedWeight.css).toContain("font-weight:500;");
  });

  it("keeps the full wght range when the site's weight usage is not determinable", async () => {
    const res = await resolve(interTtf, "en", registryFace(interTtf), {
      usage: (tokens) =>
        scanSiteFontUsage({
          tokens,
          // --w is never declared in CSS but set from script: not knowable.
          sources: [
            {
              label: "module:hero",
              text: '.x{font-weight:var(--w)}\nel.style.setProperty("--w", weight);',
            },
          ],
        }),
    });
    expect(res.unresolved).toEqual([]);
    expect(res.css).toContain("font-weight:100 900");
  });

  it("widens the default to a weight a module uses", async () => {
    const res = await resolve(interTtf, "en", registryFace(interTtf), {
      usage: (tokens) =>
        scanSiteFontUsage({
          tokens,
          sources: [{ label: "module:x", text: ".t{font-weight:200}" }],
        }),
    });
    expect(res.css).toContain("font-weight:200 900");
  });

  it("fails loudly when an override excludes a weight a bound role uses", async () => {
    const res = await resolve(interTtf, "en", registryFace(interTtf), {
      roles: { body: { weight: 800, axes: { wght: { min: 400, max: 700 } } } },
    });
    expect(res.unresolved).toEqual(["pinned:body:FontWeightOutsideDelivery:800 not in 400-700"]);
    expect(res.css).toBe("");
  });

  it("fails loudly on conflicting or invalid overrides for one face", async () => {
    const conflict = await resolve(interTtf, "en", registryFace(interTtf), {
      roles: {
        body: { weight: 400, axes: { opsz: "full" } },
        heading: { weight: 700 },
      },
    });
    expect(conflict.unresolved).toEqual([
      expect.stringMatching(/^pinned:body:FontAxisPolicyInvalid: roles body, heading/),
      expect.stringMatching(/^pinned:heading:FontAxisPolicyInvalid: roles body, heading/),
    ]);
    const unknownAxis = await resolve(interTtf, "en", registryFace(interTtf), {
      roles: { body: { weight: 400, axes: { wdth: 100 } } },
    });
    expect(unknownAxis.unresolved).toEqual([
      expect.stringMatching(/^pinned:body:FontAxisPolicyInvalid: this face has no 'wdth' axis/),
    ]);
  });

  it("scans usage once per resolve, however many roles bind variable faces", async () => {
    let scans = 0;
    const res = await resolve(interTtf, "en", registryFace(interTtf), {
      roles: { body: { weight: 400 }, heading: { weight: 700 } },
      usage: (tokens) => {
        scans++;
        return themeOnlyUsage(tokens);
      },
    });
    expect(res.unresolved).toEqual([]);
    expect(scans).toBe(1);
  });

  // #803 — the resolver read a face once per typography ROLE; four roles on
  // one face meant four full registry reads per preview.
  it("reads each bound face once per resolve, however many roles bind it", async () => {
    const face = registryFace(interTtf);
    const tokens = pinnedTokens(face.ref, face.metadata.cssFamily, {
      body: { weight: 400 },
      heading: { weight: 700 },
      display: { weight: 800 },
      mono: { weight: 400 },
    });
    const reads: FontRef[] = [];
    const res = await resolveThemeFonts({
      tokens,
      loadFontUsage: async () => themeOnlyUsage(tokens),
      cacheDir,
      publicBasePath: "/_assets/fonts",
      preloadLanguage: "en",
      readFont: async (ref) => {
        reads.push(ref);
        return { metadata: face.metadata, bytes: interTtf };
      },
    });
    expect(res.unresolved).toEqual([]);
    expect(reads).toEqual([face.ref]);
  });

  it("fails every role of a face whose bytes do not match the pin, still reading it once", async () => {
    const face = registryFace(interTtf);
    const tokens = pinnedTokens(face.ref, face.metadata.cssFamily, {
      body: { weight: 400 },
      heading: { weight: 700 },
    });
    let reads = 0;
    const res = await resolveThemeFonts({
      tokens,
      loadFontUsage: async () => themeOnlyUsage(tokens),
      cacheDir,
      publicBasePath: "/_assets/fonts",
      preloadLanguage: "en",
      readFont: async () => {
        reads++;
        return { metadata: face.metadata, bytes: interTtf.slice(1) };
      },
    });
    expect(reads).toBe(1);
    expect(res.unresolved).toEqual([
      "pinned:body:FontBindingMismatch",
      "pinned:heading:FontBindingMismatch",
    ]);
    expect(res.css).toBe("");
  });
});
