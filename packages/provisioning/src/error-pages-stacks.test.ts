// SPDX-License-Identifier: MPL-2.0

/**
 * #802 — every provider answers an unknown URL with the site's own
 * `/404.html` (written by the static generator from the designated 404
 * page) and status 404. Firebase Hosting does this by convention for a
 * root `/404.html`; the other stacks must wire it. Source-level checks:
 * the Pulumi programs cannot run in a unit test.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stack = (provider: string): string =>
  readFileSync(resolve(import.meta.dir, "..", "stacks", provider, "index.ts"), "utf8");

describe("#802 site 404 page wiring per provider", () => {
  it("gcp: the static bucket's website serves 404.html for unknown objects", () => {
    expect(stack("gcp")).toContain('notFoundPage: "404.html"');
  });

  it("aws: CloudFront maps both 404 and the OAI origin's 403 to /404.html with status 404", () => {
    const src = stack("aws");
    expect(src).toContain(
      '{ errorCode: 404, responseCode: 404, responsePagePath: "/404.html", errorCachingMinTtl: 60 }',
    );
    // S3 behind an OAI without s3:ListBucket answers a missing key with
    // 403 — without this entry visitors get S3's AccessDenied XML.
    expect(src).toContain(
      '{ errorCode: 403, responseCode: 404, responsePagePath: "/404.html", errorCachingMinTtl: 60 }',
    );
  });

  it("azure: the static website's error document is 404.html", () => {
    expect(stack("azure")).toContain('error404Document: "404.html"');
  });
});
