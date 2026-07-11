// SPDX-License-Identifier: MPL-2.0

/**
 * issue #162 — shared responsive-image enrichment: production shape
 * (src rewritten to _assets) vs preview shape (src kept on the admin
 * media route), author precedence, and the two-entry ladder rule.
 */

import { describe, expect, it } from "bun:test";
import { enrichResponsiveImages, type ImageVariantInfo } from "./responsive-images.js";

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
