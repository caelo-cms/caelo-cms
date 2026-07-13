// SPDX-License-Identifier: MPL-2.0

/**
 * issue #162 — shared responsive-image enrichment: production shape
 * (src rewritten to _assets) vs preview shape (src kept on the admin
 * media route), author precedence, and the two-entry ladder rule.
 */

import { describe, expect, it } from "bun:test";
import {
  enrichResponsiveImages,
  type ImageVariantInfo,
  pickAiImageVariant,
} from "./responsive-images.js";

const ASSET = "12345678-1234-4123-8123-123456789abc";
const VARIANTS: ImageVariantInfo[] = [
  { variant: "webp-400", format: "webp" },
  { variant: "webp-800", format: "webp" },
  { variant: "webp-1200", format: "webp" },
  { variant: "orig", format: "jpeg" },
];
const byAsset = new Map([[ASSET, VARIANTS]]);
const IMG = `<img src="/_caelo/media/${ASSET}/webp-800" alt="Team">`;

describe("enrichResponsiveImages (issue #162)", () => {
  it("production mode rewrites src and builds the _assets ladder", () => {
    const out = enrichResponsiveImages(IMG, byAsset, {
      rewriteSrc: true,
      urlFor: (id, v, f) => `/_assets/${id}/${v}.${f === "webp" ? "webp" : "jpg"}`,
    });
    expect(out).toContain(`src="/_assets/${ASSET}/webp-800.webp"`);
    expect(out).toContain(`/_assets/${ASSET}/webp-400.webp 400w`);
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
    expect(out).toContain('alt="Team"');
  });

  it("preview mode keeps the admin src but emits the SAME attribute shape", () => {
    const out = enrichResponsiveImages(IMG, byAsset, {
      rewriteSrc: false,
      urlFor: (id, v) => `/_caelo/media/${id}/${v}`,
    });
    expect(out).toContain(`src="/_caelo/media/${ASSET}/webp-800"`);
    expect(out).toContain(`/_caelo/media/${ASSET}/webp-400 400w`);
    expect(out).toContain(`sizes="(max-width: 600px) 400px, (max-width: 1200px) 800px, 800px"`);
    expect(out).toContain('loading="lazy"');
  });

  it("author-supplied attributes keep precedence", () => {
    const authored = `<img loading="eager" srcset="x 1w" src="/_caelo/media/${ASSET}/webp-800">`;
    const out = enrichResponsiveImages(authored, byAsset, {
      rewriteSrc: false,
      urlFor: (id, v) => `/_caelo/media/${id}/${v}`,
    });
    expect(out).toContain('loading="eager"');
    expect(out).toContain('srcset="x 1w"');
    expect(out.match(/srcset=/g)).toHaveLength(1);
  });

  it("skips srcset for sub-two-entry ladders and non-media images", () => {
    const single = new Map([[ASSET, [{ variant: "webp-800", format: "webp" }]]]);
    const out = enrichResponsiveImages(IMG, single, {
      rewriteSrc: false,
      urlFor: (id, v) => `/_caelo/media/${id}/${v}`,
    });
    expect(out).not.toContain("srcset=");
    const external = '<img src="https://example.com/x.png">';
    expect(
      enrichResponsiveImages(external, byAsset, {
        rewriteSrc: false,
        urlFor: (id, v) => `/${id}/${v}`,
      }),
    ).toBe(external);
  });
});

/**
 * Run #10 D4 — AI-facing surfaces must advertise a variant that EXISTS.
 * The pipeline never emits webp-800 for sub-800px sources or animated
 * GIFs; advertising it anyway blocked the whole staging build.
 */
describe("pickAiImageVariant", () => {
  it("prefers webp-800 when present", () => {
    expect(pickAiImageVariant(["orig", "webp-400", "webp-800", "webp-1200"])).toBe("webp-800");
  });

  it("falls back to the largest webp below 800 (small source, no upscaling)", () => {
    expect(pickAiImageVariant(["orig", "webp-400"])).toBe("webp-400");
  });

  it("falls back to the smallest webp above 800 when nothing smaller exists", () => {
    expect(pickAiImageVariant(["orig", "webp-1200", "webp-1600"])).toBe("webp-1200");
  });

  it("returns orig when no webp exists (animated GIF, SVG, PDF, pipeline gap)", () => {
    expect(pickAiImageVariant(["orig"])).toBe("orig");
    expect(pickAiImageVariant([])).toBe("orig");
  });

  it("ignores crop-family variants when picking", () => {
    expect(pickAiImageVariant(["orig", "square-800", "webp-400"])).toBe("webp-400");
  });
});
