// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  providerHasStagingDomain,
  stagingGateSecret,
  stagingPageUrl,
  stagingSiteUrl,
} from "../staging-domain.js";

describe("stagingSiteUrl (#650)", () => {
  it("is null on providers without a protected staging domain", () => {
    for (const p of ["gcp", "aws", "azure", "self-hosted", undefined]) {
      expect(stagingSiteUrl(p, { CAELO_STAGING_SITE_URL: "https://staging.example.com" })).toBe(
        null,
      );
      expect(providerHasStagingDomain(p)).toBe(false);
    }
  });

  it("returns the bare origin on gcp-firebase", () => {
    expect(
      stagingSiteUrl("gcp-firebase", { CAELO_STAGING_SITE_URL: "https://staging.example.com/" }),
    ).toBe("https://staging.example.com");
  });

  it("fails loudly when gcp-firebase has no or a malformed staging URL", () => {
    expect(() => stagingSiteUrl("gcp-firebase", {})).toThrow("cms-provision upgrade");
    expect(() => stagingSiteUrl("gcp-firebase", { CAELO_STAGING_SITE_URL: "nope" })).toThrow(
      "not a URL",
    );
    expect(() =>
      stagingSiteUrl("gcp-firebase", { CAELO_STAGING_SITE_URL: "http://staging.example.com" }),
    ).toThrow("bare https origin");
    expect(() =>
      stagingSiteUrl("gcp-firebase", { CAELO_STAGING_SITE_URL: "https://staging.example.com/x" }),
    ).toThrow("bare https origin");
  });
});

describe("stagingGateSecret / stagingPageUrl", () => {
  it("requires the gate secret", () => {
    expect(stagingGateSecret({ CAELO_STAGING_GATE_SECRET: "s" })).toBe("s");
    expect(() => stagingGateSecret({})).toThrow("staging-gate-secret");
  });

  it("joins origin and path", () => {
    expect(stagingPageUrl("https://staging.example.com/", "/a/")).toBe(
      "https://staging.example.com/a/",
    );
    expect(stagingPageUrl("https://staging.example.com", "a")).toBe(
      "https://staging.example.com/a",
    );
  });
});
