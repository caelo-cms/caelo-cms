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

/**
 * v0.4.0 — module field schema. Each field declares one substitution slot in
 * the module's templated HTML (`{{fieldName}}`) and the kind of content it
 * holds. Field values live on each page placement (v0.4.0: in
 * `page_module_content.content_values`; v0.12.0 onward: in
 * `content_instances.values`).
 *
 * v0.12.0 — extended to nine kinds. Primitive kinds (text/richtext/url/
 * image/number/boolean/link) substitute via `{{fieldName}}` placeholders.
 * The two new nested kinds reference another module by id + content_instance:
 *
 *   - `module` — single nested module reference. HTML slot syntax: `{{>fieldName}}`.
 *     Value shape: `{ moduleId, contentInstanceId }`.
 *   - `module-list` — ordered array of nested module references. HTML slot
 *     syntax: `{{#fieldName}}…inner…{{/fieldName}}` — `inner` renders once
 *     per element. Value shape: `Array<{ moduleId, contentInstanceId }>`.
 *
 * Schema is a discriminated union by `kind` so the validator rejects, e.g., a
 * `text` kind that carries `allowedModuleSlugs` (which only nested kinds use)
 * or a `module-list` that carries a `default` (nested kinds populate from
 * referenced content_instances, not from defaults).
 */
export const MODULE_FIELD_PRIMITIVE_KINDS = [
  "text",
  "richtext",
  "url",
  "image",
  "number",
  "boolean",
  "link",
] as const;

/**
 * v0.12.0 — list-of-primitive field kinds. The grammar mirrors
 * `module-list`'s `{{#field}}{{/field}}` iteration but the elements
 * are primitives (or a fixed {label,href} pair for link-list), not
 * `{moduleId, contentInstanceId}` refs.
 *
 * Use `text-list` for "list of strings" — menu labels, tag chips,
 * bullet points where each item is just text. Inner template
 * references `{{.}}` (Mustache convention) or `{{item}}` to mean
 * the current element.
 *
 * Use `link-list` for "list of links" — primary nav, footer columns,
 * sidebar menus. Each element is `{href, label}`. Inner template
 * uses `{{href}}` + `{{label}}` per iteration.
 *
 * For lists with richer per-item structure (cards with image + title
 * + body + CTA), use `module-list` pointing at a sub-module — that's
 * what nested modules are for.
 */
export const MODULE_FIELD_LIST_KINDS = ["text-list", "link-list"] as const;

export const MODULE_FIELD_NESTED_KINDS = ["module", "module-list"] as const;

/** All eleven v0.12.0 kinds. */
export const MODULE_FIELD_KINDS = [
  ...MODULE_FIELD_PRIMITIVE_KINDS,
  ...MODULE_FIELD_LIST_KINDS,
  ...MODULE_FIELD_NESTED_KINDS,
] as const;

const moduleFieldName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "name must be snake_case");
const moduleFieldLabel = z.string().min(1).max(128);

const moduleFieldPrimitiveSchema = z
  .object({
    name: moduleFieldName,
    kind: z.enum(MODULE_FIELD_PRIMITIVE_KINDS),
    label: moduleFieldLabel,
    /** Default value used when a placement's content_instance has no override. */
    default: z.unknown().optional(),
  })
  .strict();

const moduleFieldModuleSchema = z
  .object({
    name: moduleFieldName,
    kind: z.literal("module"),
    label: moduleFieldLabel,
    /**
     * Optional whitelist of module slugs that may fill this slot. When
     * absent, any module is permitted. The op-layer validator enforces
     * the whitelist at `set_content_instance_values` time.
     */
    allowedModuleSlugs: z.array(slugSchema).max(32).optional(),
  })
  .strict();

const moduleFieldModuleListSchema = z
  .object({
    name: moduleFieldName,
    kind: z.literal("module-list"),
    label: moduleFieldLabel,
    allowedModuleSlugs: z.array(slugSchema).max(32).optional(),
    /** Minimum count of elements. Validator enforces at write time. */
    min: z.number().int().nonnegative().optional(),
    /** Maximum count of elements. Validator enforces at write time. */
    max: z.number().int().positive().max(256).optional(),
  })
  .strict();

/**
 * v0.12.0 — list-of-strings field. Inner template uses `{{.}}` (or
 * the alias `{{item}}`) to reference the current element. Default
 * is an optional array of strings rendered when the placement's
 * content_instance has no override.
 */
