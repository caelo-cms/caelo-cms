// SPDX-License-Identifier: MPL-2.0

/** #1330 — the staging host's DNS records on Settings → Updates (staging-host-dns.ts). */

import { describe, expect, it } from "bun:test";
import { readStagingHostDns } from "../staging-host-dns.js";

const FIREBASE = {
  CAELO_PROVIDER: "gcp-firebase",
  GOOGLE_CLOUD_PROJECT: "acme",
  CAELO_FIREBASE_STAGING_SITE: "caelo-production-stg-abc123",
};

describe("readStagingHostDns", () => {
  it("gcp-firebase: the records the staging site's custom domain asks for", async () => {
    const asked: string[] = [];
    const dns = await readStagingHostDns("staging.acme.com", "acme.com", {
      env: FIREBASE,
      fetchHosting: async (path) => {
        asked.push(path);
        return {
          hostState: "HOST_MISMATCH",
          ownershipState: "OWNERSHIP_ACTIVE",
          requiredDnsUpdates: {
            desired: [
              {
                records: [{ domainName: "staging.acme.com.", type: "A", rdata: "199.36.158.100" }],
              },
            ],
          },
        };
      },
    });
    expect(asked).toEqual([
      "projects/acme/sites/caelo-production-stg-abc123/customDomains/staging.acme.com",
    ]);
    expect(dns).toEqual({
      kind: "records",
      host: "staging.acme.com",
      records: [{ name: "staging.acme.com", type: "A", value: "199.36.158.100" }],
      active: false,
    });
  });

  it("gcp-firebase: says why when the host or the site is not set up", async () => {
    const missing = await readStagingHostDns("staging.acme.com", "acme.com", {
      env: FIREBASE,
      fetchHosting: async () => null,
    });
    expect(missing.kind).toBe("unavailable");
    const noSite = await readStagingHostDns("staging.acme.com", "acme.com", {
      env: { CAELO_PROVIDER: "gcp-firebase" },
    });
    expect(noSite).toMatchObject({ kind: "unavailable" });
    const broken = await readStagingHostDns("staging.acme.com", "acme.com", {
      env: FIREBASE,
      fetchHosting: async () => {
        throw new Error("HTTP 403");
      },
    });
    expect(broken).toEqual({ kind: "unavailable", host: "staging.acme.com", reason: "HTTP 403" });
  });

  it("gcp and self-hosted: the record follows the site's; aws / azure serve no staging site yet", async () => {
    for (const provider of ["gcp", "self-hosted"]) {
      expect(
        await readStagingHostDns("staging.acme.com", "acme.com", {
          env: { CAELO_PROVIDER: provider },
        }),
      ).toEqual({ kind: "same-as-site", host: "staging.acme.com", sameAs: "acme.com" });
    }
    expect(
      await readStagingHostDns("staging.acme.com", "acme.com", { env: { CAELO_PROVIDER: "aws" } }),
    ).toEqual({ kind: "unsupported", host: "staging.acme.com" });
    // A development checkout (no CAELO_PROVIDER) is not self-hosted (#1330).
    expect(await readStagingHostDns("staging.acme.com", "acme.com", { env: {} })).toEqual({
      kind: "unsupported",
      host: "staging.acme.com",
    });
  });
});
