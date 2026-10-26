// SPDX-License-Identifier: MPL-2.0

/**
 * The manifest's `requiresPlugins` and `consentPurposes`: what a plugin
 * may declare, and that the one projection (`manifestFromDefinition`)
 * carries both into the signed manifest.
 */

import { describe, expect, it } from "bun:test";
import { manifestFromDefinition, type PluginConsentPurpose, pluginManifest } from "./index.js";

const VISITOR_ID: PluginConsentPurpose = {
  key: "visitor_id",
  category: "functional",
  purpose: "One rating per visitor and page.",
  cookies: [{ name: "caelo_visitor_id", lifetime: "30 days", purpose: "Remembers the rating." }],
};

function manifest(extra: Record<string, unknown>) {
  return pluginManifest.safeParse({
    slug: "ratings-x",
    version: "1.0.0",
    tier: 1,
    schema: {},
    operations: ["submit"],
    ...extra,
  });
}

function messages(r: ReturnType<typeof manifest>): string {
  return r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
}

describe("pluginManifest — requiresPlugins", () => {
  it("accepts plugin slugs", () => {
    expect(manifest({ requiresPlugins: ["consent-manager"] }).success).toBe(true);
  });

  it("refuses a plugin requiring itself, a duplicate and a non-slug", () => {
    expect(messages(manifest({ requiresPlugins: ["ratings-x"] }))).toContain(
      "cannot require itself",
    );
    expect(messages(manifest({ requiresPlugins: ["a", "a"] }))).toContain("required twice");
    expect(manifest({ requiresPlugins: ["Consent Manager"] }).success).toBe(false);
  });
});

describe("pluginManifest — consentPurposes", () => {
  it("accepts the visitor-id purpose naming the gateway cookie", () => {
    expect(manifest({ consentPurposes: [VISITOR_ID] }).success).toBe(true);
  });

  it("accepts functional, analytics and marketing", () => {
    for (const category of ["functional", "analytics", "marketing"]) {
      const r = manifest({
        consentPurposes: [
          {
            key: "embed",
            category,
            purpose: "x",
            cookies: [{ name: "v", lifetime: "1d", purpose: "y" }],
          },
        ],
      });
      expect(r.success).toBe(true);
    }
  });

  it("refuses `necessary`: a declared purpose must be one the visitor can refuse", () => {
    const r = manifest({ consentPurposes: [{ ...VISITOR_ID, category: "necessary" }] });
    expect(messages(r)).toContain("cannot be `necessary`");
  });

  it("refuses an unknown category, an extra field and a bad cookie name", () => {
    expect(manifest({ consentPurposes: [{ ...VISITOR_ID, category: "stats" }] }).success).toBe(
      false,
    );
    expect(manifest({ consentPurposes: [{ ...VISITOR_ID, pluginSlug: "auth" }] }).success).toBe(
      false,
    );
    expect(
      manifest({
        consentPurposes: [
          { ...VISITOR_ID, cookies: [{ name: "a b", lifetime: "1d", purpose: "x" }] },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a purpose declared twice", () => {
    expect(messages(manifest({ consentPurposes: [VISITOR_ID, VISITOR_ID] }))).toContain(
      "declared twice",
    );
  });

  it("keeps caelo_ cookies host-owned", () => {
    const other = {
      key: "session_hint",
      category: "functional",
      purpose: "x",
      cookies: [{ name: "caelo_session", lifetime: "1d", purpose: "x" }],
    };
    expect(messages(manifest({ consentPurposes: [other] }))).toContain("host-owned");
    const borrowed = {
      ...other,
      cookies: [{ name: "caelo_visitor_id", lifetime: "1d", purpose: "x" }],
    };
    expect(messages(manifest({ consentPurposes: [borrowed] }))).toContain("host-owned");
  });

  it("makes the visitor-id purpose name caelo_visitor_id", () => {
    const r = manifest({
      consentPurposes: [
        { ...VISITOR_ID, cookies: [{ name: "my_id", lifetime: "1d", purpose: "x" }] },
      ],
    });
    expect(messages(r)).toContain("list it");
  });
});

describe("manifestFromDefinition", () => {
  it("projects requiresPlugins and consentPurposes into the signed manifest", () => {
    const m = manifestFromDefinition({
      slug: "ratings-x",
      version: "1.0.0",
      tier: 1,
      schema: {},
      operations: { submit: async () => null },
      requiresPlugins: ["consent-manager"],
      consentPurposes: [VISITOR_ID],
    });
    expect(m.requiresPlugins).toEqual(["consent-manager"]);
    expect(m.consentPurposes).toEqual([VISITOR_ID]);
  });

  it("leaves both out when a plugin declares none", () => {
    const m = manifestFromDefinition({
      slug: "plain",
      version: "1.0.0",
      tier: 1,
      schema: {},
      operations: { run: async () => null },
      requiresPlugins: [],
      consentPurposes: [],
    });
    expect("requiresPlugins" in m).toBe(false);
    expect("consentPurposes" in m).toBe(false);
  });
});
