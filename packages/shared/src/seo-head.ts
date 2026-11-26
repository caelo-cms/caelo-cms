// SPDX-License-Identifier: MPL-2.0

/**
 * #1752 — which value each SEO tag of a page's `<head>` shows, and where it
 * comes from (CMS_REQUIREMENTS §11, CLAUDE.md §1A).
 *
 * A page's own SEO fields win. A page without its own SEO title gets the
 * title template of its page type, or else the site's title template; a
 * page without its own Open Graph texts shares its SEO title (or page
 * title) and meta description. Every resolved value carries its origin, so
 * the AI and the editor see what is set on the page and what it only
 * inherits, and the AI fills real gaps instead of overwriting a person's
 * text or repeating a template on every page.
 *
 * Both templates are stored data (`page_types.definition.seo.titleTemplate`,
 * `site_defaults.seo_title_template`), never values made up at read time
 * (CLAUDE.md §2): the site template always exists (migration 0894 stored
 * `{page_title}`, today's title), a page type's is optional and absent
 * means the page type adds nothing to the site's.
 *
 * {@link resolvePageSeoHead} is THE resolver: the static generator, the
 * editor preview, `pages_seo.get_many` and the editor's SEO panel all call
 * it, so what the AI reads is what a build ships.
 */

import { z } from "zod";

/** A page's own SEO texts; each records who wrote it ({@link SeoOrigins}). */
export const SEO_TEXT_FIELDS = ["seoTitle", "metaDescription", "ogTitle", "ogDescription"] as const;
export type SeoTextField = (typeof SEO_TEXT_FIELDS)[number];

/**
 * Who wrote a page's own SEO text: a person, the AI (a translation
 * included), or the AI and a person confirmed it since.
 */
export const SEO_AUTHORSHIPS = ["human", "ai", "reviewed"] as const;
export type SeoAuthorship = (typeof SEO_AUTHORSHIPS)[number];

/** The authorship of each non-empty own SEO text of a page. */
export type SeoOrigins = Readonly<Partial<Record<SeoTextField, SeoAuthorship>>>;

/** Zod shape of {@link SeoOrigins} as stored (`pages_seo.value_origins`). */
export const seoOriginsSchema = z
  .object({
    seoTitle: z.enum(SEO_AUTHORSHIPS).optional(),
    metaDescription: z.enum(SEO_AUTHORSHIPS).optional(),
    ogTitle: z.enum(SEO_AUTHORSHIPS).optional(),
    ogDescription: z.enum(SEO_AUTHORSHIPS).optional(),
  })
  .strict();

/**
 * Where a resolved head value comes from: the page's own value (`human`,
 * `ai`, `reviewed`), its page type (`page_type`: the type's title template
 * or og:type), the site (`site`: the site's title template, or og:type
 * `website` when the type names none), another value of the same page
 * (`inherited`, with `inheritsFrom`), or nowhere (`unset`).
 */
export const SEO_VALUE_ORIGINS = [
  "human",
  "ai",
  "reviewed",
  "page_type",
  "site",
  "inherited",
  "unset",
] as const;
export type SeoValueOrigin = (typeof SEO_VALUE_ORIGINS)[number];

/** The Open Graph object types a page type can declare. */
export const OG_TYPES = ["website", "article", "profile"] as const;
export type OgType = (typeof OG_TYPES)[number];

/** `max-image-preview` values (Google robots meta). */
export const MAX_IMAGE_PREVIEW_VALUES = ["none", "standard", "large"] as const;
export type MaxImagePreview = (typeof MAX_IMAGE_PREVIEW_VALUES)[number];

/** Upper bounds of the stored texts. Sanity caps, not length advice (the `seo` plugin's hints). */
export const SEO_TITLE_HARD_MAX = 200;
export const OG_TITLE_HARD_MAX = 200;
export const OG_DESCRIPTION_HARD_MAX = 320;
export const TITLE_TEMPLATE_MAX = 200;

/** Variables a title template may use. */
export const TITLE_TEMPLATE_VARIABLES = ["page_title", "short_title", "site_name"] as const;
export type TitleTemplateVariable = (typeof TITLE_TEMPLATE_VARIABLES)[number];

const VARIABLE_SET = new Set<string>(TITLE_TEMPLATE_VARIABLES);

/** Every `{…}` group of a template, with what is inside. */
function* templateTokens(template: string): Generator<{ index: number; name: string }> {
  for (let at = template.indexOf("{"); at !== -1; at = template.indexOf("{", at + 1)) {
    const end = template.indexOf("}", at);
    const next = template.indexOf("{", at + 1);
    yield {
      index: at,
      name: end === -1 || (next !== -1 && next < end) ? "" : template.slice(at + 1, end),
    };
  }
}

