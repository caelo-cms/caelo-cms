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
};

/** The schema types a mapping may name. */
export const SCHEMA_TYPE_NAMES: readonly string[] = Object.keys(SCHEMA_TYPES);
