// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 8 — SEO ops. Per-page SEO is structured fields only; this
 * module is the only path that writes pages_seo.
 *
 * Rules:
 *  - `autofill` runs once per page (first publish); refuses on
 *    already-filled. Stamps `autofilled_at`.
 *  - `optimize` is the explicit re-optimization path; always allowed.
 *    Bumps `optimized_at`. Used by the seo-optimize skill with
 *    user-supplied context (keyword analysis, intent shifts).
 *  - `set` is the manual / panel path; doesn't touch fingerprints.
 *
 * AI cannot inject raw HTML into <head> — every input is a discrete
 * Zod-validated field. Per CLAUDE.md §2.
 */

import { defineOperation } from "@caelo/query-api";
import {
  err,
  ok,
  seoAutofillInputSchema,
  seoOptimizeInputSchema,
  seoSetInputSchema,
  siteDefaultsSetSeoInputSchema,
} from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { buildPatchSet } from "../sql-helpers.js";

const seoRowOutput = z.object({
  pageId: z.string(),
  metaDescription: z.string(),
  ogImageAssetId: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  noindex: z.boolean(),
  changefreq: z.string(),
  priority: z.number(),
  autofilledAt: z.string().nullable(),
  optimizedAt: z.string().nullable(),
  updatedAt: z.string(),
});

type SeoDbRow = {
  page_id: string;
  meta_description: string;
  og_image_asset_id: string | null;
  canonical_url: string | null;
  noindex: boolean;
  changefreq: string;
  priority: number | string;
  autofilled_at: Date | string | null;
  optimized_at: Date | string | null;
  updated_at: Date | string;
};

const isoOpt = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function rowToSeo(r: SeoDbRow): z.infer<typeof seoRowOutput> {
  return {
    pageId: r.page_id,
    metaDescription: r.meta_description,
    ogImageAssetId: r.og_image_asset_id,
    canonicalUrl: r.canonical_url,
    noindex: r.noindex,
    changefreq: r.changefreq,
    priority: Number(r.priority),
    autofilledAt: isoOpt(r.autofilled_at),
    optimizedAt: isoOpt(r.optimized_at),
    updatedAt: iso(r.updated_at),
  };
}

// ---------------------------------------------------------------------
// pages_seo.get
// ---------------------------------------------------------------------

