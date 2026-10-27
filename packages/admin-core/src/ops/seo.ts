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
 * #1156 — SEO is draft state like the rest of the page: in a chat every
 * write lands on the chat's branch as a pending page change and reaches
 * the live row only through a Stage (`seo/page-seo-write.ts`); every read
 * shows the caller's view (`seo/page-seo.ts`). The fill-once rule is
 * decided on that view, so a chat's own autofill counts before its Stage.
 *
 * AI cannot inject raw HTML into <head> — every input is a discrete
 * Zod-validated field. Per CLAUDE.md §2.
 */

import { defineOperation, OperationAbortError, type QueryError } from "@caelo-cms/query-api";
import {
  err,
  ok,
  SEO_DESCRIPTION_HARD_MAX,
  seoAutofillInputSchema,
  seoOptimizeInputSchema,
  seoSetInputSchema,
  siteDefaultsSetSeoInputSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { observeDraftReads } from "../locks.js";
import { loadPageSeoViews, PAGE_SEO_FIELDS, pageKey, pageSeoViewSql } from "../seo/page-seo.js";
import {
  commitPageSeoWrites,
  type OpenedPageSeo,
  openPageSeoWrite,
  peekPageSeo,
  sameSeo,
} from "../seo/page-seo-write.js";
import type { PageSeoState } from "../snapshots/state.js";
import { loadPageContentTexts } from "./content/page-content-text.js";

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
  /**
   * #1156 — fields the caller's chat changed that are not staged yet: they
   * reach the live site with the next Stage and a Publish live.
   */
  pendingFields: z.array(z.enum(PAGE_SEO_FIELDS)),
});

type SeoRow = z.infer<typeof seoRowOutput>;

const isoOpt = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

/** The caller's view of these pages' SEO, keyed by page id (absent = no SEO yet). */
async function loadSeoRows(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  pageIds: readonly string[],
  chatBranchId: string | null | undefined,
): Promise<Map<string, SeoRow>> {
  const views = await loadPageSeoViews(tx, pageIds, chatBranchId);
  return new Map(
    [...views].map(([pageId, v]) => [
      pageId,
      { pageId, ...v.state, updatedAt: v.updatedAt, pendingFields: [...v.pendingFields] },
    ]),
  );
}

// ---------------------------------------------------------------------
// pages_seo.get
// ---------------------------------------------------------------------

export const pagesSeoGetOp = defineOperation({
  name: "pages_seo.get",
  // #591 — plugin actors read too: a translation flow carries the source
  // page's description into the variant (§11: reads are open).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }).strict(),
  output: z.object({ seo: seoRowOutput.nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = await loadSeoRows(tx, [input.pageId], ctx.chatBranchId);
    // The chat has now seen this page's draft state (a conflict's re-read).
    await observeDraftReads(tx, ctx, "page", [pageKey(input.pageId)]);
    return ok({ seo: rows.get(pageKey(input.pageId)) ?? null });
  },
});

// ---------------------------------------------------------------------
// pages_seo.get_many — the AI's SEO read: stored fields + core text
// ---------------------------------------------------------------------

/** Most pages one `pages_seo.get_many` call reads (each renders its content). */
export const SEO_GET_MANY_MAX = 50;

export const pagesSeoGetManyOp = defineOperation({
  name: "pages_seo.get_many",
  // CLAUDE.md §11: reads are open — the AI reads a page's stored SEO and
  // its core text before it writes or re-optimizes a description.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageIds: z.array(z.string().uuid()).min(1).max(SEO_GET_MANY_MAX) }).strict(),
  output: z.object({
    pages: z.array(
      z.object({
        pageId: z.string(),
        title: z.string(),
        path: z.string(),
        seo: seoRowOutput.nullable(),
        contentText: z.string(),
        contentTextTruncated: z.boolean(),
        contentTextLength: z.number().int(),
      }),
    ),
  }),
  handler: async (ctx, input, tx) => {
    const texts = await loadPageContentTexts(
      tx,
      input.pageIds.map(pageKey),
      ctx.chatBranchId ?? null,
    );
    if (texts.missing.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "pages_seo.get_many",
        message:
          `no page with id ${texts.missing.join(", ")} — take page ids from list_pages ` +
          "(or the Stage-readiness note) and call again.",
      });
    }
    const seoByPage = await loadSeoRows(
      tx,
      texts.pages.map((p) => p.pageId),
      ctx.chatBranchId,
    );
    // The chat has now seen these pages' draft state (a conflict's re-read).
    await observeDraftReads(
      tx,
      ctx,
      "page",
      texts.pages.map((p) => p.pageId),
    );
    return ok({
      pages: texts.pages.map((p) => ({ ...p, seo: seoByPage.get(p.pageId) ?? null })),
    });
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
    const patch: Partial<PageSeoState> = {
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.ogImageAssetId !== undefined ? { ogImageAssetId: input.ogImageAssetId } : {}),
      ...(input.canonicalUrl !== undefined ? { canonicalUrl: input.canonicalUrl } : {}),
      ...(input.noindex !== undefined ? { noindex: input.noindex } : {}),
      ...(input.changefreq !== undefined ? { changefreq: input.changefreq } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };
    const fieldCount = Object.keys(patch).length;
    if (fieldCount === 0) return ok({});

    // Peek first: a set that changes nothing takes no lock (no takeover of
    // another chat's pending change for a no-op).
    const peek = await peekPageSeo(ctx, tx, "pages_seo.set", input.pageId);
    if (!peek.ok) return peek;
    const opened = sameSeo(peek.value.current, { ...peek.value.current, ...patch })
      ? peek
      : await openPageSeoWrite(ctx, tx, "pages_seo.set", input.pageId);
    if (!opened.ok) return opened;
    const next = { ...opened.value.current, ...patch };
    if (!sameSeo(opened.value.current, next)) {
      await commitPageSeoWrites(
        ctx,
        tx,
        [{ opened: opened.value, next }],
        "pages_seo.set",
        `pages_seo.set slug=${opened.value.page.slug} fields=${fieldCount}`,
      );
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages_seo.set",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `fields=${fieldCount}${ctx.chatBranchId ? " (branched)" : ""}`,
    });
    return ok({});
  },
});

