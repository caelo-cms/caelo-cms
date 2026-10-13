// SPDX-License-Identifier: MPL-2.0

/**
 * Edge-router byte-identity tests. These assert a fixed corpus of
 * (visitorId, manifestVersion, experimentId) → (bucket, variantLabel)
 * tuples. The numbers in this file are the ground truth; if you change
 * the assignment algorithm, you change the contract for ALL FOUR
 * runtime implementations (self-hosted P13 + GCP + AWS + Azure) and
 * silently re-bucket every existing visitor's variant assignment. Don't
 * change without bumping the manifestVersion in the same commit.
 */

import { describe, expect, it } from "bun:test";
import { assignVariant, buildAssignmentLog, fnv1a32, mintVisitorId } from "./assignment.js";
import { consentGranted, readCookie } from "./consent.js";
import { findExperimentForUrl, validateManifest } from "./manifest.js";
import { routeRequest } from "./router.js";

describe("fnv1a32", () => {
  it("matches the published FNV-1a-32 reference for a fixed corpus", () => {
    // Reference values produced via the canonical algorithm —
    // independent reimplementations against this list will catch
    // off-by-one + signed-vs-unsigned bugs.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("is stable for identical input", () => {
    const a = fnv1a32("visitor-12345:exp-abc:v3");
    const b = fnv1a32("visitor-12345:exp-abc:v3");
    expect(a).toBe(b);
  });
});

describe("assignVariant", () => {
  const experiment = {
    pageSlug: "/home",
    experimentId: "11111111-2222-3333-4444-555555555555",
    variants: [
      { label: "A", weight: 50, path: "/home" },
      {
        label: "B",
        weight: 50,
        path: "/_caelo-variant/11111111-2222-3333-4444-555555555555/B/home",
      },
    ],
  } as const;

  it("returns the same variant for the same (visitorId, manifestVersion, experimentId)", () => {
    const a = assignVariant({
      visitorId: "v-stable-1",
      manifestVersion: "7",
      experiment,
    });
    const b = assignVariant({
      visitorId: "v-stable-1",
      manifestVersion: "7",
      experiment,
    });
    expect(a.label).toBe(b.label);
  });

  it("re-buckets when manifestVersion bumps (operator-triggered re-randomization)", () => {
    // The whole point of bumping manifestVersion is to roll the dice
    // afresh; for at least ONE visitor in 100, the assignment should
    // differ between v=1 and v=2. Assert across a small population.
    let differs = 0;
    for (let i = 0; i < 100; i += 1) {
      const v1 = assignVariant({
        visitorId: `vis-${i}`,
        manifestVersion: "1",
        experiment,
      });
      const v2 = assignVariant({
        visitorId: `vis-${i}`,
        manifestVersion: "2",
        experiment,
      });
      if (v1.label !== v2.label) differs += 1;
    }
    expect(differs).toBeGreaterThan(20);
  });

  it("respects bucket weights — 70/30 split lands within ±10pp over 1000 visitors", () => {
    const skewed = {
      pageSlug: "/pricing",
      experimentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      variants: [
        { label: "A", weight: 70, path: "/pricing" },
        {
          label: "B",
          weight: 30,
          path: "/_caelo-variant/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/B/pricing",
        },
      ],
    } as const;
    let aCount = 0;
    for (let i = 0; i < 1000; i += 1) {
      const v = assignVariant({
        visitorId: `vis-${i}`,
        manifestVersion: "1",
        experiment: skewed,
      });
      if (v.label === "A") aCount += 1;
    }
    expect(aCount).toBeGreaterThan(600);
    expect(aCount).toBeLessThan(800);
  });

  it("byte-identity corpus — these exact assignments must hold across all runtimes", () => {
    // If this test starts failing because someone "improved" the hash,
    // STOP. Every runtime's edge router (self-hosted Caddy gateway,
    // GCP Cloud Run, AWS L@E, Azure Front Door) consumes this same
    // contract. Change here = silent re-bucketing of every live
    // experiment.
    const corpus = [
      { visitorId: "v-aaaaaaaa", manifestVersion: "1", expectedLabel: "A" },
      { visitorId: "v-bbbbbbbb", manifestVersion: "1", expectedLabel: "A" },
      { visitorId: "v-cccccccc", manifestVersion: "1", expectedLabel: "B" },
      { visitorId: "v-dddddddd", manifestVersion: "1", expectedLabel: "A" },
      { visitorId: "v-eeeeeeee", manifestVersion: "1", expectedLabel: "B" },
    ];
    for (const tc of corpus) {
      const v = assignVariant({
        visitorId: tc.visitorId,
        manifestVersion: tc.manifestVersion,
        experiment,
      });
      expect(v.label).toBe(tc.expectedLabel);
    }
  });
});