export const pagesSeoGetOp = defineOperation({
  name: "pages_seo.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }).strict(),
  output: z.object({ seo: seoRowOutput.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        page_id::text AS page_id,
        meta_description, og_image_asset_id::text AS og_image_asset_id,
        canonical_url, noindex, changefreq, priority,
        autofilled_at, optimized_at, updated_at
      FROM pages_seo WHERE page_id = ${input.pageId}::uuid
      LIMIT 1
    `)) as unknown as SeoDbRow[];
    const r = rows[0];
    if (!r) return ok({ seo: null });
    return ok({ seo: rowToSeo(r) });
  },
});

// ---------------------------------------------------------------------
// pages_seo.set — manual / panel writes. Doesn't bump fingerprints.
// ---------------------------------------------------------------------

export const pagesSeoSetOp = defineOperation({
  name: "pages_seo.set",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: seoSetInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // Ensure the sidecar row exists; subsequent UPDATE patches the
    // provided fields in a single statement.
    await tx.execute(sql`
      INSERT INTO pages_seo (page_id) VALUES (${input.pageId}::uuid)
      ON CONFLICT (page_id) DO NOTHING
    `);

    // Build the patch set from the provided fields. Same buildPatchSet
    // helper that powers modules.update / pages.update so the SET
    // clause emits cleanly with an `updated_at = now()` tail.
    const patch: Record<string, unknown> = {
      meta_description: input.metaDescription,
      canonical_url: input.canonicalUrl,
      noindex: input.noindex,
      changefreq: input.changefreq,
      priority: input.priority,
    };
    if (input.ogImageAssetId !== undefined) {
      patch.og_image_asset_id =
        input.ogImageAssetId === null ? null : sql`${input.ogImageAssetId}::uuid`;
    }
    const fieldCount = Object.values(patch).filter((v) => v !== undefined).length;
    if (fieldCount === 0) return ok({});

    const sets = buildPatchSet(patch);
    await tx.execute(sql`
      UPDATE pages_seo SET ${sets}, updated_by = ${ctx.actorId}::uuid
      WHERE page_id = ${input.pageId}::uuid
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages_seo.set",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `fields=${fieldCount}`,
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// pages_seo.autofill — fill-once. Refuses on already-filled.
// ---------------------------------------------------------------------

export const pagesSeoAutofillOp = defineOperation({
  name: "pages_seo.autofill",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: seoAutofillInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // Ensure the sidecar row exists.
    await tx.execute(sql`
      INSERT INTO pages_seo (page_id) VALUES (${input.pageId}::uuid)
      ON CONFLICT (page_id) DO NOTHING
    `);
    const rows = (await tx.execute(sql`
      SELECT autofilled_at FROM pages_seo WHERE page_id = ${input.pageId}::uuid
    `)) as unknown as { autofilled_at: Date | string | null }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "pages_seo.autofill",
        message: "page not found",
      });
    }
    if (target.autofilled_at !== null) {
      return err({
        kind: "HandlerError",
        operation: "pages_seo.autofill",
        message:
          "AlreadyAutofilled: this page's SEO was filled at " +
          `${isoOpt(target.autofilled_at)}; use pages_seo.optimize for explicit re-optimization`,
      });
    }
    const og = input.ogImageAssetId ?? null;
    await tx.execute(sql`
      UPDATE pages_seo SET
        meta_description = ${input.metaDescription},
        og_image_asset_id = ${og === null ? null : sql`${og}::uuid`},
        autofilled_at = now(),
        updated_at = now(),
        updated_by = ${ctx.actorId}::uuid
      WHERE page_id = ${input.pageId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages_seo.autofill",
      input: { pageId: input.pageId, descLen: input.metaDescription.length },
      succeeded: true,
      entityId: input.pageId,
      resultSummary: "first-fill",
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// pages_seo.optimize — explicit re-optimization. Always allowed.
// ---------------------------------------------------------------------

export const pagesSeoOptimizeOp = defineOperation({
  name: "pages_seo.optimize",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: seoOptimizeInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO pages_seo (page_id) VALUES (${input.pageId}::uuid)
      ON CONFLICT (page_id) DO NOTHING
    `);
    const og = input.ogImageAssetId ?? null;
    const rows = (await tx.execute(sql`
      UPDATE pages_seo SET
        meta_description = ${input.metaDescription},
        og_image_asset_id = ${og === null ? null : sql`${og}::uuid`},
        optimized_at = now(),
        updated_at = now(),
        updated_by = ${ctx.actorId}::uuid
      WHERE page_id = ${input.pageId}::uuid
      RETURNING 1
    `)) as unknown as { exists: number }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "pages_seo.optimize",
        message: "page not found",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages_seo.optimize",
      input: {
        pageId: input.pageId,
        descLen: input.metaDescription.length,
        contextLen: input.context?.length ?? 0,
      },
      succeeded: true,
      entityId: input.pageId,
      resultSummary: input.context ? `context-len=${input.context.length}` : "no-context",
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// pages_seo.list_stale — feeds the dashboard tile.
// ---------------------------------------------------------------------

export const pagesSeoListStaleOp = defineOperation({
  name: "pages_seo.list_stale",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().positive().max(200).default(50) }).strict(),
  output: z.object({
    pages: z.array(
      z.object({
        pageId: z.string(),
        slug: z.string(),
        title: z.string(),
        autofilledAt: z.string().nullable(),
        optimizedAt: z.string().nullable(),
        metaDescription: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        p.id::text AS page_id, p.slug, p.title,
        s.autofilled_at, s.optimized_at, s.meta_description
      FROM pages p
      LEFT JOIN pages_seo s ON s.page_id = p.id
      WHERE p.deleted_at IS NULL
        AND (s.optimized_at IS NULL OR s.meta_description = '')
      ORDER BY p.created_at DESC
      LIMIT ${input.limit}
    `)) as unknown as {
      page_id: string;
      slug: string;
      title: string;
      autofilled_at: Date | string | null;
      optimized_at: Date | string | null;
      meta_description: string | null;
    }[];
    return ok({
      pages: rows.map((r) => ({
        pageId: r.page_id,
        slug: r.slug,
        title: r.title,
        autofilledAt: isoOpt(r.autofilled_at),
        optimizedAt: isoOpt(r.optimized_at),
        metaDescription: r.meta_description ?? "",
      })),
    });
  },
});

// ---------------------------------------------------------------------
// site_defaults.set_seo — Owner-only base URL + sitemap toggle + Org JSON.
// ---------------------------------------------------------------------

export const siteDefaultsSetSeoOp = defineOperation({
  name: "site_defaults.set_seo",
  // Why human-only: Owner-only — site-level config (base URL, sitemap toggle, organization JSON).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: siteDefaultsSetSeoInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE site_defaults SET
        site_base_url = ${input.siteBaseUrl},
        sitemap_enabled = ${input.sitemapEnabled},
        organization_json = ${JSON.stringify(input.organizationJson)}::text::jsonb,
        updated_at = now(),
        updated_by = ${ctx.actorId}::uuid
      WHERE id = 1
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "site_defaults.set_seo",
      input,
      succeeded: true,
      resultSummary: `base=${input.siteBaseUrl},sitemap=${input.sitemapEnabled}`,
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// site_defaults.get_seo — read for renderer + Owner panel + sitemap.
// ---------------------------------------------------------------------

export const siteDefaultsGetSeoOp = defineOperation({
  name: "site_defaults.get_seo",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    siteBaseUrl: z.string(),
    sitemapEnabled: z.boolean(),
    organizationJson: z.record(z.string(), z.unknown()),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT site_base_url, sitemap_enabled, organization_json
      FROM site_defaults WHERE id = 1
      LIMIT 1
    `)) as unknown as {
      site_base_url: string;
      sitemap_enabled: boolean;
      organization_json: Record<string, unknown>;
    }[];
    const r = rows[0];
    return ok({
      siteBaseUrl: r?.site_base_url ?? "http://localhost:8082",
      sitemapEnabled: r?.sitemap_enabled ?? true,
      organizationJson: r?.organization_json ?? {},
    });
  },
});

// ---------------------------------------------------------------------
// pages.lookup_links_in_modules — given an old slug, find every module
// whose HTML body has an <a href> pointing at it. Used by the slug-
// change rewriter and the dashboard "incoming links" panel.
// ---------------------------------------------------------------------

export const lookupLinksInModulesOp = defineOperation({
  name: "pages.lookup_links_in_modules",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ oldSlug: z.string().min(1).max(120) }).strict(),
  output: z.object({
    modules: z.array(z.object({ id: z.string(), slug: z.string(), displayName: z.string() })),
  }),
  handler: async (_ctx, input, tx) => {
    // Cheap pre-filter: substring match on the slug. The op is a
    // search surface for the dashboard; the tx-level rewriter does
    // proper href parsing on the matching subset.
    const needles = [
      `href="/${input.oldSlug}"`,
      `href="/${input.oldSlug}/`,
      `href='/${input.oldSlug}'`,
      `href='/${input.oldSlug}/`,
    ];
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name FROM modules
      WHERE deleted_at IS NULL
        AND (
          html LIKE ${`%${needles[0]}%`}
          OR html LIKE ${`%${needles[1]}%`}
          OR html LIKE ${`%${needles[2]}%`}
          OR html LIKE ${`%${needles[3]}%`}
        )
      ORDER BY slug
    `)) as unknown as { id: string; slug: string; display_name: string }[];
    return ok({
      modules: rows.map((r) => ({ id: r.id, slug: r.slug, displayName: r.display_name })),
    });
  },
});

// ---------------------------------------------------------------------
// pages.rewrite_module_links — system-only. Called from change_page_slug
// after the redirect insert, in the same tx. Walks every matching
// module's HTML and rewrites `<a href="/<oldSlug>...">` to point at
// the new slug. Audit summary lists changed module slugs.
// ---------------------------------------------------------------------

export const rewriteModuleLinksOp = defineOperation({
  name: "pages.rewrite_module_links",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      oldSlug: z.string().min(1).max(120),
      newSlug: z.string().min(1).max(120),
    })
    .strict(),
  output: z.object({ rewrittenModuleIds: z.array(z.string()) }),
  handler: async (ctx, input, tx) => {
    if (input.oldSlug === input.newSlug) return ok({ rewrittenModuleIds: [] });
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, html FROM modules
      WHERE deleted_at IS NULL
        AND (html LIKE ${`%href="/${input.oldSlug}"%`}
          OR html LIKE ${`%href="/${input.oldSlug}/%`}
          OR html LIKE ${`%href='/${input.oldSlug}'%`}
          OR html LIKE ${`%href='/${input.oldSlug}/%`})
    `)) as unknown as { id: string; slug: string; html: string }[];
    const rewritten: string[] = [];
    // Rewrite every `<a href="/<oldSlug>" ...>` and
    // `<a href="/<oldSlug>/whatever" ...>` (single + double quotes,
    // and trailing slash optional). Bound to the leading "/" so we
    // don't accidentally rewrite `/some-page-with-<oldSlug>-suffix`.
    const escapedOld = input.oldSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(href=)(["'])/${escapedOld}(/[^"'<>]*)?\\2`, "g");
    for (const r of rows) {
      const next = r.html.replace(re, (_m, prefix, quote, tail) => {
        return `${prefix}${quote}/${input.newSlug}${tail ?? ""}${quote}`;
      });
      if (next === r.html) continue; // pre-filter false positive (substring inside text)
      await tx.execute(sql`
        UPDATE modules SET html = ${next}, updated_at = now()
        WHERE id = ${r.id}::uuid
      `);
      rewritten.push(r.id);
    }
    if (rewritten.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "pages.rewrite_module_links",
        input,
        succeeded: true,
        resultSummary: `oldSlug=${input.oldSlug} → newSlug=${input.newSlug}; modules=${rewritten.length}`,
      });
    }
    return ok({ rewrittenModuleIds: rewritten });
  },
});

