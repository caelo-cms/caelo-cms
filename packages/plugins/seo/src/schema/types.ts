// SPDX-License-Identifier: MPL-2.0

/**
 * The schema types a page type can be mapped to, and what each reads (epic
 * #1751, #1756, #1761). This is the SEO knowledge that changes with search
 * engines (Google dropped several types in 2025/2026), so it lives in the
 * plugin; core only checks and serializes the nodes.
 *
 * A mapping names a schema type for a page type and, per role, where the
 * value comes from: a page property (`prop:<name>`) or a core field of the
 * page (`title`, `short_title`, `description`, `share_image`) or the
 * site's Organization (`organization`). Values only come from what the page
 * shows (Google: markup must match the visible text), which is why the
 * sources are the page's own fields: the AI builds the modules that show
 * them.
 *
 * `required` and `recommended` are Google's properties for the rich result
 * the type is eligible for (search gallery, November 2026). Required ones
 * missing are objective findings; recommended ones are write hints
 * (maintainer decision 2026-11-26).
 */

/** Where a role's value may come from. */
export type SourceKind =
  | "text"
  | "richtext"
  | "number"
  | "date"
  | "media"
  | "page"
  | "link"
  | "select"
  | "boolean"
  | "term"
  | "organization";

/** The core fields a role may read instead of a property, and what kind of value each is. */
export const CORE_SOURCES = {
  title: "text",
  short_title: "text",
  description: "text",
  share_image: "media",
  organization: "organization",
} as const satisfies Record<string, SourceKind>;

/** A core field a role may read. */
export type CoreSource = keyof typeof CORE_SOURCES;

/** One value a mapping reads for a schema type. */
export interface SchemaRole {
  /** What the value says, for the AI choosing a property. */
  readonly description: string;
  /** The kinds of source that fit. */
  readonly accepts: readonly SourceKind[];
  /** Several sources (each a property) whose values add up, e.g. profile links. */
  readonly multiple?: boolean;
  /** The source when the mapping names none. */
  readonly default?: CoreSource;
}

/** How the plugin turns a page of the type into nodes. */
export type SchemaBuilder = "article" | "profile" | "collection" | "webpage" | "entity";

/** One schema type a page type can be mapped to. */
export interface SchemaTypeSpec {
  /** The schema.org type of the page's main node. */
  readonly schemaType: string;
  readonly builder: SchemaBuilder;
  /** When to pick it, for the AI. */
  readonly use: string;
  readonly roles: Readonly<Record<string, SchemaRole>>;
  /** Google's required properties of the main node (findings when missing). */
  readonly required: readonly string[];
  /** Google's recommended properties (write hints when missing). */
  readonly recommended: readonly string[];
}

const IMAGE: SchemaRole = {
  description:
    "The image the page shows for it (an image property); default the page's share image.",
  accepts: ["media"],
  default: "share_image",
};

const REVIEW_ROLES = {
  reviewer: {
    description:
      "Who checked the content: a page property naming the reviewer's own page (`reviewedBy`).",
    accepts: ["page"],
  },
  reviewed_on: {
    description:
      "When it was checked: a date property the page SHOWS (`lastReviewed`). Google wants the date visible.",
    accepts: ["date"],
  },
} as const satisfies Record<string, SchemaRole>;

const ARTICLE_ROLES = {
  authors: {
    description:
      "Who wrote it: a page property naming the authors' own pages, in order (`author`, each a Person).",
    accepts: ["page"],
  },
  image: IMAGE,
  ...REVIEW_ROLES,
} as const satisfies Record<string, SchemaRole>;

const ARTICLE_RECOMMENDED = ["author", "datePublished", "dateModified", "headline", "image"];

/** A postal address (`PostalAddress`), each part a text property. */
const ADDRESS_ROLES = {
  street_address: { description: "Street and number (`streetAddress`).", accepts: ["text"] },
  locality: { description: "City (`addressLocality`).", accepts: ["text"] },
  postal_code: { description: "Postal code (`postalCode`).", accepts: ["text"] },
  region: { description: "Region or state (`addressRegion`).", accepts: ["text"] },
  country: {
    description: "Country as ISO 3166 code (`addressCountry`, `DE`).",
    accepts: ["text", "select"],
  },
} as const satisfies Record<string, SchemaRole>;

/** An offer (`Offer`): what it costs and where to get it. */
const OFFER_ROLES = {
  price: { description: "The price as a number property (`offers.price`).", accepts: ["number"] },
  currency: {
    description: "ISO 4217 currency (`offers.priceCurrency`, `EUR`).",
    accepts: ["text", "select"],
  },
  availability: {
    description:
      "A select property with one of in_stock, out_of_stock, pre_order, sold_out, limited (`offers.availability`).",
    accepts: ["select"],
  },
  offer_url: {
    description: "Where to buy or book (`offers.url`): a link property.",
    accepts: ["link"],
  },
} as const satisfies Record<string, SchemaRole>;

