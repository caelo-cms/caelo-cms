// SPDX-License-Identifier: MPL-2.0

/**
 * #1343 — the visitor's consent decision reaches core in a request header,
 * never a cookie: behind Firebase Hosting no consent cookie arrives.
 */

import { describe, expect, it } from "bun:test";
import {
  parseVisitorConsentHeader,
  VISITOR_CONSENT_HEADER,
  type VisitorConsentRule,
  visitorConsentGranted,
} from "./visitor-consent.js";

const RULE: VisitorConsentRule = { policyVersion: 2, purposes: { visitor_id: "functional" } };

describe("parseVisitorConsentHeader", () => {
  it("is the x-caelo-consent header", () => {
    expect(VISITOR_CONSENT_HEADER).toBe("x-caelo-consent");
  });

  it("reads the version and the granted categories", () => {
    expect(parseVisitorConsentHeader("v=2; granted=necessary,functional")).toEqual({
      policyVersion: 2,
      granted: ["necessary", "functional"],
    });
    expect(parseVisitorConsentHeader("v=7;granted=")).toEqual({ policyVersion: 7, granted: [] });
  });

  it("reads nothing it cannot read unambiguously", () => {
    for (const bad of [
      null,
      "",
      "v=0; granted=functional",
      "v=-1; granted=functional",
      "granted=functional; v=2",
      "v=2; granted=Functional",
      "v=2; granted=functional,,",
      '{"granted":["functional"],"policyVersion":2}',
      `v=2; granted=${Array.from({ length: 33 }, (_, i) => `c${i}`).join(",")}`,
    ]) {
      expect(parseVisitorConsentHeader(bad)).toBeNull();
    }
  });
});

describe("visitorConsentGranted", () => {
  it("grants only the purpose's category under the current policy version", () => {
    expect(visitorConsentGranted(RULE, "visitor_id", "v=2; granted=necessary,functional")).toBe(
      true,
    );
    expect(visitorConsentGranted(RULE, "visitor_id", "v=2; granted=necessary,analytics")).toBe(
      false,
    );
    expect(visitorConsentGranted(RULE, "visitor_id", "v=1; granted=functional")).toBe(false);
    expect(visitorConsentGranted(RULE, "visitor_id", null)).toBe(false);
  });

  it("without a consent provider nobody has consented", () => {
    expect(visitorConsentGranted(null, "visitor_id", "v=2; granted=functional")).toBe(false);
  });

  it("throws for a purpose the provider does not classify", () => {
    expect(() => visitorConsentGranted(RULE, "other", "v=2; granted=functional")).toThrow(
      "does not classify",
    );
  });
});