/**
 * Fill-once (CLAUDE.md §2): the refusal for autofilling an already-filled
 * page with a DIFFERENT text, or null when the text is the same (a no-op).
 * The message carries the stored text, so the caller sees the page is NOT
 * missing a description (nothing blocks a Stage on it) and which tool
 * changes it on purpose.
 */
function alreadyAutofilled(target: PageSeoState, metaDescription: string): QueryError | null {
  const current = target.metaDescription.trim();
  if (current === metaDescription) return null;
  const stored =
    current.length > 0
      ? `its meta description is already set: "${current}" — nothing is missing for a Stage. `
      : "its description was removed after the first fill, so set it with set_page_seo_many. ";
  return {
    kind: "HandlerError",
    operation: "pages_seo.autofill",
    message:
      `AlreadyAutofilled: this page's SEO was filled at ${target.autofilledAt}; ${stored}` +
      "To change a filled description, use bulk_optimize_seo (explicit re-optimization) or set_page_seo_many (an exact text the operator dictated) — never autofill again.",
  };
}

// ---------------------------------------------------------------------
// pages_seo.autofill — fill-once. Refuses on already-filled.
// ---------------------------------------------------------------------

export const pagesSeoAutofillOp = defineOperation({
  name: "pages_seo.autofill",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: seoAutofillInputSchema,
  output: z.object({
    /**
     * True when the page was already autofilled with exactly this text: a
     * repeated call (a retry, a duplicate in a batch) changes nothing, so
     * it is not a refusal — fill-once forbids a DIFFERENT text only.
     */
    alreadyFilled: z.boolean(),
  }),
  handler: async (ctx, input, tx) => {
    // Fill-once is decided on the peek, BEFORE the lock: a refused (or
    // no-op) autofill must not take over another chat's pending change.
    const peek = await peekPageSeo(ctx, tx, "pages_seo.autofill", input.pageId);
    if (!peek.ok) return peek;
    if (peek.value.current.autofilledAt !== null) {
      const refusal = alreadyAutofilled(peek.value.current, input.metaDescription);
      if (refusal) return err(refusal);
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages_seo.autofill",
        input: { pageId: input.pageId, descLen: input.metaDescription.length },
        succeeded: true,
        entityId: input.pageId,
        resultSummary: "unchanged (identical to the first fill)",
      });
      return ok({ alreadyFilled: true });
    }
    // Under the lock a takeover may bring in a fill: refused then (thrown,
    // so the takeover rolls back), even for the same text.
    const opened = await openPageSeoWrite(ctx, tx, "pages_seo.autofill", input.pageId, (o) =>
      o.current.autofilledAt !== null
        ? (alreadyAutofilled(o.current, input.metaDescription) ?? {
            kind: "HandlerError",
            operation: "pages_seo.autofill",
            message:
              "AlreadyAutofilled: another chat's first fill of this page was just adopted into this chat — read it with get_page_seo; nothing is missing for a Stage.",
          })
        : null,
    );
    if (!opened.ok) return opened;
    const target = opened.value.current;
    await commitPageSeoWrites(
      ctx,
      tx,
      [
        {
          opened: opened.value,
          next: {
            ...target,
            metaDescription: input.metaDescription,
            ...(input.ogImageAssetId !== undefined ? { ogImageAssetId: input.ogImageAssetId } : {}),
            autofilledAt: new Date().toISOString(),
          },
        },
      ],
      "pages_seo.autofill",
      `pages_seo.autofill slug=${opened.value.page.slug}`,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages_seo.autofill",
      input: { pageId: input.pageId, descLen: input.metaDescription.length },
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `first-fill${ctx.chatBranchId ? " (branched)" : ""}`,
    });
    return ok({ alreadyFilled: false });
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
    const opened = await openPageSeoWrite(ctx, tx, "pages_seo.optimize", input.pageId);
    if (!opened.ok) return opened;
    await commitPageSeoWrites(
      ctx,
      tx,
      [{ opened: opened.value, next: optimizedSeo(opened.value.current, input) }],
      "pages_seo.optimize",
      `pages_seo.optimize slug=${opened.value.page.slug}`,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
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

/** The SEO a re-optimization leaves: new description (and OG image when given), fresh `optimizedAt`. */
function optimizedSeo(
  current: PageSeoState,
  u: { metaDescription: string; ogImageAssetId?: string | null },
): PageSeoState {
  return {
    ...current,
    metaDescription: u.metaDescription,
    ...(u.ogImageAssetId !== undefined ? { ogImageAssetId: u.ogImageAssetId } : {}),
    optimizedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------
// pages_seo.apply_translation — the SEO fill-once rule for a translated
// page (#591).
// ---------------------------------------------------------------------

/**
 * A translation flow hands over the translated meta description of a
 * page (international-site's translate_variant). The fill-once rule
 * (CLAUDE.md §2) is decided HERE, where SEO is owned, not in the plugin:
 *
 *  - empty description, or a page that is not live: fill it (the first
 *    translation of a variant; a draft re-translated before publish);
 *  - a LIVE page whose description is already set: never overwrite.
 *    Clear `optimized_at` instead, which puts the page on the existing
 *    stale-SEO surface (`pages_seo.list_stale`), so the AI/editor
 *    re-optimizes explicitly through `pages_seo.optimize` (seo-optimize).
 *
 * OG texts need no separate handling: og:title is the page title and
 * og:description the meta description (see `renderSeoHead`).
 */
export const pagesSeoApplyTranslationOp = defineOperation({
  name: "pages_seo.apply_translation",
  // Why system-only: the write half of a translation flow (plugins run
  // it from translate_variant). The AI fills SEO through
  // pages_seo.autofill and re-optimizes through pages_seo.optimize, which
  // carry the same rule as explicit, separate steps.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      metaDescription: z.string().min(1).max(SEO_DESCRIPTION_HARD_MAX),
    })
    .strict(),
  output: z.object({ outcome: z.enum(["filled", "unchanged", "marked_stale"]) }),
  handler: async (ctx, input, tx) => {
    const notFound = {
      kind: "HandlerError" as const,
      operation: "pages_seo.apply_translation",
      message: `page ${input.pageId} not found or deleted — re-read the variant group and retry`,
    };
    const plan = (o: OpenedPageSeo) => {
      const { current, page } = o;
      if (current.metaDescription === input.metaDescription) {
        return { outcome: "unchanged" as const, next: null };
      }
      if (current.metaDescription !== "" && page.status === "published") {
        return { outcome: "marked_stale" as const, next: { ...current, optimizedAt: null } };
      }
      const next: PageSeoState = {
        ...current,
        metaDescription: input.metaDescription,
        autofilledAt: current.autofilledAt ?? new Date().toISOString(),
      };
      return { outcome: "filled" as const, next };
    };
    // Decided on the peek first: a call that writes nothing takes no lock
    // (no takeover of another chat's pending change for a no-op).
    const peek = await peekPageSeo(ctx, tx, "pages_seo.apply_translation", input.pageId);
    if (!peek.ok) return err(notFound);
    let { outcome, next } = plan(peek.value);
    if (next && !sameSeo(peek.value.current, next)) {
      const opened = await openPageSeoWrite(ctx, tx, "pages_seo.apply_translation", input.pageId);
      if (!opened.ok) return err(notFound);
      ({ outcome, next } = plan(opened.value));
      if (next && !sameSeo(opened.value.current, next)) {
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
      input: { pageId: input.pageId, descLen: input.metaDescription.length },
      succeeded: true,
      entityId: input.pageId,
      resultSummary: outcome,
    });
    return ok({ outcome });
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
  handler: async (ctx, input, tx) => {
    // Main plus the caller's own chat branch, as pages.list: the result feeds
    // SEO writes, and another chat's unpublished page is not the caller's to
    // touch. Outside a chat (the dashboard tile) that is main only. SEO is
    // the caller's view too (#1156): a description the chat wrote counts.
    const branchFilter = ctx.chatBranchId
      ? sql`AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`AND p.chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT
        p.id::text AS page_id, p.slug, p.title,
        s.autofilled_at, s.optimized_at, s.meta_description
      FROM pages p
      LEFT JOIN ${pageSeoViewSql(ctx.chatBranchId)} s ON s.page_id = p.id
      WHERE p.deleted_at IS NULL
        ${branchFilter}
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
  // Why human-only: Owner-only — site-level config (base URL, sitemap toggle,
  // organization JSON) published on every page. The AI reaches it through the
  // §11.A gate: site_defaults.propose_set_seo → execute_proposal (Owner).
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
      requestId: ctx.requestId,
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
  // #398 — plugin actors read the base URL to build absolute hreflang
  // targets for host-strategy locales (§11: read surfaces are open).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** null = not configured yet (#551); never a substituted default. */
    siteBaseUrl: z.string().nullable(),
    sitemapEnabled: z.boolean(),
    organizationJson: z.record(z.string(), z.unknown()),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT site_base_url, sitemap_enabled, organization_json
      FROM site_defaults WHERE id = 1
      LIMIT 1
    `)) as unknown as {
      site_base_url: string | null;
      sitemap_enabled: boolean;
      organization_json: Record<string, unknown>;
    }[];
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "site_defaults.get_seo",
        message: "site_defaults row (id=1) is missing — the cms_admin migrations did not seed it",
      });
    }
    return ok({
      siteBaseUrl: r.site_base_url,
      sitemapEnabled: r.sitemap_enabled,
      organizationJson: r.organization_json,
    });
  },
});

// ---------------------------------------------------------------------
// site_defaults.seed_site_base_url — first-write of the base URL from the
// install's provisioned domain (CAELO_SITE_URL), never an overwrite.
// ---------------------------------------------------------------------

export const siteDefaultsSeedSiteBaseUrlOp = defineOperation({
  name: "site_defaults.seed_site_base_url",
  // Why human-only: system-only. The admin calls it at boot with the URL
  // provisioning derived from the install domain; it fills an unset value
  // and never overwrites one, so it cannot replace an Owner's choice.
  // Changing an existing base URL stays site_defaults.set_seo (Owner).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      siteBaseUrl: siteDefaultsSetSeoInputSchema.shape.siteBaseUrl,
      /** Where the value came from, recorded in the audit summary. */
      source: z.string().min(1).max(64),
    })
    .strict(),
  output: z.object({ seeded: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const updated = (await tx.execute(sql`
      UPDATE site_defaults SET
        site_base_url = ${input.siteBaseUrl},
        updated_at = now()
      WHERE id = 1 AND site_base_url IS NULL
      RETURNING id
    `)) as unknown as { id: number }[];
    const seeded = updated.length > 0;
    if (seeded) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "site_defaults.seed_site_base_url",
        input,
        succeeded: true,
        resultSummary: `base=${input.siteBaseUrl},source=${input.source}`,
      });
    }
    return ok({ seeded });
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
    // One write per page: a page named twice gets its updates applied in
    // input order (one snapshot entity, so "latest wins" never ties).
    const byPage = new Map<string, Parameters<typeof commitPageSeoWrites>[2][number]>();
    for (const u of input.updates) {
      const key = pageKey(u.pageId);
      const prev = byPage.get(key);
      if (prev) {
        byPage.set(key, { opened: prev.opened, next: optimizedSeo(prev.next, u) });
        continue;
      }
      const opened = await openPageSeoWrite(ctx, tx, "pages_seo.optimize_many", u.pageId);
      // Thrown, not returned: an earlier item's lock may have taken over
      // another chat's change, and only an abort rolls that back too.
      if (!opened.ok) throw new OperationAbortError(opened.error);
      byPage.set(key, { opened: opened.value, next: optimizedSeo(opened.value.current, u) });
    }
    const writes = [...byPage.values()];
    await commitPageSeoWrites(
      ctx,
      tx,
      writes,
      "pages_seo.optimize",
      `pages_seo.optimize_many pages=${writes.length}`,
    );
    const updated = writes.length;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
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
