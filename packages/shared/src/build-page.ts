// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — bulk build-path schemas (CLAUDE.md §11 bulk-first).
 *
 * Run #15 telemetry showed the AI assembling ~14 pages through ~100
 * singular round-trips (36× add_module_to_page, 29× set_page_module_content,
 * 9× create_content_instance, 8× create_page) at 110K–556K input tokens
 * per call. These schemas back the three ops that collapse that chain:
 *
 *   - `pages.build_page`                — ONE call: page (new or existing)
 *     + ordered modules + content instances + placements, one transaction.
 *   - `content_instances.create_many`   — batch instance minting.
 *   - `page_module_content.set_many`    — batch content fill on existing
 *     placements.
 *
 * All three are all-or-nothing: any validation error aborts the whole
 * call with a message naming the failing element index (and field where
 * one is involved), so partial failure is impossible (§11).
 */

import { z } from "zod";
import {
  contentInstanceCreateSchema,
  localeSchema,
  MODULE_CSS_MAX,
  MODULE_HTML_MAX,
  MODULE_JS_MAX,
  moduleFieldSchema,
  moduleKindSchema,
  pageStatusSchema,
  slugSchema,
  syncModeSchema,
} from "./content.js";

/** Content values keyed by the module's declared field names. */
const contentValuesSchema = z.record(z.string(), z.unknown());

/**
 * Per-module content payload — a discriminated union mirroring the three
 * existing content paths so build_page adds NO new semantics, only batching:
 *
 *   - `inline`   → mint a private (unsynced) content_instance carrying
 *     `values`, exactly what `set_page_module_content` produces for a
 *     fresh placement.
 *   - `shared`   → mint a reusable content_instance (purpose required —
 *     same decision-support contract as `create_content_instance`) and
 *     bind this placement to it, `synced` by default.
 *   - `existing` → bind an already-minted content_instance (reuse-first
 *     per CLAUDE.md §1A) — the batched form of `set_placement_content`.
 *
 * Omitting `content` mints an empty unsynced instance, matching what
 * `pages.set_modules` does for a net-new placement today.
 */
export const buildPageContentSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("inline"),
      values: contentValuesSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("shared"),
      values: contentValuesSchema.default({}),
      /** Why this row exists as a shared instance — see CLAUDE.md §1A. */
      purpose: z.string().min(1).max(1000),
      slug: slugSchema.optional(),
      displayName: z.string().min(1).max(128).optional(),
      syncMode: syncModeSchema.default("synced"),
    })
    .strict(),
  z
    .object({
      source: z.literal("existing"),
      contentInstanceId: z.string().uuid(),
      syncMode: syncModeSchema.default("synced"),
    })
    .strict(),
]);
export type BuildPageContent = z.infer<typeof buildPageContentSchema>;

/**
 * One module entry in a build_page call. Two modes per entry, identical
 * to `add_module_to_page` (issue #159):
 *
 *   - **Mint mode** — `displayName` + `html` (+ `fields`, `description`,
 *     `kind`, `type`, `css`, `js`). The op creates the module through the
 *     same `modules.create` path (extractor fallback, type derivation,
 *     snapshot) the singular tool uses.
 *   - **Place mode** — `moduleId` of an existing module; authoring keys
 *     must be absent.
 *
 * The element-level superRefine reports issues WITH the element's array
 * index in the Zod path, so a mixed entry fails as `modules[3]: …`.
 */
export const buildPageModuleSchema = z
  .object({
    /** Template block to place into — must exist on the page's template. */
    blockName: slugSchema,
    /** Place mode: an existing module from `## Modules`. */
    moduleId: z.string().uuid().optional(),
    /** Mint mode: authoring surface, mirrors add_module_to_page. */
    displayName: z.string().min(1).max(128).optional(),
    description: z.string().max(1000).optional(),
    kind: moduleKindSchema.optional(),
    type: slugSchema.optional(),
    html: z.string().min(1).max(MODULE_HTML_MAX).optional(),
    css: z.string().max(MODULE_CSS_MAX).optional(),
    js: z.string().max(MODULE_JS_MAX).optional(),
    fields: z.array(moduleFieldSchema).max(64).optional(),
    /** issue #164 slice 2 — opt-in mechanical token binding (tool layer). */
    bindThemeLiterals: z.boolean().optional(),
    content: buildPageContentSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const authoringKeys = (
      [
        "displayName",
        "html",
        "css",
        "js",
        "fields",
        "description",
        "kind",
        "type",
        "bindThemeLiterals",
      ] as const
    ).filter((k) => entry[k] !== undefined);
    if (entry.moduleId !== undefined) {
      if (authoringKeys.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `moduleId places an EXISTING module — drop ${authoringKeys.join(", ")}. ` +
            "To change a shared module's structure use edit_module; to mint a new one omit moduleId.",
        });
      }
      return;
    }
    if (entry.displayName === undefined || entry.html === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Pass either `moduleId` (place an existing module from ## Modules) " +
          "or `displayName` + `html` (mint a new module).",
      });
    }
  });