// ---------------------------------------------------------------------
// P8 AI-first review pass — bulk SEO optimize. Per CLAUDE.md §11: when
// the user asks to re-optimize SEO across N pages with shared context
// (e.g. "we just rebranded from X to Y"), the AI should make ONE tool
// call carrying all N updates instead of N round-trips. Single tx →
// all-or-nothing.
// ---------------------------------------------------------------------

export const pagesSeoOptimizeManyOp = defineOperation({
  name: "pages_seo.optimize_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
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
      /** Shared context recorded in audit (keyword analysis, intent
       *  shift, branding update — what justifies the bulk change). */
      context: z.string().max(4000).optional(),
    })
    .strict(),
  output: z.object({ updated: z.number().int() }),
  handler: async (ctx, input, tx) => {
    let updated = 0;
    for (const u of input.updates) {
      await tx.execute(sql`
        INSERT INTO pages_seo (page_id) VALUES (${u.pageId}::uuid)
        ON CONFLICT (page_id) DO NOTHING
      `);
      const og = u.ogImageAssetId ?? null;
      const r = (await tx.execute(sql`
        UPDATE pages_seo SET
          meta_description = ${u.metaDescription},
          og_image_asset_id = ${og === null ? null : sql`${og}::uuid`},
          optimized_at = now(),
          updated_at = now(),
          updated_by = ${ctx.actorId}::uuid
        WHERE page_id = ${u.pageId}::uuid
        RETURNING 1
      `)) as unknown as { exists: number }[];
      updated += r.length;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "pages_seo.optimize_many",
      input: {
        count: input.updates.length,
        contextLen: input.context?.length ?? 0,
      },
      succeeded: true,
      resultSummary: input.context
        ? `pages=${updated},context-len=${input.context.length}`
        : `pages=${updated}`,
    });
    return ok({ updated });
  },
});
