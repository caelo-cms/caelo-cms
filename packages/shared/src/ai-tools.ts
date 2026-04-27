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
