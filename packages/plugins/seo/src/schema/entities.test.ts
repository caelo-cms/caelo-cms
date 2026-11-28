// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { TEMPLATE_FIXTURES } from "../../test/fixture-templates.js";
import { mappingProblems } from "./mapping.js";
import { structuredDataAnswer } from "./nodes.js";
import { SCHEMA_TYPES } from "./types.js";

/** The answer for one template fixture page. */
function answerOf(fixture: (typeof TEMPLATE_FIXTURES)[number]) {
  return structuredDataAnswer({
    args: {
      pages: [fixture.page],
      related: [],
      pageTypes: { [fixture.page.pageType]: { properties: fixture.properties } },
      site: { organization: true, name: "Beispiel GmbH" },
    },
    mappings: new Map([[fixture.page.pageType, fixture.mapping]]),
  }).pages[fixture.page.pageId];
}

describe("special schema templates (#1761)", () => {
  it("has a fixture for every template", () => {
    expect(TEMPLATE_FIXTURES.map((f) => f.schemaType).sort()).toEqual(
      ["Event", "JobPosting", "LocalBusiness", "Product", "VideoObject"].sort(),
    );
  });

  for (const fixture of TEMPLATE_FIXTURES) {
    it(`${fixture.schemaType}: the fixture page carries Google's required properties`, () => {
      expect(mappingProblems(fixture.mapping, fixture.properties)).toEqual([]);
      const answer = answerOf(fixture);
      const node = answer?.nodes?.[0];
      expect(node?.type).toBe(fixture.schemaType);
      const spec = SCHEMA_TYPES[fixture.schemaType];
      for (const property of spec?.required ?? []) {
        expect({ property, present: node?.properties[property] !== undefined }).toEqual({
          property,
          present: true,
        });
      }
      // Core's WebPage names the node as the page's main entity.
      expect(answer?.webPage?.properties?.mainEntity).toEqual({
        ref: { fragment: node?.id.fragment },
      });
    });
  }

  it("writes an event's place, status, attendance mode and offer", () => {
    const fixture = TEMPLATE_FIXTURES.find((f) => f.schemaType === "Event");
    if (!fixture) throw new Error("no event fixture");
    const props = answerOf(fixture)?.nodes?.[0]?.properties;
    expect(props?.startDate).toEqual({ date: "2026-12-03T19:00:00+01:00" });
    expect(props?.eventStatus).toEqual({ schema: "EventScheduled" });
    expect(props?.eventAttendanceMode).toEqual({ schema: "OfflineEventAttendanceMode" });
    expect(props?.organizer).toEqual({ ref: "organization" });
    expect(props?.offers).toEqual({
      node: { type: "Offer", properties: { price: 0, priceCurrency: "EUR" } },
    });
  });

  it("writes a remote job without a place", () => {
    const fixture = TEMPLATE_FIXTURES.find((f) => f.schemaType === "JobPosting");
    if (!fixture) throw new Error("no job fixture");
    const remote = {
      ...fixture,
      page: { ...fixture.page, properties: { ...fixture.page.properties, remote: true } },
      properties: [...fixture.properties, { name: "remote", type: "boolean" }],
      mapping: { ...fixture.mapping, roles: { ...fixture.mapping.roles, remote: "prop:remote" } },
    };
    const props = answerOf(remote)?.nodes?.[0]?.properties;
    expect(props?.jobLocationType).toBe("TELECOMMUTE");
    expect(props?.jobLocation).toBeUndefined();
    expect(props?.applicantLocationRequirements).toEqual({
      node: { type: "Country", properties: { name: "DE" } },
    });
    expect(props?.baseSalary).toEqual({
      node: {
        type: "MonetaryAmount",
        properties: {
          currency: "EUR",
          value: {
            node: {
              type: "QuantitativeValue",
              properties: { minValue: 55000, maxValue: 70000, unitText: "YEAR" },
            },
          },
        },
      },
    });
  });
});
