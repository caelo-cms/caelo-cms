// SPDX-License-Identifier: MPL-2.0

/**
 * The special templates (#1761): a page that IS one thing — a location of
 * a business, an event, an open position, a product, a video — becomes one
 * node `<page URL>#<kind>`, and core's WebPage names it as `mainEntity`.
 * Used only when a site maps a page type to one of them.
 *
 * The node carries Google's required properties when the mapped properties
 * hold them; what is missing is a finding of the plugin's type rules, never
 * filled with a guess (CLAUDE.md §2, no fallbacks).
 */

import type {
  StructuredDataPage,
  StructuredDataPageAnswer,
  StructuredDataScalar,
  StructuredDataValue,
} from "@caelo-cms/plugin-sdk";
import type { SchemaMapping } from "./mapping.js";
import type { SchemaTypeSpec } from "./types.js";
import { type NodeContext, oneOrMany, put, roleValues } from "./values.js";

/** The node's fragment per template. */
const FRAGMENT: Readonly<Record<string, string>> = {
  LocalBusiness: "business",
  Event: "event",
  JobPosting: "job",
  Product: "product",
  VideoObject: "video",
};

/** A select option → its schema.org term. */
const EVENT_STATUS: Readonly<Record<string, string>> = {
  scheduled: "EventScheduled",
  cancelled: "EventCancelled",
  postponed: "EventPostponed",
  rescheduled: "EventRescheduled",
  moved_online: "EventMovedOnline",
};

const AVAILABILITY: Readonly<Record<string, string>> = {
  in_stock: "InStock",
  out_of_stock: "OutOfStock",
  pre_order: "PreOrder",
  sold_out: "SoldOut",
  limited: "LimitedAvailability",
};

type Props = Record<string, StructuredDataValue>;

/** Reads the roles of one page. */
class Roles {
  constructor(
    private readonly ctx: NodeContext,
    private readonly page: StructuredDataPage,
    private readonly mapping: SchemaMapping,
  ) {}

  all(role: string): StructuredDataScalar[] {
    return roleValues(this.ctx, this.page, this.mapping, role);
  }

  one(role: string): StructuredDataScalar | undefined {
    return this.all(role)[0];
  }

  text(role: string): string | undefined {
    const v = this.one(role);
    return typeof v === "string" ? v : undefined;
  }

  /** A date role: a date value, or a text value holding an ISO date (core checks it). */
  date(role: string): StructuredDataScalar | undefined {
    const v = this.one(role);
    return typeof v === "string" ? { date: v } : v;
  }

  /** A select role through a table of schema.org terms; an option outside it gives nothing. */
  term(role: string, table: Readonly<Record<string, string>>): StructuredDataScalar | undefined {
    const v = this.text(role);
    const term = v === undefined ? undefined : table[v];
    return term ? { schema: term } : undefined;
  }

  /** An organisation role: the site's Organization, or one named by a text property. */
  organization(role: string, type = "Organization"): StructuredDataScalar | undefined {
    const v = this.one(role);
    return typeof v === "string" ? { node: { type, properties: { name: v } } } : v;
  }

  /** The postal address the address roles describe, or nothing. */
  address(): StructuredDataScalar | undefined {
    const props: Props = {};
    put(props, "streetAddress", this.text("street_address"));
    put(props, "addressLocality", this.text("locality"));
    put(props, "postalCode", this.text("postal_code"));
    put(props, "addressRegion", this.text("region"));
    put(props, "addressCountry", this.text("country"));
    return Object.keys(props).length > 0
      ? { node: { type: "PostalAddress", properties: props } }
      : undefined;
  }

  /** The offer the offer roles describe, or nothing. */
  offer(): StructuredDataScalar | undefined {
    const props: Props = {};
    put(props, "price", this.one("price"));
    put(props, "priceCurrency", this.text("currency"));
    put(props, "availability", this.term("availability", AVAILABILITY));
    put(props, "url", this.one("offer_url"));
    return Object.keys(props).length > 0
      ? { node: { type: "Offer", properties: props } }
      : undefined;
  }
}

function localBusiness(r: Roles, page: StructuredDataPage): Props {
  const props: Props = {};
  put(props, "name", r.text("name"));
  put(props, "url", { page: page.pageId });
  put(props, "image", r.one("image"));
  put(props, "address", r.address());
  put(props, "telephone", r.text("telephone"));
  put(props, "openingHours", oneOrMany(r.all("opening_hours")));
  put(props, "priceRange", r.text("price_range"));
  const lat = r.one("latitude");
  const lng = r.one("longitude");
  if (typeof lat === "number" && typeof lng === "number") {
    props.geo = { node: { type: "GeoCoordinates", properties: { latitude: lat, longitude: lng } } };
  }
  put(props, "parentOrganization", r.one("part_of"));
  return props;
}

