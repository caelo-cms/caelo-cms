// SPDX-License-Identifier: MPL-2.0

/**
 * #591, #1752 — `pages_seo.apply_translation`: the write half of a
 * translation flow, where the SEO fill-once rule for a translated page is
 * decided (CLAUDE.md §2). Its own file: the rest of the SEO ops are the
 * AI's and the panel's (ops/seo.ts).
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  err,
  OG_DESCRIPTION_HARD_MAX,
  ogTitleSchema,
  ok,
  SEO_DESCRIPTION_HARD_MAX,
  seoTitleSchema,
} from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  commitPageSeoWrites,
  type OpenedPageSeo,
  openPageSeoWrite,
  peekPageSeo,
  sameSeo,
} from "../seo/page-seo-write.js";
import type { PageSeoState } from "../snapshots/state.js";

// ---------------------------------------------------------------------
// pages_seo.apply_translation — the SEO fill-once rule for a translated
// page (#591).
// ---------------------------------------------------------------------

/** The own texts a translation flow hands over. */
const TRANSLATED_SEO_FIELDS = ["seoTitle", "metaDescription", "ogTitle", "ogDescription"] as const;
type TranslatedSeoField = (typeof TRANSLATED_SEO_FIELDS)[number];
const translationOutcome = z.enum(["filled", "unchanged", "marked_stale"]);
type TranslationOutcome = z.infer<typeof translationOutcome>;

/**
 * A translation flow hands over the translated SEO texts of a page — meta
 * description, and (#1752) SEO title, og:title and og:description when the
 * source page has them (international-site's translate_variant). The
 * fill-once rule (CLAUDE.md §2) is decided HERE, per text, where SEO is
 * owned, not in the plugin:
 *
 *  - an empty text, or a page that is not live: fill it (the first
 *    translation of a variant; a draft re-translated before publish);
 *  - a LIVE page whose text is already set: never overwrite. Clear
 *    `optimized_at` instead, which puts the page on the existing stale-SEO
 *    surface (`pages_seo.list_stale`), so the AI/editor re-optimizes
 *    explicitly through `pages_seo.optimize` (seo-optimize).
 *
 * `outcome` sums the texts up: `marked_stale` when any was kept stale (the
 * one the caller must tell the AI about), else `filled` when any was
 * written, else `unchanged`; `fields` says it per text.
 */
export const pagesSeoApplyTranslationOp = defineOperation({
  name: "pages_seo.apply_translation",
  pluginAccess: "write",
  readScope: "request",
  // Why system-only: the write half of a translation flow (plugins run
  // it from translate_variant). The AI fills SEO through
  // pages_seo.autofill and re-optimizes through pages_seo.optimize, which
  // carry the same rule as explicit, separate steps.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      metaDescription: z.string().min(1).max(SEO_DESCRIPTION_HARD_MAX).optional(),
      seoTitle: seoTitleSchema.pipe(z.string().min(1)).optional(),
      ogTitle: ogTitleSchema.pipe(z.string().min(1)).optional(),
      ogDescription: z.string().trim().min(1).max(OG_DESCRIPTION_HARD_MAX).optional(),
    })
    .strict()
    .refine(
      (v) => TRANSLATED_SEO_FIELDS.some((f) => v[f] !== undefined),
      "pass at least one of `metaDescription`, `seoTitle`, `ogTitle`, `ogDescription`",
    ),
  output: z.object({
    outcome: translationOutcome,
    fields: z.partialRecord(z.enum(TRANSLATED_SEO_FIELDS), translationOutcome),
  }),
  handler: async (ctx, input, tx) => {
    const notFound = {
      kind: "HandlerError" as const,
      operation: "pages_seo.apply_translation",
      message: `page ${input.pageId} not found or deleted — re-read the variant group and retry`,
    };
    const plan = (o: OpenedPageSeo) => {
      const { current, page } = o;
      const fields: Partial<Record<TranslatedSeoField, TranslationOutcome>> = {};
      let next: PageSeoState = current;
      for (const f of TRANSLATED_SEO_FIELDS) {
        const wanted = input[f];
        if (wanted === undefined) continue;
        if (current[f] === wanted) fields[f] = "unchanged";
        else if (current[f] !== "" && page.status === "published") {
          fields[f] = "marked_stale";
          next = { ...next, optimizedAt: null };
        } else {
          fields[f] = "filled";
          // `autofilledAt` is the meta description's fill-once marker: a
          // translated title alone must not block the first description.
          next = {
            ...next,
            [f]: wanted,
            ...(f === "metaDescription"
              ? { autofilledAt: current.autofilledAt ?? new Date().toISOString() }
              : {}),
          };
        }
      }
      const outcomes = Object.values(fields);
      const outcome: TranslationOutcome = outcomes.includes("marked_stale")
        ? "marked_stale"
        : outcomes.includes("filled")
          ? "filled"
          : "unchanged";
      return { outcome, fields, next: sameSeo(current, next) ? null : next };
    };
    // Decided on the peek first: a call that writes nothing takes no lock
    // (no takeover of another chat's pending change for a no-op).
    const peek = await peekPageSeo(ctx, tx, "pages_seo.apply_translation", input.pageId);
    if (!peek.ok) return err(notFound);
    let { outcome, fields, next } = plan(peek.value);
    if (next) {
      const opened = await openPageSeoWrite(ctx, tx, "pages_seo.apply_translation", input.pageId);
      if (!opened.ok) return err(notFound);
      ({ outcome, fields, next } = plan(opened.value));
      if (next) {
        await commitPageSeoWrites(
          ctx,
          tx,
          [{ opened: opened.value, next }],
          "pages_seo.apply_translation",
          `pages_seo.apply_translation slug=${opened.value.page.slug} outcome=${outcome}`,
        );
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages_seo.apply_translation",
      input: {
        pageId: input.pageId,
        descLen: input.metaDescription?.length ?? 0,
        fields: Object.keys(fields),
      },
      succeeded: true,
      entityId: input.pageId,
      resultSummary: outcome,
    });
    return ok({ outcome, fields });
  },
});
