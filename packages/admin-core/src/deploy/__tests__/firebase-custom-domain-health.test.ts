// SPDX-License-Identifier: MPL-2.0

/**
 * The stuck-domain rule (firebase-custom-domain-health.ts), pinned against
 * the shape Firebase Hosting returned on a gcp-firebase install whose
 * custom domain stayed HOST_MISMATCH / OWNERSHIP_PENDING for hours after
 * DNS was fixed.
 */

import { describe, expect, it } from "bun:test";
import {
  assessCustomDomain,
  domainsActivatedSince,
  type FirebaseCustomDomain,
  type FirebaseDnsRecordSet,
} from "../firebase-custom-domain-health.js";

const NAME = "projects/p/sites/s/customDomains/example.com";

const CORRECT_DNS: FirebaseDnsRecordSet[] = [
  {
    domainName: "example.com",
    records: [
      { domainName: "example.com", type: "A", rdata: "199.36.158.100", requiredAction: "NONE" },
      {
        domainName: "example.com",
        type: "TXT",
        rdata: "hosting-site=s",
        requiredAction: "NONE",
      },
    ],
  },
];

/** The incident: DNS right, states wrong, Firebase stopped checking. */
function incident(overrides: Partial<FirebaseCustomDomain> = {}): FirebaseCustomDomain {
  return {
    name: NAME,
    hostState: "HOST_MISMATCH",
    ownershipState: "OWNERSHIP_PENDING",
    cert: { state: "CERT_ACTIVE", type: "TEMPORARY" },
    requiredDnsUpdates: {
      checkTime: "2026-10-10T14:56:00Z",
      desired: CORRECT_DNS,
      discovered: CORRECT_DNS,
    },
    createTime: "2026-09-29T09:00:00Z",
    updateTime: "2026-09-29T09:00:00Z",
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe("assessCustomDomain", () => {
  it("flags the observed incident as stuck (check frozen for 4 h, DNS correct)", () => {
    const h = assessCustomDomain(incident(), at("2026-10-10T19:00:00Z"));
    expect(h.status).toBe("stuck");
    expect(h.hostname).toBe("example.com");
    expect(h.summary).toContain("stuck — reconnect recommended");
    expect(h.summary).toContain("HOST_MISMATCH / OWNERSHIP_PENDING");
    expect(h.summary).toContain("stopped re-checking");
    expect(h.dnsChanges).toEqual([]);
  });

  it("is stuck when the domain has not changed for over an hour, even with a fresh check", () => {
    const h = assessCustomDomain(
      incident({
        requiredDnsUpdates: {
          checkTime: "2026-10-10T18:55:00Z",
          desired: CORRECT_DNS,
          discovered: CORRECT_DNS,
        },
      }),
      at("2026-10-10T19:00:00Z"),
    );
    expect(h.status).toBe("stuck");
    expect(h.summary).toContain("has not changed for");
  });

  it("is verifying (not stuck) while Firebase checks recently and the domain changed recently", () => {
    const h = assessCustomDomain(
      incident({
        updateTime: "2026-10-10T18:30:00Z",
        requiredDnsUpdates: {
          checkTime: "2026-10-10T18:50:00Z",
          desired: CORRECT_DNS,
          discovered: CORRECT_DNS,
        },
      }),
      at("2026-10-10T19:00:00Z"),
    );
    expect(h.status).toBe("provisioning");
    expect(h.summary).toContain("last check 10 min ago");
  });

  it("thresholds are inputs: a 29-minute-old check is not stale, a 31-minute-old one is", () => {
    const fresh = {
      updateTime: "2026-10-10T18:50:00Z",
      requiredDnsUpdates: {
        checkTime: "2026-10-10T18:31:00Z",
        desired: CORRECT_DNS,
        discovered: CORRECT_DNS,
      },
    };
    expect(assessCustomDomain(incident(fresh), at("2026-10-10T19:00:00Z")).status).toBe(
      "provisioning",
    );
    expect(assessCustomDomain(incident(fresh), at("2026-10-10T19:02:00Z")).status).toBe("stuck");
    expect(
      assessCustomDomain(incident(fresh), at("2026-10-10T19:02:00Z"), {
        staleCheckMs: 60 * 60_000,
        noProgressMs: 60 * 60_000,
      }).status,
    ).toBe("provisioning");
  });

  it("is waiting for DNS (never stuck) while a record must be added or removed", () => {
    const h = assessCustomDomain(
      incident({
        requiredDnsUpdates: {
          checkTime: "2026-10-10T10:00:00Z",
          desired: [
            {
              domainName: "example.com",
              records: [{ type: "A", rdata: "199.36.158.100", requiredAction: "ADD" }],
            },
          ],
          discovered: [
            {
              domainName: "example.com",
              records: [{ type: "A", rdata: "104.21.1.1", requiredAction: "REMOVE" }],
            },
          ],
        },
      }),
      at("2026-10-10T19:00:00Z"),
    );
    expect(h.status).toBe("dns_pending");
    expect(h.dnsChanges).toEqual([
      { action: "ADD", type: "A", domainName: "example.com", rdata: "199.36.158.100" },
      { action: "REMOVE", type: "A", domainName: "example.com", rdata: "104.21.1.1" },
    ]);
    expect(h.summary).toContain("add A example.com 199.36.158.100");
    expect(h.summary).toContain("remove A example.com 104.21.1.1");
  });

  it("a desired record Firebase has not discovered counts as a pending ADD", () => {
    const h = assessCustomDomain(
      incident({
        requiredDnsUpdates: {
          checkTime: "2026-10-10T10:00:00Z",
          desired: CORRECT_DNS,
          discovered: [{ domainName: "example.com", records: [CORRECT_DNS[0]!.records![0]!] }],
        },
      }),
      at("2026-10-10T19:00:00Z"),
    );
    expect(h.status).toBe("dns_pending");
    expect(h.dnsChanges.map((c) => c.type)).toEqual(["TXT"]);
  });

  it("is provisioning while Firebase has not computed the desired records", () => {
    const h = assessCustomDomain(
      incident({ requiredDnsUpdates: { checkTime: "2026-10-10T10:00:00Z" } }),
      at("2026-10-10T19:00:00Z"),
    );
    expect(h.status).toBe("provisioning");
  });

  it("reports a soft-deleted domain as deleted, never as active or stuck", () => {
    const h = assessCustomDomain(
      incident({
        hostState: "HOST_ACTIVE",
        ownershipState: "OWNERSHIP_ACTIVE",
        deleteTime: "2026-10-10T18:00:00Z",
        expireTime: "2026-11-09T18:00:00Z",
      }),
      at("2026-10-10T19:00:00Z"),
    );
    expect(h.status).toBe("deleted");
    expect(h.summary).toContain("restorable until 2026-11-09T18:00:00Z");
  });

  it("is active when host and ownership are active, whatever the timestamps", () => {
    const h = assessCustomDomain(
      incident({ hostState: "HOST_ACTIVE", ownershipState: "OWNERSHIP_ACTIVE" }),
      at("2026-12-01T00:00:00Z"),
    );
    expect(h.status).toBe("active");
    expect(h.summary).toContain("CERT_ACTIVE");
  });
});

describe("domainsActivatedSince", () => {
  const active = (updateTime: string): FirebaseCustomDomain =>
    incident({ hostState: "HOST_ACTIVE", ownershipState: "OWNERSHIP_ACTIVE", updateTime });

  it("returns the active domains that changed after the release", () => {
    const fresh = active("2026-10-10T19:05:00Z");
    const old = active("2026-10-01T00:00:00Z");
    const inactive = incident({ updateTime: "2026-10-10T19:05:00Z" });
    expect(domainsActivatedSince([fresh, old, inactive], "2026-10-10T19:00:00Z")).toEqual([fresh]);
  });

  it("returns nothing for an unparseable release time", () => {
    expect(domainsActivatedSince([active("2026-10-10T19:05:00Z")], "nope")).toEqual([]);
  });
});
