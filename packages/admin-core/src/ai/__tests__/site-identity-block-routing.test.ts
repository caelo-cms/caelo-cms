// SPDX-License-Identifier: MPL-2.0

/**
 * issue #187 — the cold-start `## Site identity` block must offer ALL
 * three entry points (Genesis / migrate / bring-your-own-design), and
 * ONLY on untouched installs. Regression class: routing text drifting
 * out of the prompt means an operator saying "my site is example.com"
 * gets a from-memory rebuild instead of a migration.
 */

import { describe, expect, it } from "bun:test";
import { formatSiteIdentityBlock } from "../system-prompt.js";

describe("formatSiteIdentityBlock — first-conversation routing (#187)", () => {
  it("untouched install: names all three routes with their tools", () => {
    const block = formatSiteIdentityBlock(null);
    expect(block).not.toBeNull();
    const b = block as string;
    expect(b).toContain("Untouched install");
    // Route 1 — Genesis (from scratch).
    expect(b).toContain("Site Genesis");
    expect(b).toContain("save_genesis_draft");
    // Route 2 — migration: the tool, the Owner gate, and the two
    // behavioural guardrails (don't claim it ran; don't rebuild from
    // memory).
    expect(b).toContain("MIGRATION");
    expect(b).toContain("propose_site_import");
    expect(b).toContain("never claim the crawl");
    expect(b).toContain("Do NOT rebuild an existing site from memory");
    // Route 3 — bring-your-own-design.
    expect(b).toContain("finished design");
    expect(b).toContain("build on THAT design");
    // Zero-manual-work principle is stated to the AI.
    expect(b).toContain("never send them to a form or wizard");
  });

  it("empty-string identity counts as untouched", () => {
    const block = formatSiteIdentityBlock({ siteName: "  ", sitePurpose: "" });
    expect(block).toContain("Untouched install");
    expect(block).toContain("propose_site_import");
  });

  it("configured install: routing instructions are absent", () => {
    const block = formatSiteIdentityBlock({
      siteName: "Krume & Kruste",
      sitePurpose: "Family bakery in Freiburg",
    });
    const b = block as string;
    expect(b).toContain("Krume & Kruste");
    expect(b).not.toContain("Untouched install");
    expect(b).not.toContain("propose_site_import");
    expect(b).not.toContain("Site Genesis");
  });
});