const moduleFieldTextListSchema = z
  .object({
    name: moduleFieldName,
    kind: z.literal("text-list"),
    label: moduleFieldLabel,
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().max(256).optional(),
    default: z.array(z.string()).optional(),
  })
  .strict();

/**
 * v0.12.0 — list-of-{label,href} field. Inner template uses
 * `{{label}}` + `{{href}}` per iteration. Targets the common
 * primary-nav / footer-column / sidebar-menu pattern without
 * forcing a sub-module per link.
 */
const moduleFieldLinkListSchema = z
  .object({
    name: moduleFieldName,
    kind: z.literal("link-list"),
    label: moduleFieldLabel,
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().max(256).optional(),
    default: z.array(z.object({ label: z.string(), href: z.string() }).strict()).optional(),
  })
  .strict();

export const moduleFieldSchema = z.discriminatedUnion("kind", [
  moduleFieldPrimitiveSchema,
  moduleFieldTextListSchema,
  moduleFieldLinkListSchema,
  moduleFieldModuleSchema,
  moduleFieldModuleListSchema,
]);
export type ModuleField = z.infer<typeof moduleFieldSchema>;

/**
 * The shape of a single nested-module reference inside `content_instances.values`
 * when the field's kind is `module` or — repeated inside an array — `module-list`.
 */
export const moduleRefSchema = z
  .object({
    moduleId: z.string().uuid(),
    contentInstanceId: z.string().uuid(),
  })
  .strict();
export type ModuleRef = z.infer<typeof moduleRefSchema>;

