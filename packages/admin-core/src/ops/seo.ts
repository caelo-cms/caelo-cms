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

import { createPluginRenderFailureSink } from "@caelo-cms/plugin-host";
import {
  defineOperation,
  defineReadOperation,
  OperationAbortError,
  type QueryError,
} from "@caelo-cms/query-api";
import {
  err,
  MAX_IMAGE_PREVIEW_VALUES,
  type MaxImagePreview,
  OG_DESCRIPTION_HARD_MAX,
  ogTitleSchema,
  ok,
  type Result,
  type RobotsRules,
  robotsMetaContent,
  robotsRuleGroupSchema,
  robotsRulesNotes,
  robotsRulesSchema,
  robotsRulesWarnings,
  robotsTxt,
  SEO_VALUE_ORIGINS,
  SHARE_IMAGE_SOURCES,
  seoAutofillInputSchema,
  seoOptimizeInputSchema,
  seoOriginsSchema,
  seoSetInputSchema,
  seoTitleSchema,
  siteDefaultsSetSeoInputSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { pluginValueRefusedHint } from "../deploy/render-failures.js";
import { observeDraftReads } from "../locks.js";
import {
  assetKey,
  loadPageSeoViews,
  PAGE_SEO_FIELDS,
  pageKey,
  pageSeoViewSql,
} from "../seo/page-seo.js";
import {
  nosnippetContentOf,
  nosnippetPlacementsOf,
  resolvePageSeoHeads,
} from "../seo/page-seo-head.js";
import {
  commitPageSeoWrites,
  openPageSeoWrite,
  peekPageSeo,
  sameSeo,
} from "../seo/page-seo-write.js";
import {
  type PageShareImage,
  resolvePageShareImages,
  type ShortRead,
  shareImageAssetIssue,
} from "../seo/share-image.js";
import type { PageSeoState } from "../snapshots/state.js";
import { loadPageContentTexts } from "./content/page-content-text.js";
import { recentSearchNotifications, searchNotificationShape } from "./search-notifications.js";

const seoRowOutput = z.object({
  pageId: z.string(),
  /** #1752 — the page's own `<title>`; "" = the page type's or site's template. */
  seoTitle: z.string(),
  metaDescription: z.string(),
  ogTitle: z.string(),
  ogDescription: z.string(),
  ogImageAssetId: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  noindex: z.boolean(),
  nofollow: z.boolean(),
  noarchive: z.boolean(),
  nosnippet: z.boolean(),
  noimageindex: z.boolean(),
  maxSnippet: z.number().int().nullable(),
  maxImagePreview: z.enum(MAX_IMAGE_PREVIEW_VALUES),
  maxVideoPreview: z.number().int().nullable(),
  /** #1752 — the placements rendered with `data-nosnippet`, where they sit now. */
  nosnippetPlacements: z.array(z.object({ blockName: z.string(), position: z.number().int() })),
  /** #1752 — who wrote each own text (`human` | `ai` | `reviewed`). */
  origins: seoOriginsSchema,
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

/** A resolved head value as the read ops return it. */
const resolvedValueOutput = z.object({
  value: z.string(),
  origin: z.enum(SEO_VALUE_ORIGINS),
});

/**
 * #1752 — the head a build renders for the page in the caller's view: each
 * value with its origin (`human` | `ai` | `reviewed` = the page's own,
 * `page_type` / `site` = a template or setting, `inherited` = shared from
 * another value of the page, `unset` = none).
 */
const resolvedHeadOutput = z.object({
  title: resolvedValueOutput.extend({ template: z.string().nullable() }),
  metaDescription: resolvedValueOutput,
  ogTitle: resolvedValueOutput.extend({
    inheritsFrom: z.enum(["seoTitle", "pageTitle"]).nullable(),
  }),
  ogDescription: resolvedValueOutput.extend({
    inheritsFrom: z.enum(["metaDescription"]).nullable(),
  }),
  ogType: resolvedValueOutput,
  /** The `<meta name="robots">` content. */
  robots: z.string(),
  pageType: z.string(),
  /** Template variables without a value on this page (they stay raw in the title). */
  unsetVariables: z.array(z.string()),
});

type ResolvedHeadOut = z.infer<typeof resolvedHeadOutput>;

const isoOpt = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

type OpTx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Fields an op changes on a page's SEO state. */
type SeoPatch = { -readonly [K in keyof PageSeoState]?: PageSeoState[K] };

/** The robots directives an input names (`seoRobotsInputShape`), as a state patch. */
function robotsPatch(input: {
  readonly nofollow?: boolean | undefined;
  readonly noarchive?: boolean | undefined;
  readonly nosnippet?: boolean | undefined;
  readonly noimageindex?: boolean | undefined;
  readonly maxSnippet?: number | null | undefined;
  readonly maxImagePreview?: MaxImagePreview | undefined;
  readonly maxVideoPreview?: number | null | undefined;
}): SeoPatch {
  return {
    ...(input.nofollow !== undefined ? { nofollow: input.nofollow } : {}),
    ...(input.noarchive !== undefined ? { noarchive: input.noarchive } : {}),
    ...(input.nosnippet !== undefined ? { nosnippet: input.nosnippet } : {}),
    ...(input.noimageindex !== undefined ? { noimageindex: input.noimageindex } : {}),
    ...(input.maxSnippet !== undefined ? { maxSnippet: input.maxSnippet } : {}),
    ...(input.maxImagePreview !== undefined ? { maxImagePreview: input.maxImagePreview } : {}),
    ...(input.maxVideoPreview !== undefined ? { maxVideoPreview: input.maxVideoPreview } : {}),
  };
}

/**
 * The caller's view of these pages' SEO, keyed by page id (absent = no SEO
 * yet), with each page's resolved head (`heads`, every visible page;
 * empty when `withHeads` is false, for a reader that needs the rows only).
 */
async function loadSeoRows(
  tx: OpTx,
  pageIds: readonly string[],
  chatBranchId: string | null | undefined,
  withHeads = true,
): Promise<{ rows: Map<string, SeoRow>; heads: Map<string, ResolvedHeadOut> }> {
  const views = await loadPageSeoViews(tx, pageIds, chatBranchId);
  const rows = new Map<string, SeoRow>();
  for (const [pageId, v] of views) {
    const { nosnippetContent, ...state } = v.state;
    rows.set(pageId, {
      pageId,
      ...state,
      nosnippetPlacements: await nosnippetPlacementsOf(tx, pageId, nosnippetContent, chatBranchId),
      updatedAt: v.updatedAt,
      pendingFields: [...v.pendingFields],
    });
  }
  if (!withHeads) return { rows, heads: new Map() };
  const resolved = await resolvePageSeoHeads(
    tx,
    pageIds,
    new Map([...views].map(([id, v]) => [id, v.state])),
    chatBranchId,
  );
  const heads = new Map<string, ResolvedHeadOut>();
  for (const [pageId, r] of resolved) {
    heads.set(pageId, {
      title: r.head.title,
      metaDescription: r.head.metaDescription,
      ogTitle: r.head.ogTitle,
      ogDescription: r.head.ogDescription,
      ogType: r.head.ogType,
      robots: robotsMetaContent(r.head.robots),
      pageType: r.pageTypeSlug,
      unsetVariables: [...r.head.unsetVariables],
    });
  }
  return { rows, heads };
}

const shareImageOutput = z.object({
  source: z.enum(SHARE_IMAGE_SOURCES),
  assetId: z.string().nullable(),
  url: z.string().nullable(),
  /** #1729 — why a plugin's default was refused (`plugin-value-refused:…`). */
  refused: z.string().optional(),
});

/**
 * These pages' share images in the caller's view (#1452). A plugin that
 * fails degrades its pages to the site default and is named in `warnings`:
 * reading a page's SEO must not depend on a plugin running, and the build
 * stays the loud gate.
 */
async function loadShareImages(
  read: ShortRead,
  pages: readonly { pageId: string; seo: { ogImageAssetId: string | null } | null }[],
  chatBranchId: string | null | undefined,
): Promise<{ images: Map<string, PageShareImage>; warnings: string[] }> {
  const sink = createPluginRenderFailureSink();
  const images = await resolvePageShareImages(
    read,
    pages.map((p) => ({ pageId: p.pageId, ownAssetId: p.seo?.ogImageAssetId ?? null })),
    { chatBranchId: chatBranchId ?? null, onPluginFailure: sink.onPluginFailure },
  );
  // #1729 — a language default the plugin named that is no library image.
  const refused = [...images.values()].flatMap((i) => (i.refused ? [i.refused] : []));
  return {
    images,
    warnings: [
      ...sink.failures().map((f) => f.reason),
      ...[...new Set(refused)].map(
        (marker) =>
          `${marker}: the plugin's default share image for this page is refused, so the page shows none — ${pluginValueRefusedHint(marker.slice(marker.indexOf(":") + 1))}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------
// pages_seo.get
// ---------------------------------------------------------------------

export const pagesSeoGetOp = defineOperation({
  name: "pages_seo.get",
  pluginAccess: "read",
  readScope: "request",
  // #591 — plugin actors read too: a translation flow carries the source
  // page's description into the variant (§11: reads are open).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }).strict(),
  output: z.object({
    seo: seoRowOutput.nullable(),
    /** #1752 — the head a build renders; null when the caller cannot see the page. */
    resolved: resolvedHeadOutput.nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const { rows, heads } = await loadSeoRows(tx, [pageKey(input.pageId)], ctx.chatBranchId);
    // The chat has now seen this page's draft state (a conflict's re-read).
    await observeDraftReads(tx, ctx, "page", [pageKey(input.pageId)]);
    return ok({
      seo: rows.get(pageKey(input.pageId)) ?? null,
      resolved: heads.get(pageKey(input.pageId)) ?? null,
    });
  },
});

// ---------------------------------------------------------------------
// pages_seo.get_many — the AI's SEO read: stored fields + core text
// ---------------------------------------------------------------------

/** Most pages one `pages_seo.get_many` call reads (each renders its content). */
export const SEO_GET_MANY_MAX = 50;

// ---------------------------------------------------------------------
// pages_seo.share_images — which image pages really get, and from where
// ---------------------------------------------------------------------

export const pagesSeoShareImagesOp = defineReadOperation({
  name: "pages_seo.share_images",
  // #1760 — the seo plugin's shared-link preview shows the image a page
  // really gets.
  pluginAccess: "read",
  readScope: "request",
  // CLAUDE.md §11: reads are open. The editor's read; the AI gets the same
  // through get_page_seo. A read op: no transaction while plugins answer (#1212).
  actorScope: ["human", "ai", "plugin", "system"],
  input: z.object({ pageIds: z.array(z.string().uuid()).min(1).max(SEO_GET_MANY_MAX) }).strict(),
  output: z.object({
    images: z.array(shareImageOutput.extend({ pageId: z.string() })),
    warnings: z.array(z.string()),
  }),
  handler: async (ctx, input, reads) => {
    const pageIds = input.pageIds.map(pageKey);
    const read: ShortRead = (fn) => reads.read(fn);
    const seo = await read(
      async (tx) => (await loadSeoRows(tx, pageIds, ctx.chatBranchId, false)).rows,
    );
    const { images, warnings } = await loadShareImages(
      read,
      pageIds.map((pageId) => ({ pageId, seo: seo.get(pageId) ?? null })),
      ctx.chatBranchId,
    );
    return ok({
      images: [...images].map(([pageId, image]) => ({ pageId, ...image })),
      warnings,
    });
  },
});

export const pagesSeoCheckShareImageOp = defineOperation({
  name: "pages_seo.check_share_image",
  pluginAccess: "read",
  readScope: "request",
  // Why human-only: no AI tool needs it — set_theme_asset and the plugin's
  // set_locale_share_image run this check themselves. #1452: it exists so a
  // plugin learns only whether an asset can be a default, not the media row.
  actorScope: ["human", "plugin", "system"],
  database: "cms_admin",
  input: z.object({ assetId: z.string().uuid() }).strict(),
  output: z.object({ issue: z.string().nullable() }),
  handler: async (_ctx, input, tx) => ok({ issue: await shareImageAssetIssue(tx, input.assetId) }),
});

export const pagesSeoGetManyOp = defineOperation({
  name: "pages_seo.get_many",
  readScope: "request",
  // CLAUDE.md §11: reads are open — the AI reads a page's stored SEO and
  // its core text before it writes or re-optimizes a description.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  // #1452 — plugins answer which share image a page gets, between two
  // short transactions (#1212). The draft observation below still writes.
  transaction: "none",
  input: z.object({ pageIds: z.array(z.string().uuid()).min(1).max(SEO_GET_MANY_MAX) }).strict(),
  output: z.object({
    pages: z.array(
      z.object({
        pageId: z.string(),
        title: z.string(),
        path: z.string(),
        seo: seoRowOutput.nullable(),
        /** #1752 — the head a build renders, each value with its origin. */
        resolved: resolvedHeadOutput,
        /** #1452 — the image this page really gets, and from where. */
        shareImage: shareImageOutput,
        contentText: z.string(),
        contentTextTruncated: z.boolean(),
        contentTextLength: z.number().int(),
      }),
    ),
    /** A plugin could not say: its pages show the site default here. */
    shareImageWarnings: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    const loaded = await tx.transaction(async (t) => {
      const texts = await loadPageContentTexts(
        t,
        input.pageIds.map(pageKey),
        ctx.chatBranchId ?? null,
      );
      if (texts.missing.length > 0) {
        return {
          texts,
          seoByPage: new Map<string, SeoRow>(),
          heads: new Map<string, ResolvedHeadOut>(),
        };
      }
      const { rows: seoByPage, heads } = await loadSeoRows(
        t,
        texts.pages.map((p) => p.pageId),
        ctx.chatBranchId,
      );
      // The chat has now seen these pages' draft state (a conflict's re-read).
      await observeDraftReads(
        t,
        ctx,
        "page",
        texts.pages.map((p) => p.pageId),
      );
      return { texts, seoByPage, heads };
    });
    const { texts, seoByPage, heads } = loaded;
    if (texts.missing.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "pages_seo.get_many",
        message:
          `no page with id ${texts.missing.join(", ")} — take page ids from list_pages ` +
          "(or the Stage-readiness note) and call again.",
      });
    }
    const pages = texts.pages.map((p) => {
      const resolved = heads.get(p.pageId);
      if (!resolved) throw new Error(`pages_seo.get_many: no resolved head for ${p.pageId}`);
      return { ...p, seo: seoByPage.get(p.pageId) ?? null, resolved };
    });
    const { images, warnings } = await loadShareImages(
      (fn) => tx.transaction(fn),
      pages,
      ctx.chatBranchId,
    );
    return ok({
      pages: pages.map((p) => {
        const shareImage = images.get(p.pageId);
        if (!shareImage) throw new Error(`pages_seo.get_many: no share image for ${p.pageId}`);
        return { ...p, shareImage };
      }),
      shareImageWarnings: warnings,
    });
  },
});

// ---------------------------------------------------------------------
// pages_seo.set — manual / panel writes. Doesn't bump fingerprints.
// ---------------------------------------------------------------------

export const pagesSeoSetOp = defineOperation({
  name: "pages_seo.set",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: seoSetInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const op = "pages_seo.set";
    if (input.reviewed !== undefined && input.reviewed.length > 0 && ctx.actorKind !== "human") {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "only a person marks an AI-written SEO text as reviewed (the SEO panel); leave `reviewed` out. Nothing was written.",
      });
    }
    const fixed: SeoPatch = {
      ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.ogTitle !== undefined ? { ogTitle: input.ogTitle } : {}),
      ...(input.ogDescription !== undefined ? { ogDescription: input.ogDescription } : {}),
      ...(input.ogImageAssetId !== undefined
        ? { ogImageAssetId: assetKey(input.ogImageAssetId) }
        : {}),
      ...(input.canonicalUrl !== undefined ? { canonicalUrl: input.canonicalUrl } : {}),
      ...(input.noindex !== undefined ? { noindex: input.noindex } : {}),
      ...robotsPatch(input),
      ...(input.changefreq !== undefined ? { changefreq: input.changefreq } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };
    if (input.nosnippetPlacements !== undefined) {
      const content = await nosnippetContentOf(
        tx,
        pageKey(input.pageId),
        input.nosnippetPlacements,
        ctx.chatBranchId,
      );
      if (!content.ok) {
        return err({ kind: "HandlerError", operation: op, message: content.message });
      }
      // The stored form (sorted, once each), so an unchanged list is no write.
      fixed.nosnippetContent = [...new Set(content.ids)].sort();
    }
    const reviewed = input.reviewed ?? [];
    const fieldCount = Object.keys(fixed).length + (reviewed.length > 0 ? 1 : 0);
    if (fieldCount === 0) return ok({});
    const nextOf = (current: PageSeoState): Result<PageSeoState, QueryError> => {
      const next = { ...current, ...fixed };
      const empty = reviewed.filter((f) => next[f].length === 0);
      if (empty.length > 0) {
        return err({
          kind: "HandlerError",
          operation: op,
          message: `${empty.join(", ")}: the page has no own text there, so there is nothing to mark reviewed. Nothing was written.`,
        });
      }
      const origins = { ...next.origins };
      for (const f of reviewed) {
        // A text this write changes is the person's own now; only an
        // unchanged AI text becomes `reviewed`.
        if (next[f] === current[f] && current.origins[f] === "ai") origins[f] = "reviewed";
      }
      return ok({ ...next, origins });
    };

    // Peek first: a set that changes nothing takes no lock (no takeover of
    // another chat's pending change for a no-op).
    const peek = await peekPageSeo(ctx, tx, op, input.pageId);
    if (!peek.ok) return peek;
    const peeked = nextOf(peek.value.current);
    if (!peeked.ok) return peeked;
    const opened = sameSeo(peek.value.current, peeked.value)
      ? peek
      : await openPageSeoWrite(ctx, tx, op, input.pageId);
    if (!opened.ok) return opened;
    if (opened !== peek && input.nosnippetPlacements !== undefined) {
      // The lock may have taken another chat's pending layout of the page
      // over (a replaced or forked placement): the placements resolve again
      // against it. A refusal now throws, rolling the takeover back.
      const content = await nosnippetContentOf(
        tx,
        pageKey(input.pageId),
        input.nosnippetPlacements,
        ctx.chatBranchId,
      );
      if (!content.ok) {
        throw new OperationAbortError({
          kind: "HandlerError",
          operation: op,
          message: content.message,
        });
      }
      fixed.nosnippetContent = [...new Set(content.ids)].sort();
    }
    const planned = nextOf(opened.value.current);
    if (!planned.ok) throw new OperationAbortError(planned.error);
    const next = planned.value;
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

/** The #1752 own texts autofill and optimize write besides the description. */
const HEAD_TEXT_FIELDS = ["seoTitle", "ogTitle", "ogDescription"] as const;

/** The head text in words the AI and the operator use. */
const HEAD_TEXT_LABEL: Readonly<Record<(typeof HEAD_TEXT_FIELDS)[number], string>> = {
  seoTitle: "SEO title (<title>)",
  ogTitle: "og:title",
  ogDescription: "og:description",
};

/** True once the page was published live (`pages.first_published_at`). */
async function wasPublishedLive(tx: OpTx, pageId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT first_published_at IS NOT NULL AS live FROM pages WHERE id = ${pageKey(pageId)}::uuid
  `)) as unknown as { live: boolean }[];
  return rows[0]?.live === true;
}

/** What one autofill does to a page's SEO. */
type AutofillPlan =
  | { readonly kind: "refuse"; readonly error: QueryError }
  | { readonly kind: "unchanged" }
  | { readonly kind: "write"; readonly next: PageSeoState };

/**
 * Fill-once (CLAUDE.md §2) for every text autofill writes. The meta
 * description keeps its rule: the first autofill writes it, a later one
 * with a different text is refused ({@link alreadyAutofilled}). #1752 —
 * the SEO title and Open Graph texts are filled per field: only while
 * empty and while the page was never published live (an empty one there
 * is no gap: the template and the shared texts render), never over a
 * stored value; the same text again is a no-op.
 */
function planAutofill(
  current: PageSeoState,
  input: z.infer<typeof seoAutofillInputSchema>,
  live: boolean,
): AutofillPlan {
  const changes: SeoPatch = {};
  if (current.autofilledAt !== null) {
    const refusal = alreadyAutofilled(current, input.metaDescription);
    if (refusal) return { kind: "refuse", error: refusal };
  } else {
    changes.metaDescription = input.metaDescription;
    if (input.ogImageAssetId !== undefined) changes.ogImageAssetId = assetKey(input.ogImageAssetId);
  }
  for (const f of HEAD_TEXT_FIELDS) {
    const wanted = input[f];
    if (wanted === undefined || current[f] === wanted) continue;
    if (current[f].length > 0) {
      return {
        kind: "refuse",
        error: {
          kind: "HandlerError",
          operation: "pages_seo.autofill",
          message: `AlreadyFilled: this page's ${HEAD_TEXT_LABEL[f]} is already "${current[f]}" (${current.origins[f] ?? "unknown"}); autofill never overwrites. Leave ${f} out, or change it on purpose with bulk_optimize_seo (with the user's context) or set_page_seo_many (an exact text the operator dictated).`,
        },
      };
    }
    if (live) {
      return {
        kind: "refuse",
        error: {
          kind: "HandlerError",
          operation: "pages_seo.autofill",
          message: `this page is live and shows its ${HEAD_TEXT_LABEL[f]} from ${f === "seoTitle" ? "its title template" : "its other SEO texts"}: an own ${f} would change what is live, which autofill never does. Leave ${f} out; give it one on purpose with bulk_optimize_seo when the user asks.`,
        },
      };
    }
    changes[f] = wanted;
  }
  if (Object.keys(changes).length === 0) return { kind: "unchanged" };
  const next = { ...current, ...changes };
  if (sameSeo(current, next) && current.autofilledAt !== null) return { kind: "unchanged" };
  return {
    kind: "write",
    next: { ...next, autofilledAt: current.autofilledAt ?? new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------
// pages_seo.autofill — fill-once. Refuses on already-filled.
// ---------------------------------------------------------------------

export const pagesSeoAutofillOp = defineOperation({
  name: "pages_seo.autofill",
  readScope: "request",
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
    const live = await wasPublishedLive(tx, input.pageId);
    // Fill-once is decided on the peek, BEFORE the lock: a refused (or
    // no-op) autofill must not take over another chat's pending change.
    const peek = await peekPageSeo(ctx, tx, "pages_seo.autofill", input.pageId);
    if (!peek.ok) return peek;
    const peeked = planAutofill(peek.value.current, input, live);
    if (peeked.kind === "refuse") return err(peeked.error);
    if (peeked.kind === "unchanged") {
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
    const opened = await openPageSeoWrite(ctx, tx, "pages_seo.autofill", input.pageId, (o) => {
      const plan = planAutofill(o.current, input, live);
      if (plan.kind === "refuse") return plan.error;
      return plan.kind === "unchanged"
        ? {
            kind: "HandlerError",
            operation: "pages_seo.autofill",
            message:
              "AlreadyAutofilled: another chat's first fill of this page was just adopted into this chat — read it with get_page_seo; nothing is missing for a Stage.",
          }
        : null;
    });
    if (!opened.ok) return opened;
    const plan = planAutofill(opened.value.current, input, live);
    if (plan.kind !== "write")
      throw new Error("pages_seo.autofill: the plan changed under the lock");
    await commitPageSeoWrites(
      ctx,
      tx,
      [{ opened: opened.value, next: plan.next }],
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
  readScope: "request",
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
        descLen: input.metaDescription?.length ?? 0,
        fields: optimizedFields(input),
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
  u: {
    metaDescription?: string | undefined;
    seoTitle?: string | undefined;
    ogTitle?: string | undefined;
    ogDescription?: string | undefined;
    ogImageAssetId?: string | null | undefined;
  },
): PageSeoState {
  return {
    ...current,
    ...(u.metaDescription !== undefined ? { metaDescription: u.metaDescription } : {}),
    ...(u.seoTitle !== undefined ? { seoTitle: u.seoTitle } : {}),
    ...(u.ogTitle !== undefined ? { ogTitle: u.ogTitle } : {}),
    ...(u.ogDescription !== undefined ? { ogDescription: u.ogDescription } : {}),
    ...(u.ogImageAssetId !== undefined ? { ogImageAssetId: assetKey(u.ogImageAssetId) } : {}),
    optimizedAt: new Date().toISOString(),
  };
}

/** The own texts an optimize input rewrites, for the audit. */
function optimizedFields(u: {
  metaDescription?: string | undefined;
  seoTitle?: string | undefined;
  ogTitle?: string | undefined;
  ogDescription?: string | undefined;
}): string[] {
  return (["seoTitle", "metaDescription", "ogTitle", "ogDescription"] as const).filter(
    (f) => u[f] !== undefined,
  );
}

// ---------------------------------------------------------------------
// pages_seo.list_stale — feeds the dashboard tile.
// ---------------------------------------------------------------------

export const pagesSeoListStaleOp = defineOperation({
  name: "pages_seo.list_stale",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().positive().max(200).default(50),
      /** #1538 — rows to skip, newest first, so a reader reaches every stale page. */
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
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
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${input.limit} OFFSET ${input.offset}
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
// site_defaults.set_seo — Owner-only base URL + sitemap / feed / IndexNow
// toggles + Org JSON + robots.txt rules.
// ---------------------------------------------------------------------

export const siteDefaultsSetSeoOp = defineOperation({
  name: "site_defaults.set_seo",
  readScope: "request",
  // Why human-only: Owner-only — site-level config (base URL, sitemap, feed
  // and IndexNow toggles, organization JSON, robots.txt rules) published on
  // every page. The AI reaches it through the
  // §11.A gate: site_defaults.propose_set_seo → execute_proposal (Owner).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: siteDefaultsSetSeoInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // #1706 — omitted rules stay as they are (the panel's other forms and
    // every older caller leave them alone).
    const robots =
      input.robotsRules === undefined
        ? sql`robots_rules`
        : sql`${JSON.stringify(input.robotsRules)}::text::jsonb`;
    await tx.execute(sql`
      UPDATE site_defaults SET
        site_base_url = ${input.siteBaseUrl},
        sitemap_enabled = ${input.sitemapEnabled},
        feed_enabled = ${input.feedEnabled},
        indexnow_enabled = ${input.indexNowEnabled},
        organization_json = ${JSON.stringify(input.organizationJson)}::text::jsonb,
        robots_rules = ${robots},
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
      resultSummary: `base=${input.siteBaseUrl},sitemap=${input.sitemapEnabled},feed=${input.feedEnabled},indexnow=${input.indexNowEnabled}${input.robotsRules === undefined ? "" : `,robots-groups=${input.robotsRules.length}`}`,
    });
    return ok({});
  },
});

/**
 * #1706 — the stored robots.txt rules. Every write validates them, so rows
 * that fail here were written past the ops: loud, never read as "none".
 */
export function parseStoredRobotsRules(stored: unknown): RobotsRules {
  const parsed = robotsRulesSchema.safeParse(stored);
  if (!parsed.success) {
    throw new Error(
      `site_defaults.robots_rules holds rules no op could have written (${parsed.error.issues.map((i) => i.message).join("; ")}) — set them again in Settings → SEO`,
    );
  }
  return parsed.data;
}

/** #1706 — the rules as `get_seo` and the panel show them. */
const robotsRulesOutput = z.array(robotsRuleGroupSchema);

// ---------------------------------------------------------------------
// site_defaults.get_seo — read for renderer + Owner panel + sitemap.
// ---------------------------------------------------------------------

export const siteDefaultsGetSeoOp = defineOperation({
  name: "site_defaults.get_seo",
  pluginAccess: "read",
  readScope: "request",
  // #398 — plugin actors read the base URL to build absolute hreflang
  // targets for host-strategy locales (§11: read surfaces are open).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** null = not configured yet (#551); never a substituted default. */
    siteBaseUrl: z.string().nullable(),
    sitemapEnabled: z.boolean(),
    /** /feed.xml + the WebSub ping (docs/dev/search-engine-feed.md). */
    feedEnabled: z.boolean(),
    /** IndexNow submissions after Publish live. */
    indexNowEnabled: z.boolean(),
    /** The site's IndexNow key, public by design (served at /<key>.txt). */
    indexNowKey: z.string(),
    organizationJson: z.record(z.string(), z.unknown()),
    /** The latest WebSub pings and IndexNow submissions, newest first. */
    searchNotifications: z.array(searchNotificationShape),
    /** #1706 — the Owner's robots.txt rules as stored (live after Stage + Publish live). */
    robotsRules: robotsRulesOutput,
    /**
     * #1706 — the live target's robots.txt as these settings render it
     * (null while the base URL is unset): what Publish live ships after the
     * next Stage.
     */
    robotsTxt: z.string().nullable(),
    /** What a rule set takes from search engines (the whole site for `*`, …). */
    robotsWarnings: z.array(z.string()),
    /** #1758 — what its preference lines (training token, Content-Signal) do and do not do. */
    robotsNotes: z.array(z.string()),
    /**
     * #1752 — the `<title>` template of pages without their own SEO title
     * whose page type has none (`set_page_type_seo_many` sets it).
     */
    titleTemplate: z.string(),
    /** `og:site_name` and `{site_name}`; null = not set (`set_site_identity`). */
    siteName: z.string().nullable(),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT site_base_url, sitemap_enabled, feed_enabled, indexnow_enabled, indexnow_key,
             organization_json, robots_rules, seo_title_template, site_name
      FROM site_defaults WHERE id = 1
      LIMIT 1
    `)) as unknown as {
      site_base_url: string | null;
      sitemap_enabled: boolean;
      feed_enabled: boolean;
      indexnow_enabled: boolean;
      indexnow_key: string;
      organization_json: Record<string, unknown>;
      robots_rules: unknown;
      seo_title_template: string;
      site_name: string | null;
    }[];
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "site_defaults.get_seo",
        message: "site_defaults row (id=1) is missing — the cms_admin migrations did not seed it",
      });
    }
    const robotsRules = parseStoredRobotsRules(r.robots_rules);
    return ok({
      siteBaseUrl: r.site_base_url,
      sitemapEnabled: r.sitemap_enabled,
      feedEnabled: r.feed_enabled,
      indexNowEnabled: r.indexnow_enabled,
      indexNowKey: r.indexnow_key,
      organizationJson: r.organization_json,
      searchNotifications: await recentSearchNotifications(tx, 4),
      robotsRules,
      robotsTxt:
        r.site_base_url === null
          ? null
          : robotsTxt({
              robots: "index",
              siteBaseUrl: r.site_base_url,
              sitemap: r.sitemap_enabled,
              feed: r.feed_enabled,
              rules: robotsRules,
            }),
      robotsWarnings: robotsRulesWarnings(robotsRules),
      robotsNotes: robotsRulesNotes(robotsRules),
      titleTemplate: r.seo_title_template,
      siteName: r.site_name,
    });
  },
});

// ---------------------------------------------------------------------
// site_defaults.seed_site_base_url — first-write of the base URL from the
// install's provisioned domain (CAELO_SITE_URL), never an overwrite.
// ---------------------------------------------------------------------

export const siteDefaultsSeedSiteBaseUrlOp = defineOperation({
  name: "site_defaults.seed_site_base_url",
  readScope: "request",
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
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      updates: z
        .array(
          z
            .object({
              pageId: z.string().uuid(),
              metaDescription: z.string().min(1).max(320).optional(),
              /** #1752 — re-optimized own texts; "" removes the page's own value. */
              seoTitle: seoTitleSchema.optional(),
              ogTitle: ogTitleSchema.optional(),
              ogDescription: z.string().trim().max(OG_DESCRIPTION_HARD_MAX).optional(),
              ogImageAssetId: z.string().uuid().nullable().optional(),
            })
            .strict()
            .refine(
              (u) => optimizedFields(u).length > 0,
              "pass at least one of `metaDescription`, `seoTitle`, `ogTitle`, `ogDescription`",
            ),
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