/**
 * Why `template` is no valid title template, or null. A template must name
 * the page (`{page_title}` or `{short_title}`), or every page of it would
 * get the same `<title>`; braces only ever enclose a known variable.
 */
export function titleTemplateIssue(template: string): string | null {
  if (template.trim().length === 0) return "a title template cannot be empty";
  if (/[\r\n]/.test(template)) return "a title template is one line";
  for (const t of templateTokens(template)) {
    if (!VARIABLE_SET.has(t.name)) {
      return `"{${t.name}" at position ${t.index} is no variable — use ${TITLE_TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(", ")}; a template holds no other braces`;
    }
  }
  if (template.replace(/\{[a-z_]+\}/g, "").includes("}")) {
    return "a `}` without its `{` — a template holds braces only around a variable";
  }
  if (!template.includes("{page_title}") && !template.includes("{short_title}")) {
    return "a title template must contain {page_title} or {short_title}, or every page it applies to gets the same <title>";
  }
  return null;
}

/** A stored or written title template ({@link titleTemplateIssue}). */
export const titleTemplateSchema = z
  .string()
  .max(TITLE_TEMPLATE_MAX)
  .superRefine((v, ctx) => {
    const issue = titleTemplateIssue(v);
    if (issue !== null) ctx.addIssue({ code: "custom", message: issue });
  });

/** The variables a template uses, in order of first use. */
export function titleTemplateVariables(template: string): TitleTemplateVariable[] {
  const out: TitleTemplateVariable[] = [];
  for (const t of templateTokens(template)) {
    if (VARIABLE_SET.has(t.name) && !out.includes(t.name as TitleTemplateVariable)) {
      out.push(t.name as TitleTemplateVariable);
    }
  }
  return out;
}

/**
 * Fill a title template. A variable without a value here (`{site_name}` on
 * a site without a name) stays in the output as written and is returned in
 * `unset`: loud, never replaced by something else (CLAUDE.md §2).
 */
export function renderTitleTemplate(
  template: string,
  vars: {
    readonly page_title: string;
    readonly short_title: string;
    readonly site_name: string | null;
  },
): { readonly value: string; readonly unset: readonly TitleTemplateVariable[] } {
  const unset: TitleTemplateVariable[] = [];
  const value = template.replace(/\{(page_title|short_title|site_name)\}/g, (raw, name) => {
    const v = vars[name as TitleTemplateVariable];
    if (v === null || v.trim().length === 0) {
      if (!unset.includes(name as TitleTemplateVariable)) unset.push(name as TitleTemplateVariable);
      return raw;
    }
    return v;
  });
  return { value, unset };
}

/** A page type's SEO (`PageTypeDef.seo`); an absent key adds nothing to the site's. */
export const pageTypeSeoSchema = z
  .object({
    /** `<title>` of its pages without their own SEO title. */
    titleTemplate: titleTemplateSchema.optional(),
    /** Its pages' `og:type`. */
    ogType: z.enum(OG_TYPES).optional(),
  })
  .strict();
export type PageTypeSeo = z.infer<typeof pageTypeSeoSchema>;

/** One page's robots directives, as one `<meta name="robots">` renders them. */
export interface RobotsDirectives {
  readonly noindex: boolean;
  readonly nofollow: boolean;
  readonly noarchive: boolean;
  readonly nosnippet: boolean;
  readonly noimageindex: boolean;
  /** Characters of text a snippet may show; -1 = no limit; null = no directive. */
  readonly maxSnippet: number | null;
  readonly maxImagePreview: MaxImagePreview;
  /** Seconds of video a preview may show; -1 = no limit; null = no directive. */
  readonly maxVideoPreview: number | null;
}

/** The `content` of a page's `<meta name="robots">`, directives in a fixed order. */
export function robotsMetaContent(r: RobotsDirectives): string {
  const out: string[] = [];
  if (r.noindex) out.push("noindex");
  if (r.nofollow) out.push("nofollow");
  if (r.noarchive) out.push("noarchive");
  if (r.nosnippet) out.push("nosnippet");
  if (r.noimageindex) out.push("noimageindex");
  if (r.maxSnippet !== null) out.push(`max-snippet:${r.maxSnippet}`);
  out.push(`max-image-preview:${r.maxImagePreview}`);
  if (r.maxVideoPreview !== null) out.push(`max-video-preview:${r.maxVideoPreview}`);
  return out.join(", ");
}