export type BuildPageModule = z.infer<typeof buildPageModuleSchema>;

/**
 * Target page — exactly one of two shapes:
 *
 *   - `{ pageId }`                       → build onto an existing page
 *     (modules are APPENDED to the named blocks in listed order).
 *   - `{ slug, title, … }`               → create the page first (same
 *     resolution rules as `pages.create`: templateId optional when
 *     site_defaults carries a default).
 */
export const buildPageTargetSchema = z
  .object({
    pageId: z.string().uuid().optional(),
    slug: slugSchema.optional(),
    title: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional(),
    locale: localeSchema.optional(),
    templateId: z.string().uuid().optional(),
    status: pageStatusSchema.optional(),
  })
  .strict()
  .superRefine((page, ctx) => {
    const createKeys = (
      ["slug", "title", "name", "locale", "templateId", "status"] as const
    ).filter((k) => page[k] !== undefined);
    if (page.pageId !== undefined) {
      if (createKeys.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `pageId targets an EXISTING page — drop ${createKeys.join(", ")}. ` +
            "To create a new page instead, omit pageId and pass slug + title.",
        });
      }
      return;
    }
    if (page.slug === undefined || page.title === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Pass either `pageId` (build onto an existing page) or `slug` + `title` (create the page in the same call).",
      });
    }
  });
export type BuildPageTarget = z.infer<typeof buildPageTargetSchema>;

/** `pages.build_page` op input. */
export const buildPageInputSchema = z
  .object({
    page: buildPageTargetSchema,
    modules: z.array(buildPageModuleSchema).min(1).max(40),
  })
  .strict();
export type BuildPageInput = z.infer<typeof buildPageInputSchema>;

/** `pages.build_page` op output — one row per placed module, in input order. */
export const buildPagePlacementResultSchema = z.object({
  blockName: z.string(),
  position: z.number().int().nonnegative(),
  moduleId: z.string(),
  contentInstanceId: z.string(),
  syncMode: syncModeSchema,
  /** True when this call minted the module (mint mode). */
  minted: z.boolean(),
});
export type BuildPagePlacementResult = z.infer<typeof buildPagePlacementResultSchema>;

// ─── content_instances.create_many ───────────────────────────────────

/**
 * Batch form of `content_instances.create`. Each item is the exact
 * singular input; the handler runs the singular path per item inside
 * ONE transaction (all-or-nothing — a failure at index i rolls back
 * items 0..i-1 and the error names `instances[i]`).
 */
export const contentInstancesCreateManySchema = z
  .object({
    instances: z.array(contentInstanceCreateSchema).min(1).max(100),
  })
  .strict();
export type ContentInstancesCreateManyInput = z.infer<typeof contentInstancesCreateManySchema>;

// ─── page_module_content.set_many ────────────────────────────────────

/**
 * Batch form of `page_module_content.set` — a content-only pass over N
 * existing placements (typically one page's worth, but cross-page items
 * are fine). All-or-nothing in one transaction; failures name `items[i]`
 * plus the placement coordinates and, for value-shape errors, the field.
 */
export const pageModuleContentSetManySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            pageId: z.string().uuid(),
            blockName: z.string().min(1).max(80),
            position: z.number().int().nonnegative(),
            /** Keyed by module field name. Fully replaces existing values. */
            contentValues: contentValuesSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type PageModuleContentSetManyInput = z.infer<typeof pageModuleContentSetManySchema>;