const moduleFieldsArray = z
  .array(moduleFieldSchema)
  .max(64, "modules may declare at most 64 fields")
  .superRefine((arr, ctx) => {
    const seen = new Set<string>();
    for (const f of arr) {
      if (seen.has(f.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field name: ${f.name}` });
        return;
      }
      seen.add(f.name);
    }
  });

/**
 * v0.12.0 — coarse role tag for the AI's `## Modules` catalog block.
 * Constrained by `modules_kind_check` in migration 0095. Adding a
 * new kind means: (1) bump the SQL CHECK, (2) update this schema,
 * (3) update formatModulesBlock so the AI knows when to use it.
 */
export const MODULE_KINDS = ["chrome", "hero", "content", "cta", "utility"] as const;
export const moduleKindSchema = z.enum(MODULE_KINDS);
export type ModuleKind = (typeof MODULE_KINDS)[number];

/**
 * v0.12.0 — description is `.default("")` at the Zod boundary so the
 * 82+ legacy callers in tests/seed scripts keep working unchanged.
 * AI tool descriptions (create_module / edit_module) require the AI
 * to supply a real description explicitly — see CLAUDE.md §1A.
 */
const moduleDescription = z.string().max(1000);

export const moduleCreateSchema = z
  .object({
    slug: slugSchema,
    displayName: displayNameSchema,
    description: moduleDescription.default(""),
    kind: moduleKindSchema.default("content"),
    html: moduleHtml,
    css: moduleCss.default(""),
    js: moduleJs.default(""),
    fields: moduleFieldsArray.default([]),
  })
  .strict();

export const moduleUpdateSchema = z
  .object({
    moduleId: z.string().uuid(),
    displayName: displayNameSchema.optional(),
    description: moduleDescription.optional(),
    kind: moduleKindSchema.optional(),
    html: moduleHtml.optional(),
    css: moduleCss.optional(),
    js: moduleJs.optional(),
    fields: moduleFieldsArray.optional(),
  })
  .strict();

/**
 * v0.12.0 — page-type tag pages inherit from their template.
 * Constrained by templates_kind_check in migration 0096. Surfaced
 * in the AI's `## Pages` block so the AI sees three modules-on-
 * product-pages as a pattern. See CLAUDE.md §1A.
 */
export const TEMPLATE_KINDS = [
  "home",
  "landing",
  "product",
  "blog",
  "doc",
  "content",
  "utility",
] as const;
export const templateKindSchema = z.enum(TEMPLATE_KINDS);
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const templateCreateSchema = z
  .object({
    slug: slugSchema,
    displayName: displayNameSchema,
    /** v0.12.0 — what kind of page binds to this template. */
    kind: templateKindSchema.default("content"),
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

export const templateBlockSchema = z
  .object({
    name: slugSchema,
    displayName: displayNameSchema,
    position: z.number().int().nonnegative(),
  })
  .strict();

export const templateUpdateSchema = z
  .object({
    templateId: z.string().uuid(),
    displayName: displayNameSchema.optional(),
    /** v0.12.0 — re-classify the template's page-type kind. */
    kind: templateKindSchema.optional(),
    html: z.string().max(TEMPLATE_HTML_MAX).optional(),
    css: z.string().max(TEMPLATE_CSS_MAX).optional(),
    /** P6.7.6 — re-point the template to a different layout. */
    layoutId: z.string().uuid().optional(),
    /**
     * v0.2.65 — Optional block-set replacement. When present, the
     * update atomically applies the provided block list to
     * `template_blocks` (DELETE-then-INSERT, same path as
     * `template_blocks.set`). Critical for AI-driven flows: the AI's
     * `propose_update_template` previously only wrote the html string
     * and never touched the block table, so an approved proposal that
     * added `<!-- block:content -->` markup left the page unable to
     * find a "content" block. Allowing blocks here lets one
     * propose+execute round add both the markup AND the block
     * definition atomically.
     */
    blocks: z.array(templateBlockSchema).optional(),
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

// ─── v0.12.0 — content_instances ops ─────────────────────────────────

/**
 * v0.12.0 — content sync mode on a placement.
 *
 * `synced`   — editing the placement's content_instance propagates to
 *              every other placement bound to the same row.
 * `unsynced` — placement holds a private row. Default.
 */
export const syncModeSchema = z.enum(["synced", "unsynced"]);
export type SyncMode = z.infer<typeof syncModeSchema>;

/**
 * `values` jsonb shape — keyed by module field name. Values are arbitrary
 * jsonb. For nested-module field kinds, the value satisfies `moduleRefSchema`
 * (single) or `moduleRefSchema[]` (list); the renderer + write-side validator
 * enforces shape against the module's declared `fields[]`.
 */
const contentValuesSchema = z.record(z.string(), z.unknown());

/**
 * v0.12.0 — why this row exists as a shared/reusable instance.
 * Surfaced in the `## Content Library` system-prompt block so the AI
 * can decide *reuse the synced row* vs *fork to unsynced* vs *mint
 * new* without a tool round-trip. Required by the AI's
 * create_content_instance tool description; legacy callers may pass
 * null (the migration-0093 unsynced rows have purpose=NULL).
 * See CLAUDE.md §1A.
 */
const contentInstancePurpose = z.string().max(1000);

export const contentInstanceCreateSchema = z
  .object({
    moduleId: z.string().uuid(),
    slug: slugSchema.optional(),
    displayName: z.string().min(1).max(128).optional(),
    purpose: contentInstancePurpose.optional(),
    values: contentValuesSchema.default({}),
  })
  .strict();

export const contentInstanceUpdateSchema = z
  .object({
    id: z.string().uuid(),
    /** Fully replaces existing values. */
    values: contentValuesSchema,
    /** Optional optimistic-concurrency token; mirrors pages.update. */
    expectedVersion: z.number().int().nonnegative().optional(),
    /** Optional rename in the same write; mirrors how pages.update accepts metadata edits. */
    slug: slugSchema.nullable().optional(),
    displayName: z.string().min(1).max(128).nullable().optional(),
    /** v0.12.0 — rewrite the purpose (or clear via null). */
    purpose: contentInstancePurpose.nullable().optional(),
  })
  .strict();

export const contentInstanceDeleteSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const setPlacementContentSchema = z
  .object({
    pageId: z.string().uuid(),
    blockName: z.string().min(1).max(80),
    position: z.number().int().nonnegative(),
    contentInstanceId: z.string().uuid(),
    syncMode: syncModeSchema,
  })
  .strict();

export const forkPlacementContentSchema = z
  .object({
    pageId: z.string().uuid(),
    blockName: z.string().min(1).max(80),
    position: z.number().int().nonnegative(),
  })
  .strict();

export type ContentInstanceCreateInput = z.infer<typeof contentInstanceCreateSchema>;
export type ContentInstanceUpdateInput = z.infer<typeof contentInstanceUpdateSchema>;
export type ContentInstanceDeleteInput = z.infer<typeof contentInstanceDeleteSchema>;
export type SetPlacementContentInput = z.infer<typeof setPlacementContentSchema>;
export type ForkPlacementContentInput = z.infer<typeof forkPlacementContentSchema>;
