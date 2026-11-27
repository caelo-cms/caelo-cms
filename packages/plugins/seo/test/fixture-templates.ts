// SPDX-License-Identifier: MPL-2.0

/**
 * One fixture page per special template (#1761) with the properties a
 * site would give it, and its mapping. Tests only.
 */

import type { StructuredDataArgs, StructuredDataPage } from "@caelo-cms/plugin-sdk";
import type { SchemaMapping } from "../src/schema/mapping.js";

const IMAGE = "f0000000-0000-4000-8000-000000000001";

const base = {
  isHome: false,
  lang: "de",
  shareImage: IMAGE,
  live: true,
  publishedAt: "2026-11-01T09:00:00.000Z",
  terms: [],
  listed: [],
} as const;

/** A fixture page of `pageType` with these properties. */
function page(
  n: number,
  pageType: string,
  title: string,
  properties: Record<string, unknown>,
): StructuredDataPage {
  return {
    ...base,
    pageId: `f1000000-0000-4000-8000-00000000000${n}`,
    pageType,
    path: `/${pageType}/${n}`,
    title,
    shortTitle: title,
    description: `${title}: what this page is about.`,
    properties,
  };
}

const address = {
  street: "Domplatz 1",
  city: "Köln",
  zip: "50667",
  country: "DE",
};

/** Each template: its page, its page type's properties and its mapping. */
export const TEMPLATE_FIXTURES: readonly {
  readonly schemaType: string;
  readonly page: StructuredDataPage;
  readonly properties: StructuredDataArgs["pageTypes"][string]["properties"];
  readonly mapping: SchemaMapping;
}[] = [
  {
    schemaType: "LocalBusiness",
    page: page(1, "location", "Büro Köln", {
      ...address,
      phone: "+49 221 123456",
      hours: "Mo-Fr 09:00-18:00",
      lat: 50.94,
      lng: 6.96,
    }),
    properties: [
      { name: "street", type: "text" },
      { name: "city", type: "text" },
      { name: "zip", type: "text" },
      { name: "country", type: "text" },
      { name: "phone", type: "text" },
      { name: "hours", type: "text" },
      { name: "lat", type: "number" },
      { name: "lng", type: "number" },
    ],
    mapping: {
      pageType: "location",
      schemaType: "LocalBusiness",
      roles: {
        street_address: "prop:street",
        locality: "prop:city",
        postal_code: "prop:zip",
        country: "prop:country",
        telephone: "prop:phone",
        opening_hours: ["prop:hours"],
        latitude: "prop:lat",
        longitude: "prop:lng",
        part_of: "organization",
      },
    },
  },
  {
    schemaType: "Event",
    page: page(2, "event", "SEO-Stammtisch", {
      starts: "2026-12-03T19:00:00+01:00",
      venue: "Café am Dom",
      ...address,
      state: "scheduled",
      price: 0,
      currency: "EUR",
    }),
    properties: [
      { name: "starts", type: "text" },
      { name: "venue", type: "text" },
      { name: "street", type: "text" },
      { name: "city", type: "text" },
      { name: "zip", type: "text" },
      { name: "country", type: "text" },
      { name: "state", type: "select" },
      { name: "price", type: "number" },
      { name: "currency", type: "text" },
    ],
    mapping: {
      pageType: "event",
      schemaType: "Event",
      roles: {
        start: "prop:starts",
        location_name: "prop:venue",
        street_address: "prop:street",
        locality: "prop:city",
        postal_code: "prop:zip",
        country: "prop:country",
        status: "prop:state",
        organizer: "organization",
        price: "prop:price",
        currency: "prop:currency",
      },
    },
  },
  {
    schemaType: "JobPosting",
    page: page(3, "job", "SEO Consultant (m/w/d)", {
      body: "<p>Du berätst Kunden zu <strong>technischem SEO</strong>.</p>",
      ...address,
      type: "FULL_TIME",
      until: "2027-01-31",
      min: 55000,
      max: 70000,
      currency: "EUR",
      unit: "YEAR",
    }),
    properties: [
      { name: "body", type: "richtext" },
      { name: "street", type: "text" },
      { name: "city", type: "text" },
      { name: "zip", type: "text" },
      { name: "country", type: "text" },
      { name: "type", type: "select" },
      { name: "until", type: "date" },
      { name: "min", type: "number" },
      { name: "max", type: "number" },
      { name: "currency", type: "text" },
      { name: "unit", type: "select" },
    ],
    mapping: {
      pageType: "job",
      schemaType: "JobPosting",
      roles: {
        description: "prop:body",
        street_address: "prop:street",
        locality: "prop:city",
        postal_code: "prop:zip",
        country: "prop:country",
        employment_type: ["prop:type"],
        valid_through: "prop:until",
        salary_min: "prop:min",
        salary_max: "prop:max",
        salary_currency: "prop:currency",
        salary_unit: "prop:unit",
      },
    },
  },
  {
    schemaType: "Product",
    page: page(4, "product", "Crawler Pro", {
      sku: "CP-1",
      price: 49.9,
      currency: "EUR",
      stock: "in_stock",
    }),
    properties: [
      { name: "sku", type: "text" },
      { name: "price", type: "number" },
      { name: "currency", type: "text" },
      { name: "stock", type: "select" },
    ],
    mapping: {
      pageType: "product",
      schemaType: "Product",
      roles: {
        sku: "prop:sku",
        brand: "organization",
        price: "prop:price",
        currency: "prop:currency",
        availability: "prop:stock",
      },
    },
  },
  {
    schemaType: "VideoObject",
    page: page(5, "video", "JSON-LD in 4 Minuten", {
      length: "PT4M13S",
      player: { href: "https://www.youtube.com/embed/abc123" },
    }),
    properties: [
      { name: "length", type: "text" },
      { name: "player", type: "link" },
    ],
    mapping: {
      pageType: "video",
      schemaType: "VideoObject",
      roles: { duration: "prop:length", embed_url: "prop:player" },
    },
  },
];
