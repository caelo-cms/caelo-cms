// SPDX-License-Identifier: MPL-2.0

/**
 * #891 regression: the public static site served user-uploaded SVGs from
 * the CDN with no CSP on every provider, so a script that got past
 * `sanitizeSvg` ran on the site's origin (the one that also serves
 * `/api/*`) when the SVG's URL was opened. These tests pin each provider's
 * edge config and that every stack wires it (source-level for the stacks:
 * the Pulumi programs cannot run in a unit test).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NOSNIFF, SVG_DOCUMENT_CSP } from "@caelo-cms/shared";
import {
  CLOUDFRONT_SVG_BEHAVIORS,
  cloudFrontHeadersPolicy,
  FRONT_DOOR_SECURITY_RULE_SET,
  frontDoorSecurityRules,
  GCP_STATIC_RESPONSE_HEADERS,
} from "./static-security-headers.js";

const stack = (provider: string): string =>
  readFileSync(resolve(import.meta.dir, "..", "stacks", provider, "index.ts"), "utf8");

describe("AWS CloudFront response headers policies", () => {
  it("site: nosniff only (a CSP with sandbox would break every page)", () => {
    const p = cloudFrontHeadersPolicy("site");
    expect(p.securityHeadersConfig.contentTypeOptions).toEqual({ override: true });
    expect(p.securityHeadersConfig.contentSecurityPolicy).toBeUndefined();
  });

  it("svg: nosniff + the sandboxing CSP, overriding any origin header", () => {
    const p = cloudFrontHeadersPolicy("svg");
    expect(p.securityHeadersConfig.contentTypeOptions).toEqual({ override: true });
    expect(p.securityHeadersConfig.contentSecurityPolicy).toEqual({
      contentSecurityPolicy: SVG_DOCUMENT_CSP,
      override: true,
    });
  });

  it("SVG behaviors cover both S3 origins, the media one first (first match wins)", () => {
    expect(CLOUDFRONT_SVG_BEHAVIORS).toEqual([
      { pathPattern: "/media/*.svg", targetOriginId: "media" },
      { pathPattern: "*.svg", targetOriginId: "static" },
    ]);
  });

  it("the stack attaches the svg policy to the SVG behaviors ahead of /media/*, the site policy everywhere else", () => {
    const src = stack("aws");
    expect(src).toContain('...cloudFrontHeadersPolicy("site")');
    expect(src).toContain('...cloudFrontHeadersPolicy("svg")');
    expect(src).toContain("...CLOUDFRONT_SVG_BEHAVIORS.map(");
    expect(src.match(/responseHeadersPolicyId: siteHeadersPolicy\.id/g)).toHaveLength(2);
    expect(src).toContain("responseHeadersPolicyId: svgHeadersPolicy.id");
    expect(src.indexOf("...CLOUDFRONT_SVG_BEHAVIORS.map(")).toBeLessThan(
      src.indexOf('pathPattern: "/media/*"'),
    );
  });
});

describe("Azure Front Door security rule set", () => {
  const rules = frontDoorSecurityRules();

  it("nosniff on every response (no condition)", () => {
    const nosniff = rules.find((r) => r.ruleName === "nosniff");
    expect(nosniff && "conditions" in nosniff).toBe(false);
    expect(nosniff?.actions).toEqual([
      {
        name: "ModifyResponseHeader",
        parameters: {
          typeName: "DeliveryRuleHeaderActionParameters",
          headerAction: "Overwrite",
          headerName: "X-Content-Type-Options",
          value: NOSNIFF,
        },
      },
    ]);
  });

  it("the CSP when the file extension is svg, compared lower-cased", () => {
    const svg = rules.find((r) => r.ruleName === "svgCsp");
    expect(svg && "conditions" in svg ? svg.conditions : []).toEqual([
      {
        name: "UrlFileExtension",
        parameters: {
          typeName: "DeliveryRuleUrlFileExtensionMatchConditionParameters",
          operator: "Equal",
          negateCondition: false,
          matchValues: ["svg"],
          transforms: ["Lowercase"],
        },
      },
    ]);
    expect(svg?.actions[0]?.parameters).toMatchObject({
      headerName: "Content-Security-Policy",
      value: SVG_DOCUMENT_CSP,
    });
  });

  it("rules keep processing so both apply, with distinct orders", () => {
    expect(rules.every((r) => r.matchProcessingBehavior === "Continue")).toBe(true);
    expect(new Set(rules.map((r) => r.order)).size).toBe(rules.length);
  });

  it("the stack creates the set and attaches it to the static route next to the redirects", () => {
    const src = stack("azure");
    expect(src).toContain("ruleSetName: FRONT_DOOR_SECURITY_RULE_SET");
    expect(src).toContain("for (const rule of frontDoorSecurityRules())");
    expect(src).toContain("ruleSets: [{ id: redirectRuleSet.id }, { id: securityRuleSet.id }]");
    expect(FRONT_DOOR_SECURITY_RULE_SET).not.toBe("caeloRedirects");
  });
});

describe("GCP static backend bucket", () => {
  it("adds nosniff to every response", () => {
    expect(GCP_STATIC_RESPONSE_HEADERS).toEqual([`X-Content-Type-Options: ${NOSNIFF}`]);
  });

  it("the stack sets the headers on the static backend bucket", () => {
    expect(stack("gcp")).toContain("customResponseHeaders: [...GCP_STATIC_RESPONSE_HEADERS]");
  });
});
