// SPDX-License-Identifier: MPL-2.0

/**
 * Zod schemas for the AI tools shipped in P5. Lives in @caelo/shared so
 * the provider abstraction (which streams tool-call args from the LLM)
 * and the tool dispatcher (which validates + invokes the handler)
 * import from a single source.
 *
 * `.strict()` on every input — the LLM occasionally hallucinates fields
 * and we want a typed rejection at the Validator boundary, not silent
 * silent drops in the handler.
 */

import { z } from "zod";
import { MODULE_CSS_MAX, MODULE_HTML_MAX, MODULE_JS_MAX } from "./content.js";

export const editModuleToolInput = z
  .object({
    moduleId: z.string().uuid(),
    displayName: z.string().min(1).max(128).optional(),
    html: z.string().max(MODULE_HTML_MAX).optional(),
    css: z.string().max(MODULE_CSS_MAX).optional(),
    js: z.string().max(MODULE_JS_MAX).optional(),
  })
  .strict();

export const siteMemoryProposeToolInput = z
  .object({
    slot: z.enum(["purpose", "brand-voice", "tone", "banned-phrases", "instructions", "glossary"]),
    body: z.string().min(1).max(4000),
    rationale: z.string().min(1).max(1000),
  })
  .strict();

/**
 * The set of tools shipped in P5. Other phases extend by adding a new
 * entry; the dispatcher walks this map at registration time.
 */
/**
 * P6.7.3 — `add_module_to_page` AI tool. Creates a new module and
 * inserts it into a target page's block at the requested position. The
 * AI passes html (and optionally css/js) and a sluggable displayName;
 * the tool generates a unique slug.
 */
export const addModuleToPageToolInput = z
  .object({
    pageId: z.string().uuid(),
    blockName: z.string().min(1).max(80),
    /** "top" | "bottom" | a 0-based integer index. */
    position: z.union([z.enum(["top", "bottom"]), z.number().int().min(0).max(1000)]),
    displayName: z.string().min(1).max(128),
    html: z.string().min(1).max(50_000),
    css: z.string().max(50_000).optional(),
    js: z.string().max(50_000).optional(),
  })
  .strict();

/**
 * P6.7.3 — `add_module_to_template` AI tool. Same shape as
 * `add_module_to_page` but fans the new module out to every page using
 * the target template, inserting at the same block + position. Used
 * for "site-wide" content (a global footer, a header banner, etc.).
 */
export const addModuleToTemplateToolInput = z
  .object({
    templateId: z.string().uuid(),
    blockName: z.string().min(1).max(80),
    position: z.union([z.enum(["top", "bottom"]), z.number().int().min(0).max(1000)]),
    displayName: z.string().min(1).max(128),
    html: z.string().min(1).max(50_000),
    css: z.string().max(50_000).optional(),
    js: z.string().max(50_000).optional(),
  })
  .strict();

export const AI_TOOLS = [
  "edit_module",
  "site_memory_propose",
  "add_module_to_page",
  "add_module_to_template",
  "create_page",
  "rename_page",
  "set_page_title",
  "change_page_slug",
  "delete_page",
  "remove_module_from_page",
  "set_structured_set",
  "update_theme",
  "add_module_to_layout",
  "remove_module_from_layout",
  "set_template_layout",
  "create_layout",
  "set_site_defaults",
  "duplicate_page",
  "change_template",
  "move_module",
  "reorder_module",
  "set_nav_menu",
] as const;
export type AiToolName = (typeof AI_TOOLS)[number];
export type AddModuleToPageToolInput = z.infer<typeof addModuleToPageToolInput>;
export type AddModuleToTemplateToolInput = z.infer<typeof addModuleToTemplateToolInput>;

/** Chat ops input shapes — used by the SvelteKit form actions. */
export const chatCreateSessionInput = z
  .object({
    title: z.string().min(1).max(200).optional(),
    /** P6.7.4 — bind the new chat to one page (live-edit surface). */
    pageId: z.string().uuid().optional(),
    /** P6.7.4 — bind the new chat to one template (template editor). */
    templateId: z.string().uuid().optional(),
  })
  .strict();