describe("validateManifest", () => {
  const baseExperiment = {
    pageSlug: "/p",
    experimentId: "22222222-3333-4444-5555-666666666666",
    variants: [
      { label: "A", weight: 50, path: "/p" },
      { label: "B", weight: 50, path: "/_caelo-variant/22222222-3333-4444-5555-666666666666/B/p" },
    ],
  } as const;
  const consent = { cookie: "caelo_consent", policyVersion: 1, category: "analytics" };

  it("accepts a clean manifest", () => {
    expect(
      validateManifest({ manifestVersion: "1", experiments: [baseExperiment], consent }),
    ).toBeNull();
  });

  it("rejects experiments without a consent rule (#674)", () => {
    expect(validateManifest({ manifestVersion: "1", experiments: [baseExperiment] })).toContain(
      "no consent rule",
    );
    // No experiments, nothing to gate.
    expect(validateManifest({ manifestVersion: "1", experiments: [] })).toBeNull();
  });

  it("rejects non-UUID experimentId", () => {
    const bad = { ...baseExperiment, experimentId: "not-a-uuid" };
    expect(validateManifest({ manifestVersion: "1", experiments: [bad], consent })).toContain(
      "not a UUID",
    );
  });

  it("rejects weights that don't sum to 100", () => {
    const bad = {
      ...baseExperiment,
      variants: [
        { label: "A", weight: 60, path: "/p" },
        { label: "B", weight: 30, path: "/p-b" },
      ],
    };
    expect(validateManifest({ manifestVersion: "1", experiments: [bad], consent })).toContain(
      "sum to 90",
    );
  });
});

