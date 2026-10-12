// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { formatDnsRecordGroups, groupDnsRecords, switchesPublicSite } from "./groups.js";

const domain = "example.com";

describe("groupDnsRecords", () => {
  it("keeps the main domain's traffic records for go-live (gcp load balancer)", () => {
    const records = [
      { hostname: "example.com", type: "A", value: "203.0.113.7" },
      { hostname: "admin.example.com", type: "A", value: "203.0.113.7" },
    ];
    const g = groupDnsRecords(records, domain);
    expect(g.setNow.map((r) => r.hostname)).toEqual(["admin.example.com"]);
    expect(g.atGoLive.map((r) => r.hostname)).toEqual(["example.com"]);
  });

  it("sets verification TXT records now and apex A records at go-live (gcp-firebase)", () => {
    const records = [
      { hostname: "admin.example.com", type: "CNAME", value: "ghs.googlehosted.com." },
      { hostname: "example.com", type: "TXT", value: "hosting-site=caelo" },
      { hostname: "_acme-challenge.example.com", type: "TXT", value: "abc" },
      { hostname: "example.com", type: "A", value: "199.36.158.100" },
      { hostname: "www.example.com", type: "CNAME", value: "example.web.app." },
    ];
    const g = groupDnsRecords(records, domain);
    expect(g.setNow.map((r) => `${r.type} ${r.hostname}`)).toEqual([
      "CNAME admin.example.com",
      "TXT example.com",
      "TXT _acme-challenge.example.com",
    ]);
    expect(g.atGoLive.map((r) => `${r.type} ${r.hostname}`)).toEqual([
      "A example.com",
      "CNAME www.example.com",
    ]);
  });

  it("compares host names case- and trailing-dot-insensitively", () => {
    expect(
      switchesPublicSite({ hostname: "Example.com.", type: "aaaa", value: "::1" }, domain),
    ).toBe(true);
    expect(
      switchesPublicSite({ hostname: "staging.example.com", type: "CNAME", value: "x" }, domain),
    ).toBe(false);
  });
});

describe("formatDnsRecordGroups", () => {
  it("labels both groups and warns about the go-live records", () => {
    const lines = formatDnsRecordGroups(
      groupDnsRecords(
        [
          { hostname: "example.com", type: "A", value: "1.2.3.4" },
          { hostname: "admin.example.com", type: "A", value: "1.2.3.4" },
        ],
        domain,
      ),
      domain,
    );
    expect(lines[0]).toBe("Set now (new hosts, nothing live uses them):");
    expect(lines).toContain("Only at go-live (these move example.com to Caelo):");
    expect(lines.join("\n")).toContain("takes a website that is live on example.com offline");
    expect(lines.indexOf("Only at go-live (these move example.com to Caelo):")).toBeGreaterThan(
      lines.findIndex((l) => /^\s+A\s+admin\.example\.com\s/.test(l)),
    );
  });

  it("omits an empty group", () => {
    const lines = formatDnsRecordGroups(
      groupDnsRecords([{ hostname: "admin.example.com", type: "A", value: "1.2.3.4" }], domain),
      domain,
    );
    expect(lines.some((l) => l.includes("go-live"))).toBe(false);
  });
});
