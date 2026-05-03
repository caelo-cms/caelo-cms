// SPDX-License-Identifier: MPL-2.0

/**
 * Zod schemas for the Phase 3 content layer. Lives in @caelo-cms/shared so the
 * Validator (Query API ops) and the SvelteKit form actions can both import
 * from a single source.
 *
 * The Page schemas are `.strict()` — Zod rejects any extra key, which is how
 * the §3.1 "no raw HTML on pages" invariant is enforced *in code*: a payload
 * trying to set `html` on a page fails Zod parse before any handler runs.
 */

import { z } from "zod";

/** Lowercase slug, hyphenated, 1–64 chars, no leading/trailing hyphen. */
export const slugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    "slug must be lowercase letters, digits, or hyphens (1–64 chars, no leading/trailing hyphen)",
  );

/** BCP-47 shape: 2-letter language with optional 2-letter region. P9 widens this. */
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "locale must be 'xx' or 'xx-YY' (BCP-47 shape)");

const displayNameSchema = z.string().min(1).max(128);

/** Caps are arbitrary but cheap — paste-of-binary mistakes get caught. */
export const MODULE_HTML_MAX = 256 * 1024;
export const MODULE_CSS_MAX = 128 * 1024;
export const MODULE_JS_MAX = 256 * 1024;
export const TEMPLATE_HTML_MAX = 512 * 1024;
export const TEMPLATE_CSS_MAX = 128 * 1024;

const moduleHtml = z.string().max(MODULE_HTML_MAX, `html exceeds ${MODULE_HTML_MAX} bytes`);
const moduleCss = z.string().max(MODULE_CSS_MAX, `css exceeds ${MODULE_CSS_MAX} bytes`);
const moduleJs = z.string().max(MODULE_JS_MAX, `js exceeds ${MODULE_JS_MAX} bytes`);

export const moduleCreateSchema = z
  .object({
    slug: slugSchema,
    displayName: displayNameSchema,
    html: moduleHtml,
    css: moduleCss.default(""),
    js: moduleJs.default(""),
  })
  .strict();

export const moduleUpdateSchema = z
  .object({
    moduleId: z.string().uuid(),
    displayName: displayNameSchema.optional(),
    html: moduleHtml.optional(),
    css: moduleCss.optional(),
    js: moduleJs.optional(),
  })
  .strict();

export const templateCreateSchema = z
  .object({
    slug: slugSchema,
    displayName: displayNameSchema,
    html: z.string().max(TEMPLATE_HTML_MAX, `html exceeds ${TEMPLATE_HTML_MAX} bytes`),
    css: z.string().max(TEMPLATE_CSS_MAX, `css exceeds ${TEMPLATE_CSS_MAX} bytes`).default(""),
    /**
     * P6.7.6 — every template binds to one layout. When omitted, the
     * handler resolves to `site_defaults.default_layout_id` at create
     * time. (Stored data, not a render-time fallback — see CLAUDE.md §2.)
     */
    layoutId: z.string().uuid().optional(),
  })
  .strict();

export const templateUpdateSchema = z
  .object({
    templateId: z.string().uuid(),
    displayName: displayNameSchema.optional(),
    html: z.string().max(TEMPLATE_HTML_MAX).optional(),
    css: z.string().max(TEMPLATE_CSS_MAX).optional(),
    /** P6.7.6 — re-point the template to a different layout. */
    layoutId: z.string().uuid().optional(),
  })
  .strict();

export const templateBlockSchema = z
  .object({
    name: slugSchema,
    displayName: displayNameSchema,
    position: z.number().int().nonnegative(),
  })
  .strict();

export const templateBlocksSetSchema = z
  .object({
    templateId: z.string().uuid(),
    blocks: z.array(templateBlockSchema),
  })
  .strict();

export const pageStatusSchema = z.enum(["draft", "published"]);

/**
 * Page payloads are `.strict()` — passing an `html` field is rejected by Zod
 * before the handler runs. This is the §3.1 "no raw HTML on pages" invariant
 * at the Validator boundary, complementing the schema-level guarantee that
 * the `pages` table has no `html` column.
 */
export const pageCreateSchema = z
  .object({
    slug: slugSchema,
    locale: localeSchema.default("en"),
    /** P6.7.5 — internal editor label. Defaults to title if omitted. */
    name: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(256),
    /**
     * P6.7.6 — optional. When omitted, the handler resolves to
     * `site_defaults.default_template_id` at create time. Stored data,
     * not a render-time fallback (CLAUDE.md §2 no-fallbacks).
     */
    templateId: z.string().uuid().optional(),
    status: pageStatusSchema.default("draft"),
  })
  .strict();

export const pageUpdateSchema = z
  .object({
    pageId: z.string().uuid(),
    /**
     * Optional optimistic-concurrency token. When present, the op rejects
     * with HandlerError("Conflict") if the row's version no longer matches.
     * Routes that load the page first should always pass it back.
     */
    expectedVersion: z.number().int().nonnegative().optional(),
    /** P6.7.5 — three independently-editable identifiers. */
    name: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(256).optional(),
    slug: slugSchema.optional(),
    templateId: z.string().uuid().optional(),
    status: pageStatusSchema.optional(),
  })
  .strict();

export const pageSetModulesSchema = z
  .object({
    pageId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative().optional(),
    blocks: z.array(
      z
        .object({
          blockName: slugSchema,
          moduleIds: z.array(z.string().uuid()),
        })
        .strict(),
    ),
  })
  .strict();

export type ModuleCreateInput = z.infer<typeof moduleCreateSchema>;
export type ModuleUpdateInput = z.infer<typeof moduleUpdateSchema>;
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;
export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>;
export type TemplateBlocksSetInput = z.infer<typeof templateBlocksSetSchema>;
export type PageCreateInput = z.infer<typeof pageCreateSchema>;
export type PageUpdateInput = z.infer<typeof pageUpdateSchema>;
export type PageSetModulesInput = z.infer<typeof pageSetModulesSchema>;
