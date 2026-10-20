// SPDX-License-Identifier: MPL-2.0

/**
 * The runtime is inlined into every page as one <script>. Its own source
 * must therefore never spell a closing script tag or an HTML comment
 * opener: the preview would have to ship it base64-encoded (#866), and a
 * page that embeds it verbatim would end the element early.
 */

import { describe, expect, it } from "bun:test";
import { buildRuntimeJs } from "./runtime.js";
import { buildTagInjector } from "./tags.js";

describe("consent runtime source", () => {
  it("contains nothing that could end its inline <script>", () => {
    const js = buildRuntimeJs(
      {
        slug: "consent-manager",
        categories: [{ key: "marketing", displayName: "Marketing", required: false }],
        policyVersion: 1,
        recordEndpoint: "/api/plugin/consent-manager/record_consent",
      },
      buildTagInjector([]),
    );
    expect(js).toContain("/api/plugin/consent-manager/record_consent");
    expect(/<\/script|<!--/i.test(js)).toBe(false);
  });
});