/** A page's own SEO fields the resolver reads. */
export interface PageSeoHeadFields extends RobotsDirectives {
  readonly seoTitle: string;
  readonly metaDescription: string;
  readonly ogTitle: string;
  readonly ogDescription: string;
  /** Complete for every non-empty text ({@link completeSeoOrigins}). */
  readonly origins: SeoOrigins;
}

/**
 * The head fields of a page with no SEO of its own: the `pages_seo` column
 * defaults (migrations 0027, 0894), which a page without a row reads as.
 */
export const PAGE_SEO_HEAD_DEFAULTS: PageSeoHeadFields = Object.freeze({
  seoTitle: "",
  metaDescription: "",
  ogTitle: "",
  ogDescription: "",
  origins: Object.freeze({}),
  noindex: false,
  nofollow: false,
  noarchive: false,
  nosnippet: false,
  noimageindex: false,
  maxSnippet: null,
  maxImagePreview: "large",
  maxVideoPreview: null,
});

/**
 * The authorship of every non-empty own text, and of no empty one. A text
 * without a recorded authorship was written before migration 0894 or by the
 * previous release during an update, neither of which recorded one; it gets
 * the rule 0894 backfilled with: the AI when the page's SEO was ever
 * autofilled or optimized, else a person.
 */
export function completeSeoOrigins(s: {
  readonly seoTitle: string;
  readonly metaDescription: string;
  readonly ogTitle: string;
  readonly ogDescription: string;
  readonly origins: SeoOrigins | null | undefined;
  readonly autofilledAt: string | null;
  readonly optimizedAt: string | null;
}): SeoOrigins {
  const legacy: SeoAuthorship = s.autofilledAt !== null || s.optimizedAt !== null ? "ai" : "human";
  const out: Partial<Record<SeoTextField, SeoAuthorship>> = {};
  for (const f of SEO_TEXT_FIELDS) {
    if (s[f].length === 0) continue;
    out[f] = s.origins?.[f] ?? legacy;
  }
  return out;
}

/** A resolved head value and where it comes from. */
export interface ResolvedSeoValue<V extends string = string> {
  readonly value: V;
  readonly origin: SeoValueOrigin;
}

/** The resolved `<title>`; `template` names the template it was filled from. */
export interface ResolvedSeoTitle extends ResolvedSeoValue {
  readonly template: string | null;
}

/** Every value of a page's SEO head, resolved ({@link resolvePageSeoHead}). */
export interface ResolvedPageSeoHead {
  readonly title: ResolvedSeoTitle;
  readonly metaDescription: ResolvedSeoValue;
  readonly ogTitle: ResolvedSeoValue & { readonly inheritsFrom: "seoTitle" | "pageTitle" | null };
  readonly ogDescription: ResolvedSeoValue & { readonly inheritsFrom: "metaDescription" | null };
  readonly ogType: ResolvedSeoValue<OgType>;
  readonly robots: RobotsDirectives;
  /** Template variables with no value here: they stay raw in the title. */
  readonly unsetVariables: readonly TitleTemplateVariable[];
}

/** What {@link resolvePageSeoHead} resolves from. */
export interface PageSeoHeadSource {
  readonly pageTitle: string;
  readonly shortTitle: string;
  readonly seo: PageSeoHeadFields;
  readonly pageTypeSeo: PageTypeSeo | undefined;
  readonly site: { readonly titleTemplate: string; readonly siteName: string | null };
  /** The 404 page and a paginated overview's follow-up page are never indexed. */
  readonly forceNoindex?: boolean;
}

/** The authorship of a non-empty own text; a gap is a reader that skipped {@link completeSeoOrigins}. */
function own(seo: PageSeoHeadFields, field: SeoTextField): SeoValueOrigin {
  const origin = seo.origins[field];
  if (origin === undefined) {
    throw new Error(
      `resolvePageSeoHead: ${field} has a value but no recorded authorship — complete the origins with completeSeoOrigins when reading the row`,
    );
  }
  return origin;
}

/**
 * Resolve a page's SEO head: site → page type → page, the most specific
 * value winning, each with its origin (see the file header).
 */
