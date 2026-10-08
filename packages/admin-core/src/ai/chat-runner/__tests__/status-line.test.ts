// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 — the `[Site status]` line (kept from the prompt-diet A/B).
 * It rides on the user message ONLY while base setup is missing; a
 * complete foundation must yield `undefined` so steady-state turns
 * carry zero status overhead. Each gap names the tool that fixes it.
 */

import { describe, expect, it } from "bun:test";
import { buildStatusLine } from "../context-blocks.js";

const COMPLETE = {
  layoutsValue: { layouts: [{ id: "l1" }] },
  templatesValue: { templates: [{ id: "t1" }] },
  siteDefaultsValue: { defaults: { siteName: "Acme" } },
  activeTheme: { origin: "ai" },
};

describe("buildStatusLine", () => {
  it("returns undefined when the foundation is complete", () => {
    expect(buildStatusLine(COMPLETE)).toBeUndefined();
  });

  it("lists every missing base item on a truly empty site, naming the fixing tool", () => {
    const line = buildStatusLine({
      layoutsValue: { layouts: [] },
      templatesValue: { templates: [] },
      siteDefaultsValue: { defaults: null },
      activeTheme: null,
    });
    expect(line).toBeDefined();
    expect(line).toStartWith("[Site status — base setup still missing]");
    expect(line).toContain("Layout: needs setup (create_layout)");
    expect(line).toContain("Template: needs setup (create_template)");
    expect(line).toContain("Site defaults: needs setup (set_site_defaults)");
    expect(line).toContain("Theme: needs setup");
  });

  it("flags missing site identity when defaults exist but siteName is empty", () => {
    const line = buildStatusLine({
      ...COMPLETE,
      siteDefaultsValue: { defaults: { siteName: null } },
    });
    expect(line).toContain("Site identity: not captured (set_site_identity");
    expect(line).not.toContain("Site defaults: needs setup");
  });

  it("#551: flags an unset site URL and names the tool that sets it", () => {
    const line = buildStatusLine({ ...COMPLETE, seoValue: { siteBaseUrl: null } });
    expect(line).toContain("Site URL: not configured");
    expect(line).toContain("propose_set_site_seo({siteBaseUrl");
    // The old "you cannot set it" dead end is gone.
    expect(line).not.toContain("you cannot set it");
    expect(buildStatusLine({ ...COMPLETE, seoValue: { siteBaseUrl: "https://x.example" } })).toBe(
      undefined,
    );
    // A failed read is not evidence of an unset URL.
    expect(buildStatusLine({ ...COMPLETE, seoValue: null })).toBe(undefined);
  });

  it("0232: flags an unset site language and names set_site_identity", () => {
    const line = buildStatusLine({
      ...COMPLETE,
      siteDefaultsValue: { defaults: { siteName: "Acme", siteLanguage: null } },
    });
    expect(line).toContain("Site language: not set");
    expect(line).toContain("set_site_identity({siteLanguage})");
    expect(line).not.toContain("Site identity: not captured");
    expect(
      buildStatusLine({
        ...COMPLETE,
        siteDefaultsValue: { defaults: { siteName: "Acme", siteLanguage: "de" } },
      }),
    ).toBeUndefined();
    // Only an explicit null counts — a read without the field is not evidence.
    expect(buildStatusLine(COMPLETE)).toBeUndefined();
  });

  it("0232: an untouched install names both identity and language", () => {
    const line = buildStatusLine({
      ...COMPLETE,
      siteDefaultsValue: { defaults: { siteName: null, siteLanguage: null } },
    });
    expect(line).toContain("Site identity: not captured");
    expect(line).toContain("Site language: not set");
  });

  it("treats a seed-origin theme as needing setup even when one is active", () => {
    const line = buildStatusLine({ ...COMPLETE, activeTheme: { origin: "seed" } });
    expect(line).toContain("Theme: needs setup");
    expect(line).toContain("set_theme_tokens");
    // …and only the theme entry — everything else is complete.
    expect(line).not.toContain("Layout:");
    expect(line).not.toContain("Template:");
  });
});
