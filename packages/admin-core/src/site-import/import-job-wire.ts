// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1360 — what the site import's job and the admin say to each other
 * (the actions of the `site_import` reporting job). The job crawls; the
 * admin renders each page it asks for and records everything it reports:
 *
 *   start            the run to crawl: source, scope, the frontier to resume
 *                    from, the SSRF guard's exemptions
 *   render           one page rendered by the install's renderer (the
 *                    capture job on Google Cloud, the one shared browser on
 *                    a self-hosted admin); its screenshot stays in the
 *                    admin, the job gets the HTML and the style samples
 *   batch            extracted pages and their captures
 *   checkpoint       the frontier, so a killed job resumes
 *   capture-targets  the pages still without a screenshot (the second pass)
 *   page-capture     one such page's screenshot key and design tokens
 *   page-note        a loud note on one page (screenshot or tokens missing)
 *   finish           the crawl is over: ready for review
 *   fail             the crawl cannot go on: the run fails with the reason
 *
 * Everything the job sends is untrusted data: it read third-party pages.
 * The admin checks every input against these schemas, keeps every key it
 * writes under the run's own prefix, and names the pages of its own run
 * only (admin-core site-import/import-job-kind.ts).
 */

import type { CrawlCheckpoint, CrawlScope, ElementStyleSample } from "@caelo-cms/site-importer";
import { z } from "zod";
import { pageDesignTokensSchema } from "../ops/imports.js";

/** What `start` answers. */
export type CrawlStart =
  | { readonly kind: "stop"; readonly reason: string }
  | {
      readonly kind: "crawl";
      readonly sourceUrl: string;
      readonly depth: number;
      readonly maxPages: number;
      /** LIST mode's exact URLs (#229); null crawls by depth. */
      readonly urls: readonly string[] | null;
      readonly scope: CrawlScope | null;
      readonly resumeFrom: CrawlCheckpoint | null;
      /** The SSRF guard's exemptions, as the admin has them (#191). */
      readonly allowedHosts: readonly string[];
      /**
       * The run's render budget and what is left of it (earlier attempts
       * count). A crawl that spends it ends with the pages it has.
       */
      readonly renderBudget: number;
      readonly rendersLeft: number;
    };

const url = z.string().url().max(4000);

export const renderRequestSchema = z
  .object({
    url,
    sampleStyles: z.boolean(),
    captureHtml: z.boolean(),
  })
  .strict();

export type RenderRequest = z.infer<typeof renderRequestSchema>;

/** What `render` answers. */
export type RenderAnswer =
  | {
      readonly ok: true;
      /** Where the admin stored the screenshot; null when it could not (`storeError`). */
      readonly key: string | null;
      readonly storeError: string | null;
      readonly width: number;
      readonly height: number;
      readonly finalUrl?: string;
      readonly finalStatus?: number;
      readonly contentType?: string;
      readonly styleSamples?: readonly ElementStyleSample[];
      readonly renderedHtml?: string;
    }
  | {
      readonly ok: false;
      /**
       * `blocked`: the SSRF guard refused the URL; `unavailable`: no renderer
       * on this install; `budget`: the run used its render budget.
       */
      readonly reason: "blocked" | "unavailable" | "failed" | "budget";
      readonly message: string;
    };

/**
 * One extracted page, as `imports.write_extracted_pages` stores it, with
 * bounds on every field: a real crawl stays far below them, a job that
 * went wrong cannot make the admin store more.
 */
const extractedPageSchema = z
  .object({
    sourceUrl: url,
    requestedUrl: url.optional(),
    proposedSlug: z.string().min(1).max(120),
    proposedTitle: z.string().max(500),
    sourceMetaDescription: z.string().max(2000).optional(),
    proposedModules: z
      .array(
        z
          .object({
            blockName: z.string().max(200),
            position: z.number().int().min(0).max(10_000),
            html: z.string().max(20_000_000),
            displayName: z.string().max(500),
          })
          .strict(),
      )
      .max(2000),
    proposedThemeTokens: z
      .record(z.string().max(200), z.string().max(2000))
      .refine((t) => Object.keys(t).length <= 5000, "at most 5000 theme tokens"),
    signature: z.string().max(200).optional(),
    pageCss: z.string().max(600_000).optional(),
    commentsStripped: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const batchReportSchema = z
  .object({
    pages: z.array(extractedPageSchema).min(1).max(500),
    /** The batch's visual ground truth (#423): keys from `render`, tokens from its samples. */
    captures: z
      .array(
        z
          .object({
            sourceUrl: url,
            screenshotObjectKey: z.string().max(500).optional(),
            sampledDesignTokens: pageDesignTokensSchema.optional(),
          })
          .strict(),
      )
      .max(500),
    /** Pages with a stored screenshot but no style samples: each gets a loud note. */
    tokenlessCapturedUrls: z.array(url).max(500),
  })
  .strict();

export type BatchReport = z.infer<typeof batchReportSchema>;

export const pageCaptureSchema = z
  .object({
    importPageId: z.string().uuid(),
    screenshotObjectKey: z.string().max(500).optional(),
    sampledDesignTokens: pageDesignTokensSchema.optional(),
  })
  .strict();

export const pageNoteSchema = z
  .object({
    importPageId: z.string().uuid(),
    category: z.enum(["screenshot_missing", "design_tokens_missing"]),
    note: z.string().min(1).max(1000),
  })
  .strict();

const urlWithReason = z
  .object({ url: z.string().max(4000), reason: z.string().max(2000) })
  .strict();

export const finishReportSchema = z
  .object({
    pagesSeen: z.number().int().min(0).max(1_000_000),
    pagesExtracted: z.number().int().min(0).max(100_000),
    errors: z.array(urlWithReason).max(50_000),
    skipped: z.array(urlWithReason).max(1000),
    skippedOutOfScope: z.number().int().min(0).max(10_000_000),
  })
  .strict();

export type FinishReport = z.infer<typeof finishReportSchema>;

export const failReportSchema = z.object({ message: z.string().min(1).max(1000) }).strict();

/** One page the second pass renders. */
export interface CaptureTarget {
  readonly importPageId: string;
  readonly sourceUrl: string;
}