export function resolvePageSeoHead(src: PageSeoHeadSource): ResolvedPageSeoHead {
  const { seo } = src;
  let title: ResolvedSeoTitle;
  let unsetVariables: readonly TitleTemplateVariable[] = [];
  if (seo.seoTitle.length > 0) {
    title = { value: seo.seoTitle, origin: own(seo, "seoTitle"), template: null };
  } else {
    const typeTemplate = src.pageTypeSeo?.titleTemplate;
    const template = typeTemplate ?? src.site.titleTemplate;
    const issue = titleTemplateIssue(template);
    if (issue !== null) {
      throw new Error(
        `the ${typeTemplate !== undefined ? "page type's" : "site's"} title template "${template}" is invalid (${issue}) — set it again with set_page_type_seo_many`,
      );
    }
    const rendered = renderTitleTemplate(template, {
      page_title: src.pageTitle,
      short_title: src.shortTitle,
      site_name: src.site.siteName,
    });
    unsetVariables = rendered.unset;
    title = {
      value: rendered.value,
      origin: typeTemplate !== undefined ? "page_type" : "site",
      template,
    };
  }
  const metaDescription: ResolvedSeoValue =
    seo.metaDescription.length > 0
      ? { value: seo.metaDescription, origin: own(seo, "metaDescription") }
      : { value: "", origin: "unset" };
  const ogTitle: ResolvedPageSeoHead["ogTitle"] =
    seo.ogTitle.length > 0
      ? { value: seo.ogTitle, origin: own(seo, "ogTitle"), inheritsFrom: null }
      : seo.seoTitle.length > 0
        ? { value: seo.seoTitle, origin: "inherited", inheritsFrom: "seoTitle" }
        : { value: src.pageTitle, origin: "inherited", inheritsFrom: "pageTitle" };
  const ogDescription: ResolvedPageSeoHead["ogDescription"] =
    seo.ogDescription.length > 0
      ? { value: seo.ogDescription, origin: own(seo, "ogDescription"), inheritsFrom: null }
      : seo.metaDescription.length > 0
        ? { value: seo.metaDescription, origin: "inherited", inheritsFrom: "metaDescription" }
        : { value: "", origin: "unset", inheritsFrom: null };
  const typeOgType = src.pageTypeSeo?.ogType;
  // `website` is the Open Graph protocol's own meaning of a page that
  // declares no type: the site level of the precedence, not a guess.
  const ogType: ResolvedSeoValue<OgType> =
    typeOgType !== undefined
      ? { value: typeOgType, origin: "page_type" }
      : { value: "website", origin: "site" };
  return {
    title,
    metaDescription,
    ogTitle,
    ogDescription,
    ogType,
    robots: {
      noindex: seo.noindex || src.forceNoindex === true,
      nofollow: seo.nofollow,
      noarchive: seo.noarchive,
      nosnippet: seo.nosnippet,
      noimageindex: seo.noimageindex,
      maxSnippet: seo.maxSnippet,
      maxImagePreview: seo.maxImagePreview,
      maxVideoPreview: seo.maxVideoPreview,
    },
    unsetVariables,
  };
}

/**
 * #1752 — the render-failure marker of a title template variable that has
 * no value on a page (`seo-title-variable-unset:site_name`). Content: the
 * page ships the variable raw in its `<title>` on a Stage (as the preview
 * shows it), and Publish live refuses the build.
 */
export const SEO_TITLE_VARIABLE_UNSET = "seo-title-variable-unset";

/** {@link SEO_TITLE_VARIABLE_UNSET} for one variable. */
export function seoTitleVariableMarker(variable: TitleTemplateVariable): string {
  return `${SEO_TITLE_VARIABLE_UNSET}:${variable}`;
}

/** The variable of a {@link seoTitleVariableMarker}, or null for any other reason. */
export function parseSeoTitleVariableMarker(reason: string): TitleTemplateVariable | null {
  const m = /^seo-title-variable-unset:(page_title|short_title|site_name)$/.exec(reason.trim());
  return m ? (m[1] as TitleTemplateVariable) : null;
}

/** An article page's dates (`article:published_time` / `article:modified_time`). */
export interface ArticleTimes {
  readonly publishedTime: string;
  readonly modifiedTime: string;
}

/**
 * The content a build renders for `article:modified_time` before the live
 * comparison has dated the page; {@link setArticleModifiedTime} replaces it
 * in the same build. Never shipped: the generator asserts every page lost it.
 */
export const ARTICLE_MODIFIED_TIME_PENDING = "caelo-article-modified-time-pending";

const ARTICLE_MODIFIED_RE = /<meta property="article:modified_time" content="[^"<>]*" \/>/;

/**
 * Set the `article:modified_time` of a rendered page (the tag
 * `renderSeoHead` wrote): the build once the live comparison dated the
 * page, the plugin-data build when baked data moved its date. A page
 * without the tag (no article) comes back unchanged.
 */
export function setArticleModifiedTime(html: string, iso: string): string {
  return html.replace(
    ARTICLE_MODIFIED_RE,
    `<meta property="article:modified_time" content="${iso.replace(/[&"<>]/g, "")}" />`,
  );
}
