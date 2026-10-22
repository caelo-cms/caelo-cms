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

describe("consent runtime in an opaque-origin sandbox (#946)", () => {
  it("starts and records a decision although document.cookie throws", () => {
    // The editor previews pages sandboxed WITHOUT allow-same-origin, where
    // reading or writing document.cookie throws a SecurityError. The banner
    // must still ask, and a decision must still reach the server.
    const js = buildRuntimeJs(
      {
        slug: "consent-manager",
        categories: [{ key: "marketing", displayName: "Marketing", required: false }],
        policyVersion: 1,
        recordEndpoint: "/api/plugin/consent-manager/record_consent",
      },
      buildTagInjector([]),
    );
    const classes = new Set<string>();
    const doc = {
      readyState: "complete",
      documentElement: {
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      },
      get cookie(): string {
        throw new Error("SecurityError: sandboxed");
      },
      set cookie(_v: string) {
        throw new Error("SecurityError: sandboxed");
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
    };
    const beacons: string[] = [];
    const win: {
      caeloConsent?: { grantAll: () => void; isGranted: (key: string) => boolean };
    } = {};
    new Function("document", "window", "navigator", "console", "location", js)(
      doc,
      win,
      { sendBeacon: (url: string) => beacons.push(url) },
      { warn: () => undefined },
      { protocol: "https:", reload: () => undefined },
    );
    expect(classes.has("caelo-consent-ask")).toBe(true);
    expect(win.caeloConsent?.isGranted("marketing")).toBe(false);
    win.caeloConsent?.grantAll();
    expect(beacons).toEqual(["/api/plugin/consent-manager/record_consent"]);
    expect(classes.has("caelo-consent-ask")).toBe(false);
    // The decision holds for the document's lifetime, so the operator sees
    // the accepted state (PR #957 review).
    expect(win.caeloConsent?.isGranted("marketing")).toBe(true);
  });
});
