// SPDX-License-Identifier: MPL-2.0

/**
 * P9 review-pass optimisation — `pages.translation_status_matrix`.
 *
 * Returns a (sourceSlug, locale, status) matrix derived from the
 * source-locale pages cross-joined with the locale registry. The
 * matrix synthesises `not_started` for missing variants — the spec's
 * fourth status value (CMS_REQUIREMENTS §7.5) that can't be stored in
 * the column itself (a row that doesn't exist can't have a status).
 *
 * Drives the P10 translation dashboard (§7.7):
 *   /about
 *   ├── en (source)     ✓ source
 *   ├── de              ✓ up_to_date
 *   ├── de-AT           ⚠ needs_update
 *   └── fr              ○ not_started
 *
 * Open to all actor kinds — the AI's translation skill reads it to
 * decide between Mode 1 (not_started → up_to_date) and Mode 2
 * (needs_update → up_to_date).
 */

import { defineOperation } from "@caelo/query-api";
import { ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const statusEnum = z.enum(["source", "up_to_date", "needs_update", "not_started"]);

const matrixRow = z.object({
  /** Source page slug — every row in the matrix is keyed by this. */
  slug: z.string(),
  /** Target locale code from the locales registry. */
  locale: z.string(),
  /** Synthesised status: `not_started` when no row exists for this (slug, locale). */
  status: statusEnum,
  /** Page id of the variant when it exists; null for synthesised `not_started` entries. */
  pageId: z.string().nullable(),
  /** Source page id — always populated. Used by translation dispatchers
   * since Mode 1 / Mode 2 take the SOURCE page id as their input. */
  sourcePageId: z.string(),
  /** Display name from the locales registry — convenience for UI. */
  localeDisplayName: z.string(),
  /** True when this is the source locale row (status === 'source'). */
  isSource: z.boolean(),
});

export const translationStatusMatrixOp = defineOperation({
  name: "pages.translation_status_matrix",
  // CLAUDE.md §11: open read so the AI's translation flow can reason
  // about coverage without a human round-trip.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Optional slug filter: matrix for ONE page across all locales. */
      slug: z.string().min(1).max(120).optional(),
    })
    .strict(),
  output: z.object({
    rows: z.array(matrixRow),
  }),
  handler: async (_ctx, input, tx) => {
    const filter = input.slug ? sql`WHERE p.slug = ${input.slug}` : sql``;
    // CROSS JOIN every distinct source slug with every locale; LEFT
    // JOIN to a live page row in that locale; synthesise not_started
    // when the join misses.
    const rows = (await tx.execute(sql`
      WITH sources AS (
        SELECT id::text AS source_id, slug FROM pages
        WHERE translation_status = 'source' AND deleted_at IS NULL
      )
      SELECT
        p.slug AS slug,
        p.source_id AS source_id,
        l.code AS locale,
        l.display_name AS locale_display_name,
        l.is_default AS is_default,
        COALESCE(pv.translation_status, 'not_started') AS status,
        pv.id::text AS page_id
      FROM sources p
      CROSS JOIN locales l
      LEFT JOIN pages pv
        ON pv.slug = p.slug AND pv.locale = l.code AND pv.deleted_at IS NULL
      ${filter}
      ORDER BY p.slug ASC, l.is_default DESC, l.code ASC
    `)) as unknown as {
      slug: string;
      source_id: string;
      locale: string;
      locale_display_name: string;
      is_default: boolean;
      status: "source" | "up_to_date" | "needs_update" | "not_started";
      page_id: string | null;
    }[];
    return ok({
      rows: rows.map((r) => ({
        slug: r.slug,
        locale: r.locale,
        localeDisplayName: r.locale_display_name,
        status: r.status,
        pageId: r.page_id,
        sourcePageId: r.source_id,
        isSource: r.status === "source",
      })),
    });
  },
});
