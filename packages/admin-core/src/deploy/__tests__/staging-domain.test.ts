// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { formatStagingAccess } from "../../ai/tools/staging-access-tools.js";
import { basicAuthUserForSite } from "../../ops/staging_access.js";
import { describeDraftPages } from "../draft-pages.js";
import {
  describeStageNeeded,
  providerHasStagingDomain,
  stageNeededFor,
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

describe("what the staging host serves (#678)", () => {
  it("needs a Stage when nothing is staged or the served build has another host", () => {
    expect(stageNeededFor("p.example.com", null, false)).toBe("nothing-staged");
    expect(stageNeededFor("p.example.com", "staging.example.com", true)).toBe("host-changed");
    expect(stageNeededFor("p.example.com", "p.example.com", true)).toBe(null);
    expect(describeStageNeeded("nothing-staged", "p.example.com")).toContain(
      "Nothing is served at https://p.example.com/ until the next Stage",
    );
    expect(describeStageNeeded("host-changed", "p.example.com")).toContain("stage_changes");
    expect(describeStageNeeded(null, "p.example.com")).toBe(null);
  });

  it("names the draft pages a build leaves out and the next step", () => {
    expect(describeDraftPages({ count: 0, pages: [] })).toBe(null);
    const text = describeDraftPages({
      count: 3,
      pages: [{ id: "1", title: "Pricing", path: "/pricing/" }],
    });
    expect(text).toContain(
      "3 page(s) are draft and NOT included: 'Pricing' (/pricing/) and 2 more",
    );
    expect(text).toContain("set_pages_status_many");
  });

  it("derives the basic-auth user from the live site", () => {
    expect(basicAuthUserForSite("www.searchviu.com")).toBe("searchviu");
    expect(basicAuthUserForSite("example.co.uk:8443")).toBe("example");
    expect(basicAuthUserForSite(undefined)).toBe(null);
  });

  it("get_staging_access tells the AI to Stage and which pages are draft", () => {
    const text = formatStagingAccess({
      stagingUrl: "https://p.example.com",
      stagingHost: "p.example.com",
      stagingDomainSupported: true,
      provider: "gcp-firebase",
      hasStagedBuild: false,
      stagedBuildHost: null,
      stageNeeded: "nothing-staged",
      stageNote: describeStageNeeded("nothing-staged", "p.example.com"),
      draftPages: { count: 1, pages: [{ id: "1", title: "Pricing", path: "/pricing/" }] },
      settings: {
        cookieEnabled: true,
        basicAuthEnabled: true,
        basicAuthUser: "example",
        basicAuthGenerated: true,
        headerEnabled: false,
        headerName: "X-Caelo-Staging-Key",
        headerGenerated: false,
        ipAllowlist: [],
        updatedAt: "2026-10-13T00:00:00.000Z",
      },
    });
    expect(text).toContain("until the next Stage");
    expect(text).toContain("stage_changes");
    expect(text).toContain("'Pricing' (/pricing/)");
  });
});