describe("routeRequest", () => {
  const gate = { cookie: "caelo_consent", policyVersion: 2, category: "analytics" };
  const manifest = {
    manifestVersion: "1",
    consent: gate,
    experiments: [
      {
        pageSlug: "/home",
        experimentId: "33333333-4444-5555-6666-777777777777",
        variants: [
          { label: "A", weight: 50, path: "/home" },
          {
            label: "B",
            weight: 50,
            path: "/_caelo-variant/33333333-4444-5555-6666-777777777777/B/home",
          },
        ],
      },
    ],
  };
  const granted = JSON.stringify({ granted: ["necessary", "analytics"], policyVersion: 2 });
  const declined = JSON.stringify({ granted: ["necessary"], policyVersion: 2 });

  it("passes through a request outside any experiment without touching the cookie", () => {
    for (const consentCookie of [granted, null]) {
      const out = routeRequest(manifest, {
        pathname: "/about",
        visitorIdCookie: "v-1",
        consentCookie,
      });
      expect(out.rewritePathname).toBe("/about");
      // #674 — no cookie on every request: only a bucketed request sets one.
      expect(out.setVisitorId).toBeNull();
      expect(out.clearVisitorId).toBe(false);
      expect(out.logEntry).toBeNull();
    }
  });

  it("rewrites + emits log when a consenting visitor requests the page", () => {
    const out = routeRequest(manifest, {
      pathname: "/home",
      visitorIdCookie: "v-aaaaaaaa",
      consentCookie: granted,
    });
    expect(["/home", "/_caelo-variant/33333333-4444-5555-6666-777777777777/B/home"]).toContain(
      out.rewritePathname,
    );
    expect(out.setVisitorId).toBe("v-aaaaaaaa");
    expect(out.logEntry?.kind).toBe("ab_assignment");
    expect(out.logEntry?.experimentId).toBe("33333333-4444-5555-6666-777777777777");
  });

  it("mints a visitor id for a consenting visitor without one", () => {
    const out = routeRequest(manifest, {
      pathname: "/home",
      visitorIdCookie: null,
      consentCookie: granted,
    });
    expect(out.setVisitorId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("serves control, mints nothing and logs nothing without consent (#674)", () => {
    for (const consentCookie of [null, declined, "not json"]) {
      const out = routeRequest(manifest, {
        pathname: "/home",
        visitorIdCookie: null,
        consentCookie,
      });
      expect(out).toEqual({
        rewritePathname: "/home",
        setVisitorId: null,
        clearVisitorId: false,
        logEntry: null,
      });
    }
  });

  it("tells the runtime to drop the id of a visitor who withdrew consent", () => {
    const out = routeRequest(manifest, {
      pathname: "/home",
      visitorIdCookie: "v-aaaaaaaa",
      consentCookie: declined,
    });
    expect(out.rewritePathname).toBe("/home");
    expect(out.setVisitorId).toBeNull();
    expect(out.clearVisitorId).toBe(true);
    expect(out.logEntry).toBeNull();
  });

  it("serves control when the manifest carries no consent rule", () => {
    const { consent: _drop, ...ungated } = manifest;
    const out = routeRequest(ungated, {
      pathname: "/home",
      visitorIdCookie: null,
      consentCookie: granted,
    });
    expect(out.rewritePathname).toBe("/home");
    expect(out.setVisitorId).toBeNull();
    expect(out.logEntry).toBeNull();
  });
});

describe("consentGranted (#674)", () => {
  const gate = { cookie: "caelo_consent", policyVersion: 3, category: "analytics" };

  it("grants only the gate's category under the current policy", () => {
    expect(consentGranted(gate, JSON.stringify({ granted: ["analytics"], policyVersion: 3 }))).toBe(
      true,
    );
    expect(consentGranted(gate, JSON.stringify({ granted: ["marketing"], policyVersion: 3 }))).toBe(
      false,
    );
  });

  it("treats a stale policy version as no decision", () => {
    expect(consentGranted(gate, JSON.stringify({ granted: ["analytics"], policyVersion: 2 }))).toBe(
      false,
    );
  });

  it("treats a missing or unreadable cookie as no consent", () => {
    expect(consentGranted(gate, null)).toBe(false);
    expect(consentGranted(gate, "")).toBe(false);
    expect(consentGranted(gate, "{")).toBe(false);
    expect(consentGranted(gate, "null")).toBe(false);
    expect(consentGranted(gate, JSON.stringify({ granted: "analytics", policyVersion: 3 }))).toBe(
      false,
    );
  });

  it("reads the consent cookie the runtime writes from a Cookie header", () => {
    const value = encodeURIComponent(
      JSON.stringify({ granted: ["necessary", "analytics"], policyVersion: 3, at: "x" }),
    );
    const header = `a=1; caelo_consent=${value}; b=2`;
    expect(consentGranted(gate, readCookie(header, "caelo_consent"))).toBe(true);
    expect(readCookie(header, "missing")).toBeNull();
    expect(readCookie("caelo_consent=%E0%A4%A", "caelo_consent")).toBeNull();
    expect(readCookie(null, "caelo_consent")).toBeNull();
  });
});

describe("findExperimentForUrl", () => {
  it("finds by exact pageSlug match", () => {
    const m = {
      manifestVersion: "1",
      experiments: [
        {
          pageSlug: "/home",
          experimentId: "44444444-5555-6666-7777-888888888888",
          variants: [{ label: "A", weight: 100, path: "/home" }],
        },
      ],
    };
    expect(findExperimentForUrl(m, "/home")?.experimentId).toBe(
      "44444444-5555-6666-7777-888888888888",
    );
    expect(findExperimentForUrl(m, "/about")).toBeNull();
  });
});

describe("buildAssignmentLog", () => {
  it("produces the canonical log shape", () => {
    const entry = buildAssignmentLog({
      experimentId: "55555555-6666-7777-8888-999999999999",
      variant: { label: "B", weight: 50, path: "/x" },
      visitorId: "v-1",
      manifestVersion: "3",
      nowMs: 1700000000000,
    });
    expect(entry).toEqual({
      kind: "ab_assignment",
      experimentId: "55555555-6666-7777-8888-999999999999",
      variantLabel: "B",
      visitorId: "v-1",
      manifestVersion: "3",
      tsMs: 1700000000000,
    });
  });
});

describe("mintVisitorId", () => {
  it("returns 32 hex chars", () => {
    expect(mintVisitorId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("each call is unique", () => {
    expect(mintVisitorId()).not.toBe(mintVisitorId());
  });
});