export const chatSendMessageInput = z
  .object({
    chatSessionId: z.string().uuid(),
    content: z.string().min(1).max(8000),
    /** Element-reference chips appended to the message. */
    chips: z
      .array(
        z
          .object({
            moduleId: z.string().uuid(),
            selector: z.string().min(1).max(500),
            label: z.string().min(1).max(200),
          })
          .strict(),
      )
      .default([]),
    /**
     * P6.7.3 — the active /edit page id, threaded so the chat-runner can
     * compose a Current-page volatile chunk in the system prompt and so
     * tools that operate on a page (add_module_to_page) know the target
     * without a chip. Optional because the standalone chat editor at
     * /content/chat doesn't have a page context.
     */
    activePageId: z.string().uuid().optional(),
  })
  .strict();

export const chatRenameSessionInput = z
  .object({
    chatSessionId: z.string().uuid(),
    title: z.string().min(1).max(200),
  })
  .strict();

export const chatPublishInput = z
  .object({
    chatSessionId: z.string().uuid(),
    /**
     * Optional partial-publish filter (P5.2 #5). When present, only
     * entities listed here are merged into main; the rest stay on the
     * branch for a later publish. Empty array means "publish nothing"
     * and is rejected; omit the field to publish everything.
     */
    entities: z
      .array(
        z
          .object({
            kind: z.enum(["module", "template", "page", "pageLayout"]),
            entityId: z.string().uuid(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
  })
  .strict();

export const aiMemorySetInput = z
  .object({
    slot: z.enum(["purpose", "brand-voice", "tone", "banned-phrases", "instructions", "glossary"]),
    body: z.string().max(4000),
  })
  .strict();

export const aiMemoryReviewInput = z
  .object({
    proposalId: z.string().uuid(),
    decision: z.enum(["accept", "reject"]),
  })
  .strict();

export const aiProvidersSetInput = z
  .object({
    name: z.enum(["anthropic", "openai", "google", "local-openai-compat"]),
    displayName: z.string().min(1).max(100),
    config: z.record(z.string(), z.unknown()).default({}),
    isActive: z.boolean().default(true),
  })
  .strict();

/**
 * P6.7.5 — page-lifecycle tools. Three identifiers, three independent
 * tools so the AI never silently substitutes one for another.
 */
const slugInputSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters/digits/hyphens, leading non-hyphen");

export const createPageToolInput = z
  .object({
    name: z.string().min(1).max(256),
    title: z.string().min(1).max(256),
    slug: slugInputSchema,
    locale: z.string().min(2).max(10).default("en"),
    templateId: z.string().uuid(),
    status: z.enum(["draft", "published"]).default("draft"),
  })
  .strict();

export const renamePageToolInput = z
  .object({
    pageId: z.string().uuid(),
    newName: z.string().min(1).max(256),
  })
  .strict();

export const setPageTitleToolInput = z
  .object({
    pageId: z.string().uuid(),
    newTitle: z.string().min(1).max(256),
  })
  .strict();

export const changePageSlugToolInput = z
  .object({
    pageId: z.string().uuid(),
    newSlug: slugInputSchema,
    /**
     * `auto` (default): create a 301 from the old slug → new slug.
     * `skip`: only choose when the user explicitly says they don't
     * want existing inbound links to redirect.
     */
    redirectFromOld: z.enum(["auto", "skip"]).default("auto"),
  })
  .strict();

export const deletePageToolInput = z
  .object({
    pageId: z.string().uuid(),
    /** '404' returns a not-found; 'redirect' creates a 301 to redirectTo. */
    disposition: z.enum(["404", "redirect"]),
    redirectTo: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (v) => v.disposition === "404" || (v.redirectTo !== undefined && v.redirectTo.length > 0),
    {
      message: "redirectTo is required when disposition='redirect'",
      path: ["redirectTo"],
    },
  );

export const removeModuleFromPageToolInput = z
  .object({
    pageId: z.string().uuid(),
    moduleId: z.string().uuid(),
  })
  .strict();

export const setStructuredSetToolInput = z
  .object({
    kind: z.enum(["nav-menu", "taxonomy", "theme", "tags", "link-list"]),
    slug: slugInputSchema,
    displayName: z.string().min(1).max(200),
    items: z.array(z.unknown()),
  })
  .strict();

export const updateThemeToolInput = z
  .object({
    /** Map of token name to value. Merges into the existing theme/site set. */
    tokens: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * P6.7.6 — layout-layer tools. Layouts are site-wide chrome (header /
 * footer / nav) that wraps every page on every template bound to the
 * layout. `add_module_to_layout` reaches every page across the site
 * with one call; `set_template_layout` re-points a template's chrome.
 * `create_layout` and `set_site_defaults` are Owner-only at the op
 * level — AI calls reject with ActorScopeRejected and the chat surfaces
 * the permission requirement.
 */
export const addModuleToLayoutToolInput = z
  .object({
    layoutSlug: slugInputSchema,
    blockName: z.string().min(1).max(80),
    position: z.union([z.enum(["top", "bottom"]), z.number().int().min(0).max(1000)]),
    displayName: z.string().min(1).max(128),
    html: z.string().min(1).max(50_000),
    css: z.string().max(50_000).optional(),
    js: z.string().max(50_000).optional(),
  })
  .strict();

export const removeModuleFromLayoutToolInput = z
  .object({
    layoutSlug: slugInputSchema,
    moduleId: z.string().uuid(),
  })
  .strict();

export const setTemplateLayoutToolInput = z
  .object({
    templateId: z.string().uuid(),
    layoutSlug: slugInputSchema,
  })
  .strict();

export const createLayoutToolInput = z
  .object({
    slug: slugInputSchema,
    displayName: z.string().min(1).max(200),
    html: z.string().min(1).max(50_000),
    css: z.string().max(50_000).optional(),
    blocks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            displayName: z.string().min(1).max(200),
            position: z.number().int().min(0).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const setSiteDefaultsToolInput = z
  .object({
    defaultLayoutSlug: slugInputSchema.optional(),
    defaultTemplateSlug: slugInputSchema.optional(),
  })
  .strict()
  .refine((v) => v.defaultLayoutSlug !== undefined || v.defaultTemplateSlug !== undefined, {
    message: "must provide at least one of defaultLayoutSlug, defaultTemplateSlug",
  });

/**
 * P6.7.7 — content-ops follow-ups: clone a page, swap a page's
 * template, reorder modules within a block, move a module across
 * blocks. All wrap existing or new ops; the tool layer captures the
 * user-facing intent (which the system prompt steers the AI toward).
 */
export const duplicatePageToolInput = z
  .object({
    sourcePageId: z.string().uuid(),
    newSlug: slugInputSchema,
    newName: z.string().min(1).max(256).optional(),
    newTitle: z.string().min(1).max(256).optional(),
    targetTemplateId: z.string().uuid().optional(),
    locale: z.string().min(2).max(10).optional(),
  })
  .strict();

export const changeTemplateToolInput = z
  .object({
    pageId: z.string().uuid(),
    newTemplateId: z.string().uuid(),
    /**
     * `drop` discards modules in blocks that don't exist on the new
     * template. `preserve-as-block` reroutes them to a named block on
     * the new template (must exist). The AI should ASK the user when
     * the diff would drop modules; only pass `drop` after explicit
     * confirmation.
     */
    orphanDisposition: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("drop") }).strict(),
        z.object({ kind: z.literal("preserve-as-block"), blockName: slugInputSchema }).strict(),
      ])
      .default({ kind: "drop" }),
  })
  .strict();

export const moveModuleToolInput = z
  .object({
    pageId: z.string().uuid(),
    moduleId: z.string().uuid(),
    toBlockName: z.string().min(1).max(80),
    /** "top" | "bottom" | a 0-based index inside the destination block. */
    position: z.union([z.enum(["top", "bottom"]), z.number().int().min(0).max(1000)]),
  })
  .strict();

export const reorderModuleToolInput = z
  .object({
    pageId: z.string().uuid(),
    moduleId: z.string().uuid(),
    /**
     * `up` / `down` shift one slot. An integer is an absolute 0-based
     * target position within the same block.
     */
    direction: z.union([z.enum(["up", "down"]), z.number().int().min(0).max(1000)]),
  })
  .strict();

/**
 * Convenience wrapper over `set_structured_set` for the `nav-menu`
 * kind specifically. Users say "edit the menu", not "set the
 * structured set kind=nav-menu" — this maps natural language to the
 * right tool. Items shape matches `navMenuItem` from
 * @caelo/shared/structured-sets.
 */
export const setNavMenuToolInput = z
  .object({
    slug: slugInputSchema,
    displayName: z.string().min(1).max(200),
    items: z.array(z.unknown()),
  })
  .strict();

/**
 * P7 — `find_media`. Searches the media library by alt-text /
 * filename / mime. Returns up to `limit` matches with the WebP-800
 * URL pre-resolved (or `orig` for non-image kinds). The system prompt
 * already lists recent + frequently-used media; this tool covers the
 * "search for an image of a sunlit office" case where the asset isn't
 * in the recent slice.
 */
export const findMediaToolInput = z
  .object({
    query: z.string().max(256).optional(),
    mime: z
      .enum([
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/avif",
        "image/gif",
        "image/svg+xml",
        "application/pdf",
        "video/mp4",
      ])
      .optional(),
    limit: z.number().int().min(1).max(50).default(15),
  })
  .strict();
export type FindMediaToolInput = z.infer<typeof findMediaToolInput>;

/**
 * P7 — `set_media_alt`. AI may improve a11y on an existing asset
 * without a human round-trip (e.g. when the editor uploaded an image
 * with the default alt and the AI reads its content). Updates only
 * the alt field on `media_assets`.
 */
export const setMediaAltToolInput = z
  .object({
    assetId: z.string().uuid(),
    alt: z.string().max(2048),
  })
  .strict();
export type SetMediaAltToolInput = z.infer<typeof setMediaAltToolInput>;

/**
 * P8 — `set_page_seo`. Manual / panel writes to the per-page SEO
 * sidecar. AI calls this only on explicit user intent
 * ("set the home meta description to ..."). Doesn't bump fingerprints
 * (autofilled_at / optimized_at).
 */
export const setPageSeoToolInput = z
  .object({
    pageId: z.string().uuid(),
    metaDescription: z.string().max(320).optional(),
    ogImageAssetId: z.string().uuid().nullable().optional(),
    canonicalUrl: z.string().max(2048).nullable().optional(),
    noindex: z.boolean().optional(),
    changefreq: z
      .enum(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"])
      .optional(),
    priority: z.number().min(0).max(1).optional(),
  })
  .strict();
export type SetPageSeoToolInput = z.infer<typeof setPageSeoToolInput>;

/**
 * P8 — `autofill_page_seo`. Fill-once. Refuses when the page's SEO
 * was already autofilled. Triggered by the `seo-autofill` skill on
 * the first-publish path.
 */
export const autofillPageSeoToolInput = z
  .object({
    pageId: z.string().uuid(),
    metaDescription: z.string().min(1).max(320),
    ogImageAssetId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type AutofillPageSeoToolInput = z.infer<typeof autofillPageSeoToolInput>;

/**
 * P8 — `optimize_page_seo`. Explicit re-optimization. Always allowed.
 * Takes optional context (keyword analysis / intent shifts / branding
 * changes). The AI can call this across N pages in one chat turn —
 * the resulting changes batch into one Publish-pill confirm.
 */
export const optimizePageSeoToolInput = z
  .object({
    pageId: z.string().uuid(),
    metaDescription: z.string().min(1).max(320),
    ogImageAssetId: z.string().uuid().nullable().optional(),
    context: z.string().max(4000).optional(),
  })
  .strict();
export type OptimizePageSeoToolInput = z.infer<typeof optimizePageSeoToolInput>;

/**
 * P8 AI-first review pass — bulk variants. Per CLAUDE.md §11, bulk
 * tools save round-trips when the AI knows it has N changes to make
 * in a single turn. The handlers run inside one transaction so the
 * batch is all-or-nothing.
 */
export const findRedirectsToolInput = z
  .object({
    query: z.string().max(500).optional(),
    statusCode: z
      .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)])
      .optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type FindRedirectsToolInput = z.infer<typeof findRedirectsToolInput>;

export const bulkCreateRedirectsToolInput = z
  .object({
    redirects: z
      .array(
        z
          .object({
            fromPath: z.string().min(1).max(500),
            toPath: z.string().min(1).max(500),
            statusCode: z
              .union([
                z.literal(301),
                z.literal(302),
                z.literal(307),
                z.literal(308),
                z.literal(410),
              ])
              .default(301),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    upsert: z.boolean().default(false),
  })
  .strict();
export type BulkCreateRedirectsToolInput = z.infer<typeof bulkCreateRedirectsToolInput>;

export const bulkDeleteRedirectsToolInput = z
  .object({
    redirectIds: z.array(z.string().uuid()).max(500).optional(),
    fromPaths: z.array(z.string().min(1).max(500)).max(500).optional(),
    matches: z.string().min(1).max(500).optional(),
  })
  .strict();
export type BulkDeleteRedirectsToolInput = z.infer<typeof bulkDeleteRedirectsToolInput>;

export const bulkOptimizeSeoToolInput = z
  .object({
    updates: z
      .array(
        z
          .object({
            pageId: z.string().uuid(),
            metaDescription: z.string().min(1).max(320),
            ogImageAssetId: z.string().uuid().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    context: z.string().max(4000).optional(),
  })
  .strict();
export type BulkOptimizeSeoToolInput = z.infer<typeof bulkOptimizeSeoToolInput>;

export type EditModuleToolInput = z.infer<typeof editModuleToolInput>;
export type SiteMemoryProposeToolInput = z.infer<typeof siteMemoryProposeToolInput>;
export type CreatePageToolInput = z.infer<typeof createPageToolInput>;
export type RenamePageToolInput = z.infer<typeof renamePageToolInput>;
export type SetPageTitleToolInput = z.infer<typeof setPageTitleToolInput>;
export type ChangePageSlugToolInput = z.infer<typeof changePageSlugToolInput>;
export type DeletePageToolInput = z.infer<typeof deletePageToolInput>;
export type RemoveModuleFromPageToolInput = z.infer<typeof removeModuleFromPageToolInput>;
export type SetStructuredSetToolInput = z.infer<typeof setStructuredSetToolInput>;
export type UpdateThemeToolInput = z.infer<typeof updateThemeToolInput>;
export type ChatCreateSessionInput = z.infer<typeof chatCreateSessionInput>;
export type ChatSendMessageInput = z.infer<typeof chatSendMessageInput>;
export type ChatRenameSessionInput = z.infer<typeof chatRenameSessionInput>;
export type ChatPublishInput = z.infer<typeof chatPublishInput>;
export type AiMemorySetInput = z.infer<typeof aiMemorySetInput>;
export type AiMemoryReviewInput = z.infer<typeof aiMemoryReviewInput>;
export type AiProvidersSetInput = z.infer<typeof aiProvidersSetInput>;
export type AddModuleToLayoutToolInput = z.infer<typeof addModuleToLayoutToolInput>;
export type RemoveModuleFromLayoutToolInput = z.infer<typeof removeModuleFromLayoutToolInput>;
export type SetTemplateLayoutToolInput = z.infer<typeof setTemplateLayoutToolInput>;
export type CreateLayoutToolInput = z.infer<typeof createLayoutToolInput>;
export type SetSiteDefaultsToolInput = z.infer<typeof setSiteDefaultsToolInput>;
export type DuplicatePageToolInput = z.infer<typeof duplicatePageToolInput>;
export type ChangeTemplateToolInput = z.infer<typeof changeTemplateToolInput>;
export type MoveModuleToolInput = z.infer<typeof moveModuleToolInput>;
export type ReorderModuleToolInput = z.infer<typeof reorderModuleToolInput>;
export type SetNavMenuToolInput = z.infer<typeof setNavMenuToolInput>;