/** Every schema type a page type can be mapped to, by its schema.org name. */
export const SCHEMA_TYPES: Readonly<Record<string, SchemaTypeSpec>> = {
  Article: {
    schemaType: "Article",
    builder: "article",
    use: "Editorial content that is neither news nor a blog post: guides, explainers, reports.",
    roles: ARTICLE_ROLES,
    required: [],
    recommended: ARTICLE_RECOMMENDED,
  },
  BlogPosting: {
    schemaType: "BlogPosting",
    builder: "article",
    use: "A post of a blog.",
    roles: ARTICLE_ROLES,
    required: [],
    recommended: ARTICLE_RECOMMENDED,
  },
  NewsArticle: {
    schemaType: "NewsArticle",
    builder: "article",
    use: "News: a report of current events, dated. Its pages also enter the news sitemap.",
    roles: ARTICLE_ROLES,
    required: [],
    recommended: ARTICLE_RECOMMENDED,
  },
  ProfilePage: {
    schemaType: "Person",
    builder: "profile",
    use: "A page about one person: an author, a team member, a speaker. Its Person is what articles name as author.",
    roles: {
      name: {
        description: "The person's name; default the page's short title.",
        accepts: ["text"],
        default: "short_title",
      },
      job_title: { description: "Their role (`jobTitle`).", accepts: ["text"] },
      image: {
        ...IMAGE,
        description: "Their portrait (an image property); default the share image.",
      },
      bio: {
        description:
          "A short biography the page shows (`description`); default the meta description.",
        accepts: ["text", "richtext"],
        default: "description",
      },
      same_as: {
        description:
          "Their profiles on other sites (`sameAs`): link properties, each one profile (LinkedIn, Mastodon, a personal site).",
        accepts: ["link"],
        multiple: true,
      },
      works_for: {
        description:
          "Who they work for (`worksFor`): `organization` (the site's own) or a text property with a company name.",
        accepts: ["organization", "text"],
      },
      knows_about: {
        description: "Their subjects (`knowsAbout`): a text or term property.",
        accepts: ["text", "term"],
        multiple: true,
      },
    },
    required: ["name"],
    recommended: ["image", "sameAs", "description"],
  },
  CollectionPage: {
    schemaType: "ItemList",
    builder: "collection",
    use: "An overview listing other pages: a topic page, a category page, an author's article list. The list is what the page shows.",
    roles: {},
    required: ["itemListElement"],
    recommended: [],
  },
  WebPage: {
    schemaType: "WebPage",
    builder: "webpage",
    use: "Any other page. Only adds who reviewed it and when, if mapped.",
    roles: REVIEW_ROLES,
    required: [],
    recommended: [],
  },
  // #1761 — special templates, used only when a site has such pages.
  LocalBusiness: {
    schemaType: "LocalBusiness",
    builder: "entity",
    use: "One location of a business visitors come to (a shop, an office, a practice): one page per location, so several locations are several pages.",
    roles: {
      name: {
        description: "The location's name; default the page title.",
        accepts: ["text"],
        default: "title",
      },
      image: IMAGE,
      ...ADDRESS_ROLES,
      telephone: { description: "Its phone number (`telephone`).", accepts: ["text"] },
      opening_hours: {
        description:
          "Opening hours (`openingHours`), each text in schema.org's short form: `Mo-Fr 09:00-18:00`, `Sa 10:00-14:00`.",
        accepts: ["text"],
        multiple: true,
      },
      price_range: { description: "Its price range (`priceRange`, e.g. `€€`).", accepts: ["text"] },
      latitude: { description: "Latitude (`geo`).", accepts: ["number"] },
      longitude: { description: "Longitude (`geo`).", accepts: ["number"] },
      part_of: {
        description:
          "`organization`: the location belongs to the site's Organization (`parentOrganization`).",
        accepts: ["organization"],
      },
    },
    required: ["address", "name"],
    recommended: ["geo", "openingHours", "priceRange", "telephone", "url", "image"],
  },
  Event: {
    schemaType: "Event",
    builder: "entity",
    use: "One event with a date: a talk, a webinar, a concert, a meetup.",
    roles: {
      name: {
        description: "The event's name; default the page title.",
        accepts: ["text"],
        default: "title",
      },
      description: {
        description: "What it is about; default the meta description.",
        accepts: ["text", "richtext"],
        default: "description",
      },
      image: IMAGE,
      start: {
        description:
          "When it starts (`startDate`): a date property, or a text property holding an ISO date-time with its offset (`2026-12-01T19:00+01:00`).",
        accepts: ["date", "text"],
      },
      end: { description: "When it ends (`endDate`), like start.", accepts: ["date", "text"] },
      location_name: {
        description: "Where it takes place (`location` Place name).",
        accepts: ["text"],
      },
      ...ADDRESS_ROLES,
      online_url: {
        description:
          "The address of the online event (`location` VirtualLocation); with a place it is a mixed event.",
        accepts: ["link"],
      },
      status: {
        description:
          "A select property with one of scheduled, cancelled, postponed, rescheduled, moved_online (`eventStatus`).",
        accepts: ["select"],
      },
      organizer: {
        description:
          "Who organises it (`organizer`): `organization` or a text property with a name.",
        accepts: ["organization", "text"],
      },
      performer: {
        description: "Who performs or speaks (`performer`): a text property.",
        accepts: ["text"],
        multiple: true,
      },
      ...OFFER_ROLES,
    },
    required: ["location", "name", "startDate"],
    recommended: [
      "description",
      "endDate",
      "eventStatus",
      "image",
      "offers",
      "organizer",
      "performer",
    ],
  },
  JobPosting: {
    schemaType: "JobPosting",
    builder: "entity",
    use: "One open position. Remove its page (or set valid_through) when it is filled.",
    roles: {
      title: {
        description: "The job title; default the page title.",
        accepts: ["text"],
        default: "title",
      },
      description: {
        description: "The full job description the page shows; default the meta description.",
        accepts: ["text", "richtext"],
        default: "description",
      },
      date_posted: {
        description: "When it was posted (`datePosted`); default the date the page went live.",
        accepts: ["date"],
      },
      valid_through: { description: "The last day to apply (`validThrough`).", accepts: ["date"] },
      employment_type: {
        description:
          "A select or text property: FULL_TIME, PART_TIME, CONTRACTOR, TEMPORARY, INTERN … (`employmentType`).",
        accepts: ["select", "text"],
        multiple: true,
      },
      hiring_organization: {
        description:
          "Who hires (`hiringOrganization`): `organization` (default the site's) or a text property.",
        accepts: ["organization", "text"],
        default: "organization",
      },
      ...ADDRESS_ROLES,
      remote: {
        description:
          "A boolean property: true when the job is fully remote (`jobLocationType` TELECOMMUTE).",
        accepts: ["boolean"],
      },
      salary_min: { description: "Lowest salary (`baseSalary`).", accepts: ["number"] },
      salary_max: { description: "Highest salary (`baseSalary`).", accepts: ["number"] },
      salary_currency: {
        description: "ISO 4217 currency of the salary (`EUR`).",
        accepts: ["text", "select"],
      },
      salary_unit: {
        description: "A select or text property: HOUR, DAY, WEEK, MONTH or YEAR.",
        accepts: ["select", "text"],
      },
    },
    required: ["datePosted", "description", "hiringOrganization", "jobLocation", "title"],
    recommended: ["baseSalary", "employmentType", "validThrough"],
  },
  Product: {
    schemaType: "Product",
    builder: "entity",
    use: "One product page. Its offer (price, availability) must be the data of the site's shop: the shop plugin keeps those properties current.",
    roles: {
      name: {
        description: "The product's name; default the page title.",
        accepts: ["text"],
        default: "title",
      },
      description: {
        description: "What it is; default the meta description.",
        accepts: ["text", "richtext"],
        default: "description",
      },
      image: IMAGE,
      sku: { description: "Its SKU.", accepts: ["text"] },
      gtin: { description: "Its GTIN / EAN.", accepts: ["text"] },
      brand: {
        description: "Its brand (`brand`): a text property, or `organization` for the site's own.",
        accepts: ["text", "organization"],
      },
      ...OFFER_ROLES,
    },
    required: ["name", "offers"],
    recommended: ["brand", "description", "gtin", "image", "sku"],
  },
  VideoObject: {
    schemaType: "VideoObject",
    builder: "entity",
    use: "A page whose main content is one video. Its page also enters the video sitemap.",
    roles: {
      name: {
        description: "The video's title; default the page title.",
        accepts: ["text"],
        default: "title",
      },
      description: {
        description: "What it shows; default the meta description.",
        accepts: ["text", "richtext"],
        default: "description",
      },
      thumbnail: {
        description: "Its thumbnail (`thumbnailUrl`, an image property); default the share image.",
        accepts: ["media"],
        default: "share_image",
      },
      upload_date: {
        description: "When it was published (`uploadDate`); default the date the page went live.",
        accepts: ["date"],
      },
      duration: {
        description: "Its length as an ISO 8601 duration in a text property (`PT4M13S`).",
        accepts: ["text"],
      },
      content_url: {
        description: "The video file's address on a video host (`contentUrl`), a link property.",
        accepts: ["link"],
      },
      embed_url: {
        description: "The player's address on a video host (`embedUrl`), a link property.",
        accepts: ["link"],
      },
    },
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["contentUrl", "description", "duration", "embedUrl"],
  },
};

/** The schema types a mapping may name. */
export const SCHEMA_TYPE_NAMES: readonly string[] = Object.keys(SCHEMA_TYPES);
