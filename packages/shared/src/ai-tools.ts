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
    slot: z.enum(["brand-voice", "tone", "banned-phrases", "instructions", "glossary"]),
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
    slot: z.enum(["brand-voice", "tone", "banned-phrases", "instructions", "glossary"]),
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

export type EditModuleToolInput = z.infer<typeof editModuleToolInput>;
export type SiteMemoryProposeToolInput = z.infer<typeof siteMemoryProposeToolInput>;
export type ChatCreateSessionInput = z.infer<typeof chatCreateSessionInput>;
export type ChatSendMessageInput = z.infer<typeof chatSendMessageInput>;
export type ChatRenameSessionInput = z.infer<typeof chatRenameSessionInput>;
export type ChatPublishInput = z.infer<typeof chatPublishInput>;
export type AiMemorySetInput = z.infer<typeof aiMemorySetInput>;
export type AiMemoryReviewInput = z.infer<typeof aiMemoryReviewInput>;
export type AiProvidersSetInput = z.infer<typeof aiProvidersSetInput>;