function event(r: Roles, page: StructuredDataPage): Props {
  const props: Props = {};
  put(props, "name", r.text("name"));
  put(props, "description", r.text("description"));
  put(props, "url", { page: page.pageId });
  put(props, "image", r.one("image"));
  put(props, "startDate", r.date("start"));
  put(props, "endDate", r.date("end"));
  const placeProps: Props = {};
  put(placeProps, "name", r.text("location_name"));
  put(placeProps, "address", r.address());
  const place: StructuredDataScalar | undefined =
    Object.keys(placeProps).length > 0
      ? { node: { type: "Place", properties: placeProps } }
      : undefined;
  const online = r.one("online_url");
  const virtual: StructuredDataScalar | undefined = online
    ? { node: { type: "VirtualLocation", properties: { url: online } } }
    : undefined;
  const locations: StructuredDataScalar[] = [];
  if (place) locations.push(place);
  if (virtual) locations.push(virtual);
  put(props, "location", oneOrMany(locations));
  if (locations.length > 0) {
    const mode = place && virtual ? "Mixed" : virtual ? "Online" : "Offline";
    props.eventAttendanceMode = { schema: `${mode}EventAttendanceMode` };
  }
  put(props, "eventStatus", r.term("status", EVENT_STATUS));
  put(props, "organizer", r.organization("organizer"));
  put(
    props,
    "performer",
    oneOrMany(
      r
        .all("performer")
        .filter((v): v is string => typeof v === "string")
        .map((name) => ({ node: { type: "Person", properties: { name } } })),
    ),
  );
  put(props, "offers", r.offer());
  return props;
}

function jobPosting(r: Roles): Props {
  const props: Props = {};
  put(props, "title", r.text("title"));
  put(props, "description", r.text("description"));
  props.datePosted = r.one("date_posted") ?? { live: "published" };
  put(props, "validThrough", r.one("valid_through"));
  put(props, "employmentType", oneOrMany(r.all("employment_type")));
  put(props, "hiringOrganization", r.organization("hiring_organization"));
  const remote = r.one("remote") === true;
  const address = r.address();
  if (remote) {
    props.jobLocationType = "TELECOMMUTE";
    const country = r.text("country");
    if (country) {
      props.applicantLocationRequirements = {
        node: { type: "Country", properties: { name: country } },
      };
    }
  } else if (address) {
    props.jobLocation = { node: { type: "Place", properties: { address } } };
  }
  const min = r.one("salary_min");
  const max = r.one("salary_max");
  const currency = r.text("salary_currency");
  if ((typeof min === "number" || typeof max === "number") && currency) {
    const value: Props = {};
    put(value, "minValue", typeof min === "number" ? min : undefined);
    put(value, "maxValue", typeof max === "number" ? max : undefined);
    put(value, "unitText", r.text("salary_unit"));
    props.baseSalary = {
      node: {
        type: "MonetaryAmount",
        properties: { currency, value: { node: { type: "QuantitativeValue", properties: value } } },
      },
    };
  }
  return props;
}

function product(r: Roles, page: StructuredDataPage): Props {
  const props: Props = {};
  put(props, "name", r.text("name"));
  put(props, "description", r.text("description"));
  put(props, "url", { page: page.pageId });
  put(props, "image", r.one("image"));
  put(props, "sku", r.text("sku"));
  put(props, "gtin", r.text("gtin"));
  put(props, "brand", r.organization("brand", "Brand"));
  put(props, "offers", r.offer());
  return props;
}

function videoObject(r: Roles): Props {
  const props: Props = {};
  put(props, "name", r.text("name"));
  put(props, "description", r.text("description"));
  put(props, "thumbnailUrl", r.one("thumbnail"));
  props.uploadDate = r.one("upload_date") ?? { live: "published" };
  const duration = r.text("duration");
  if (duration) props.duration = { duration };
  put(props, "contentUrl", r.one("content_url"));
  put(props, "embedUrl", r.one("embed_url"));
  return props;
}

/** The answer for one page of a special template. */
export function entityAnswer(
  ctx: NodeContext,
  page: StructuredDataPage,
  mapping: SchemaMapping,
  spec: SchemaTypeSpec,
): StructuredDataPageAnswer | null {
  const fragment = FRAGMENT[spec.schemaType];
  if (!fragment) return null;
  const r = new Roles(ctx, page, mapping);
  const properties =
    spec.schemaType === "LocalBusiness"
      ? localBusiness(r, page)
      : spec.schemaType === "Event"
        ? event(r, page)
        : spec.schemaType === "JobPosting"
          ? jobPosting(r)
          : spec.schemaType === "Product"
            ? product(r, page)
            : videoObject(r);
  return {
    webPage: { properties: { mainEntity: { ref: { fragment } } } },
    nodes: [{ type: spec.schemaType, id: { fragment }, properties }],
  };
}
