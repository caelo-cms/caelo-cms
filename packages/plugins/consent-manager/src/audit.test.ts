// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pluginAuditFindings } from "@caelo-cms/plugin-sdk";
import { unreviewedEmbedFindings, type WithheldEmbed } from "./audit.js";

const embed = (over: Partial<WithheldEmbed>): WithheldEmbed => ({
  moduleId: "11111111-1111-1111-1111-111111111111",
  moduleSlug: "site-header",
  siteChrome: false,
  hosts: ["cdn.example.com"],
  reason: "unclassified",
  ...over,
});

describe("unreviewedEmbedFindings", () => {
  it("blocks Publish live for every unclassified module", () => {
    const findings = unreviewedEmbedFindings([embed({ siteChrome: true })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain('module "site-header" loads from cdn.example.com');
    expect(findings[0]?.message).toContain("every page is missing it");
    expect(findings[0]?.fix?.tool).toBe("classify_external_embed");
    // Core validates the answer; a finding it would reject fails the audit.
    expect(pluginAuditFindings.safeParse({ findings }).success).toBe(true);
  });

  it("leaves gated modules alone: their consent placeholder is the intended state", () => {
    expect(unreviewedEmbedFindings([embed({ reason: "marketing" })])).toEqual([]);
  });

  it("caps the host list so the message stays within the finding limit", () => {
    const hosts = Array.from(
      { length: 200 },
      (_, i) => `host-${i}.some-long-vendor-domain.example`,
    );
    const [finding] = unreviewedEmbedFindings([embed({ hosts })]);
    expect(finding?.message).toContain("and 192 more");
    expect(pluginAuditFindings.safeParse({ findings: [finding] }).success).toBe(true);
  });
});
