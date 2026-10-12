// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  providerHasStagingDomain,
  stagingGateSecret,
  stagingPageUrl,
  stagingSiteUrl,
} from "../staging-domain.js";

/** A transaction stub answering the staging_access read with `host`. */
function txWith(host: string | null) {
  return { execute: async () => [{ staging_host: host }] } as never;
}

describe("stagingSiteUrl (#650)", () => {
  it("is null on providers without a protected staging domain, whatever is stored", async () => {
    for (const p of ["gcp", "aws", "azure", "self-hosted", undefined]) {
      expect(await stagingSiteUrl(txWith("staging.example.com"), p)).toBe(null);
      expect(providerHasStagingDomain(p)).toBe(false);
    }
  });

  it("is the stored staging host on gcp-firebase — any host the operator chose", async () => {
    expect(await stagingSiteUrl(txWith("staging.example.com"), "gcp-firebase")).toBe(
      "https://staging.example.com",
    );
    expect(await stagingSiteUrl(txWith("preview.other.de"), "gcp-firebase")).toBe(
      "https://preview.other.de",
    );
  });

  it("fails loudly on gcp-firebase when no host is stored", async () => {
    await expect(stagingSiteUrl(txWith(null), "gcp-firebase")).rejects.toThrow(
      "No staging host is configured",
    );
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
