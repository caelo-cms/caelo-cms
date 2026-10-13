// SPDX-License-Identifier: MPL-2.0

/**
 * The public site on every provider is object storage behind the provider's
 * CDN, with no edge compute on the request path (CLAUDE.md §11.B Tier 1).
 * Epic #676 removed the per-provider A/B edge routers; these checks keep them
 * from coming back and pin the Azure primary domain to its Front Door
 * endpoint. Stack checks are pure-string, like the other stack tests.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { azureFrontDoorDnsRecords } from "./azure-front-door.js";

const stackDir = (provider: string) => resolve(import.meta.dir, `../stacks/${provider}`);
const stack = (provider: string) => readFileSync(`${stackDir(provider)}/index.ts`, "utf8");

describe("azureFrontDoorDnsRecords", () => {
  const records = azureFrontDoorDnsRecords({
    domain: "example.com",
    endpointHostName: "caeloproduction-site-abc123.z01.azurefd.net",
    validationToken: "tok-123",
  });

  it("points the primary domain at the Front Door endpoint", () => {
    expect(records).toContainEqual(
      expect.objectContaining({
        hostname: "example.com",
        type: "CNAME",
        value: "caeloproduction-site-abc123.z01.azurefd.net",
      }),
    );
  });

  it("publishes the managed-certificate validation token", () => {
    expect(records).toContainEqual(
      expect.objectContaining({ hostname: "_dnsauth.example.com", type: "TXT", value: "tok-123" }),
    );
  });

  it("refuses an endpoint without a hostname instead of emitting a dangling record", () => {
    expect(() =>
      azureFrontDoorDnsRecords({
        domain: "example.com",
        endpointHostName: "",
        validationToken: "t",
      }),
    ).toThrow(/no hostName/);
  });

  it("refuses a custom domain without a validation token", () => {
    expect(() =>
      azureFrontDoorDnsRecords({
        domain: "example.com",
        endpointHostName: "x.azurefd.net",
        validationToken: "",
      }),
    ).toThrow(/no validation token/);
  });
});

describe("azure stack — static site behind Front Door", () => {
  const src = stack("azure");

  it("builds its DNS records from the Front Door endpoint and custom domain", () => {
    expect(src).toContain("new azure.cdn.AFDEndpoint(");
    expect(src).toContain("new azure.cdn.AFDCustomDomain(");
    expect(src).toMatch(
      /pulumi\s*\.all\(\[frontDoorEndpoint\.hostName, siteDomain\.validationProperties\]\)[\s\S]*?azureFrontDoorDnsRecords\(/,
    );
  });

  it("routes the custom domain to the static-website origin", () => {
    expect(src).toContain("new azure.storage.StorageAccountStaticWebsite(");
    expect(src).toMatch(
      /new azure\.cdn\.Route\([\s\S]*?customDomains: \[\{ id: siteDomain\.id \}\]/,
    );
  });

  it("exposes no Container App to the public internet", () => {
    expect(src).toContain("external: false");
    expect(src).not.toMatch(/external:\s*(true|args\.)/);
  });
});

describe.each(["aws", "azure", "gcp", "gcp-firebase", "self-hosted"])(
  "%s stack — no edge router",
  (provider) => {
    const src = stack(provider);

    it("runs no edge compute for the public site", () => {
      expect(src).not.toContain("edge-router");
      expect(src).not.toContain("lambdaFunctionAssociations");
      expect(src).not.toContain("ab-routing.json");
    });

    it("ships no edge handler source", () => {
      expect(existsSync(`${stackDir(provider)}/edge-handler.ts`)).toBe(false);
    });
  },
);
