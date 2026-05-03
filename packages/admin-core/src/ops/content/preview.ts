// SPDX-License-Identifier: MPL-2.0

/**
 * Render a page to composed HTML for the admin preview iframe.
 *
 * Read-only — no audit row, same convention as `users.list`. Returns an
 * object (per the existing `defineOperation` shape); the route handler
 * unwraps `html` into a `text/html` response.
 *
 * P6.7 — accepts an optional `chatBranchId`. When set, every module
 * referenced by the page is resolved against the latest branch snapshot
 * for that branch (P5 schema); modules with no branch snapshot fall
 * back to the live `modules` row. Lets the live-edit overlay's iframe
 * render the post-AI-edit view of a page without requiring publish.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  ComposeError,
  composePageWithLayout,
  err,
  injectSeoIntoHead,
  ok,
  renderSeoHead,
  resolveCanonicalUrl,
  resolveLocaleUrl,
  type SiteSeoSettings,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  parseAndUpgradeModuleState,
  parseSnapshotState,
  SnapshotSchemaError,
} from "../../snapshots/index.js";

interface ModuleSourceRow {
  block_name: string;
  position: number;
  module_id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
}

interface BranchSnapshotRow {
  module_id: string;
  state: unknown;
}

export const renderPagePreviewOp = defineOperation({
  name: "pages.render_preview",
  // CLAUDE.md §11: read-only render. AI runs preview to verify edits
  // before publishing — same path as the iframe in /content/pages/[id].
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      chatBranchId: z.string().uuid().optional(),
      /**
       * P6.6b deferred — module ids whose branch state should be
       * skipped when rendering. The right pane of the chat-side diff
       * uses this to reveal what the page would look like if a
       * specific module's pending edit were rolled back, while the
       * rest of the branch's edits stay applied. Ignored when
       * `chatBranchId` is omitted.
       */
      excludeBranchModules: z.array(z.string().uuid()).optional(),
    })
    .strict(),
  output: z.object({
    html: z.string(),
    replacedSlots: z.array(z.string()),
    missingSlots: z.array(z.string()),
    pageSlug: z.string(),
    pageLocale: z.string(),
  }),
  handler: async (_ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, p.slug AS slug, p.locale AS locale, p.title AS title,
             t.html AS template_html, t.css AS template_css,
             l.id::text AS layout_id, l.slug AS layout_slug,
             l.html AS layout_html, l.css AS layout_css
      FROM pages p
      JOIN templates t ON t.id = p.template_id
      JOIN layouts l   ON l.id = t.layout_id
      WHERE p.id = ${input.pageId}::uuid AND p.deleted_at IS NULL LIMIT 1
    `)) as unknown as {
      page_id: string;
      slug: string;
      locale: string;
      title: string;
      template_html: string;
      template_css: string;
      layout_id: string;
      layout_slug: string;
      layout_html: string;
      layout_css: string;
    }[];
    const pageRow = pageRows[0];
    if (!pageRow) {
      return err({
        kind: "HandlerError",
        operation: "pages.render_preview",
        message: "page not found",
      });
    }
    // P6.7.6 no-fallbacks invariant — the layout must declare a
    // `content` block (the slot the template renders into). Surface a
    // loud error if it doesn't, instead of silently producing chrome
    // with no body.
    const layoutBlocksRows = (await tx.execute(sql`
      SELECT name FROM layout_blocks WHERE layout_id = ${pageRow.layout_id}::uuid
    `)) as unknown as { name: string }[];
    if (!layoutBlocksRows.some((r) => r.name === "content")) {
      return err({
        kind: "HandlerError",
        operation: "pages.render_preview",
        message: `layout "${pageRow.layout_slug}" is missing the required \`content\` block — fix via /security/layouts`,
      });
    }

    const modRows = (await tx.execute(sql`
      SELECT pm.block_name AS block_name,
             pm.position AS position,
             m.id::text AS module_id,
             m.slug AS slug,
             m.display_name AS display_name,
             m.html AS html,
             m.css AS css,
             m.js AS js
      FROM page_modules pm JOIN modules m ON m.id = pm.module_id
      WHERE pm.page_id = ${input.pageId}::uuid AND m.deleted_at IS NULL
      ORDER BY pm.block_name ASC, pm.position ASC
    `)) as unknown as ModuleSourceRow[];

    // P6.7 — branch-aware overlay. For each module referenced by this
    // page, look up the latest branch snapshot in the requested branch;
    // if found, swap its state in for the live module row. Modules with
    // no branch snapshot keep their live values.
    const excludeSet = new Set(input.excludeBranchModules ?? []);
    if (input.chatBranchId && modRows.length > 0) {
      const branchRows = (await tx.execute(sql`
        SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS module_id, ms.state
        FROM module_snapshots ms
        JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
        WHERE ss.chat_branch_id = ${input.chatBranchId}::uuid
          AND ms.module_id::text IN (${sql.join(
            modRows.map((r) => sql`${r.module_id}`),
            sql`, `,
          )})
        ORDER BY ms.module_id, ss.created_at DESC
      `)) as unknown as BranchSnapshotRow[];
      const branchByModule = new Map<string, BranchSnapshotRow>();
      for (const r of branchRows) branchByModule.set(r.module_id, r);
      try {
        for (const m of modRows) {
          // P6.6b — skip the branch overlay for excluded modules so
          // the right diff pane shows what the page would look like
          // with this specific module's pending edit rolled back.
          if (excludeSet.has(m.module_id)) continue;
          const b = branchByModule.get(m.module_id);
          if (!b) continue;
          const state = parseAndUpgradeModuleState(parseSnapshotState(b.state));
          if (state.deletedAt) continue; // soft-deleted in the branch
          m.html = state.html;
          m.css = state.css;
          m.js = state.js;
          m.display_name = state.displayName;
          m.slug = state.slug;
        }
      } catch (e) {
        if (e instanceof SnapshotSchemaError) {
          return err({
            kind: "HandlerError",
            operation: "pages.render_preview",
            message: `branch snapshot schema mismatch: ${e.message}`,
          });
        }
        throw e;
      }
    }

    const grouped = new Map<
      string,
      {
        moduleId: string;
        slug: string;
        displayName: string;
        html: string;
        css: string;
        js: string;
      }[]
    >();
    for (const r of modRows) {
      const arr = grouped.get(r.block_name) ?? [];
      arr.push({
        moduleId: r.module_id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        js: r.js,
      });
      grouped.set(r.block_name, arr);
    }
    const blocks = [...grouped.entries()].map(([blockName, modules]) => ({
      blockName,
      modules,
    }));

    // P6.7.5 — load structured sets (theme + nav-menu + others) so the
    // composer can render nav menus from typed items + inject theme
    // tokens into <head>.
    const setRows = (await tx.execute(sql`
      SELECT kind, slug, items::text AS items FROM structured_sets
    `)) as unknown as { kind: string; slug: string; items: string }[];
    const byKindSlug: Record<string, unknown[]> = {};
    for (const r of setRows) {
      try {
        byKindSlug[`${r.kind}/${r.slug}`] = JSON.parse(r.items) as unknown[];
      } catch {
        // ignore malformed rows
      }
    }

    // P6.7.6 — load layout modules (chrome) for every layout block
    // except `content` (which is filled by the rendered template).
    const layoutModRows = (await tx.execute(sql`
      SELECT lm.block_name AS block_name,
             lm.position   AS position,
             m.id::text    AS module_id,
             m.slug        AS slug,
             m.display_name AS display_name,
             m.html        AS html,
             m.css         AS css,
             m.js          AS js
      FROM layout_modules lm JOIN modules m ON m.id = lm.module_id
      WHERE lm.layout_id = ${pageRow.layout_id}::uuid AND m.deleted_at IS NULL
      ORDER BY lm.block_name ASC, lm.position ASC
    `)) as unknown as ModuleSourceRow[];
    const layoutGrouped = new Map<
      string,
      {
        moduleId: string;
        slug: string;
        displayName: string;
        html: string;
        css: string;
        js: string;
      }[]
    >();
    for (const r of layoutModRows) {
      const arr = layoutGrouped.get(r.block_name) ?? [];
      arr.push({
        moduleId: r.module_id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        js: r.js,
      });
      layoutGrouped.set(r.block_name, arr);
    }
    const layoutBlocks = [...layoutGrouped.entries()].map(([blockName, modules]) => ({
      blockName,
      modules,
    }));

    // P9 — language-selector context for the preview. Lists every
    // locale with a published variant of this page's slug so the
    // composer can render `language-selector-*` modules. Mirrors what
    // the static generator does at deploy. siteBaseUrl is loaded here
    // (and reused by the SEO head block below) so resolveLocaleUrl
    // gets the same base in both passes.
    const earlySettingsRows = (await tx.execute(sql`
      SELECT site_base_url FROM site_defaults WHERE id = 1 LIMIT 1
    `)) as unknown as { site_base_url: string }[];
    const earlySiteBaseUrl = earlySettingsRows[0]?.site_base_url ?? "http://localhost:8082";
    const langSiblings = (await tx.execute(sql`
      SELECT locale FROM pages
      WHERE slug = ${pageRow.slug}
        AND deleted_at IS NULL
        AND status = 'published'
    `)) as unknown as { locale: string }[];
    const langLocaleRows = (await tx.execute(sql`
      SELECT code, url_strategy, url_host FROM locales
    `)) as unknown as {
      code: string;
      url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
      url_host: string | null;
    }[];
    const langLocaleByCode = new Map(langLocaleRows.map((l) => [l.code, l]));
    const availableLocales = langSiblings
      .map(({ locale }) => {
        const cfg = langLocaleByCode.get(locale);
        if (!cfg) return null;
        try {
          return {
            code: locale,
            displayName: locale,
            href: resolveLocaleUrl(
              {
                code: cfg.code,
                displayName: cfg.code,
                urlStrategy: cfg.url_strategy,
                urlHost: cfg.url_host,
                isDefault: false,
              },
              pageRow.slug,
              earlySiteBaseUrl,
            ),
            isCurrent: locale === pageRow.locale,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    let composed: ReturnType<typeof composePageWithLayout>;
    try {
      composed = composePageWithLayout({
        templateHtml: pageRow.template_html,
        templateCss: pageRow.template_css,
        blocks,
        structuredSets: { byKindSlug },
        layoutHtml: pageRow.layout_html,
        layoutCss: pageRow.layout_css,
        layoutBlocks,
        layoutSlug: pageRow.layout_slug,
        languageSelector: { availableLocales },
      });
    } catch (e) {
      if (e instanceof ComposeError) {
        return err({
          kind: "HandlerError",
          operation: "pages.render_preview",
          message: e.message,
        });
      }
      throw e;
    }
    // P8 review-pass — preview parity with the static deploy.
    // Without this, editors can't verify SEO meta / canonical /
    // OG / JSON-LD before publishing. Loads pages_seo + site_defaults
    // SEO settings + pages_hreflang inline; same shape as the static
    // generator's seo-pass.ts. Missing rows (unfilled SEO) are
    // tolerated — we just emit a head with whatever's present.
    let html = composed.html;
    const seoRows = (await tx.execute(sql`
      SELECT meta_description, og_image_asset_id::text AS og_image_asset_id,
             canonical_url, noindex
      FROM pages_seo WHERE page_id = ${input.pageId}::uuid LIMIT 1
    `)) as unknown as {
      meta_description: string;
      og_image_asset_id: string | null;
      canonical_url: string | null;
      noindex: boolean;
    }[];
    const seoRow = seoRows[0];
    const settingsRows = (await tx.execute(sql`
      SELECT site_base_url, sitemap_enabled, organization_json::text AS organization_json
      FROM site_defaults WHERE id = 1 LIMIT 1
    `)) as unknown as {
      site_base_url: string;
      sitemap_enabled: boolean;
      organization_json: string | null;
    }[];
    const settingsRow = settingsRows[0];
    let organization: SiteSeoSettings["organization"] = {};
    if (settingsRow?.organization_json) {
      try {
        organization = JSON.parse(settingsRow.organization_json) as SiteSeoSettings["organization"];
      } catch {
        organization = {};
      }
    }
    const siteBaseUrl = settingsRow?.site_base_url ?? "http://localhost:8082";

    let ogImageUrl: string | null = null;
    if (seoRow?.og_image_asset_id) {
      const variants = (await tx.execute(sql`
        SELECT variant, format FROM media_variants
        WHERE asset_id = ${seoRow.og_image_asset_id}::uuid
        ORDER BY
          CASE variant
            WHEN 'webp-1200' THEN 0 WHEN 'webp-1600' THEN 1
            WHEN 'webp-800'  THEN 2 WHEN 'orig'      THEN 3 ELSE 4
          END
        LIMIT 1
      `)) as unknown as { variant: string; format: string }[];
      const v = variants[0];
      if (v) {
        const ext = v.format === "jpeg" ? "jpg" : v.format;
        // Preview keeps the /_caelo/media URL form so the admin
        // resolver serves the bytes; the static generator rewrites
        // to /_assets at deploy.
        ogImageUrl = `/_caelo/media/${seoRow.og_image_asset_id}/${v.variant}`;
        void ext;
      }
    }
    // P9 — preview matches the static generator: explicit hreflang
    // overrides win, otherwise auto-compute from sibling-locale pages
    // for the same slug. Locale registry drives URL strategy.
    const localeRows = (await tx.execute(sql`
      SELECT code, url_strategy, url_host, is_default FROM locales
    `)) as unknown as {
      code: string;
      url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
      url_host: string | null;
      is_default: boolean;
    }[];
    const localeByCode = new Map(
      localeRows.map((r) => [
        r.code,
        {
          code: r.code,
          urlStrategy: r.url_strategy,
          urlHost: r.url_host,
          isDefault: r.is_default,
        },
      ]),
    );
    const explicitHreflang = (await tx.execute(sql`
      SELECT locale, url FROM pages_hreflang
      WHERE page_id = ${input.pageId}::uuid
      ORDER BY locale
    `)) as unknown as { locale: string; url: string }[];
    let hreflang: { locale: string; url: string }[];
    if (explicitHreflang.length > 0) {
      hreflang = explicitHreflang.map((r) => ({ locale: r.locale, url: r.url }));
    } else {
      // Preview mirrors the static generator: only published variants
      // count toward hreflang per CMS_REQUIREMENTS §7.3.
      const siblings = (await tx.execute(sql`
        SELECT locale FROM pages
        WHERE slug = ${pageRow.slug}
          AND deleted_at IS NULL
          AND status = 'published'
      `)) as unknown as { locale: string }[];
      hreflang = [];
      for (const s of siblings) {
        const cfg = localeByCode.get(s.locale);
        if (!cfg) continue;
        try {
          hreflang.push({
            locale: s.locale,
            url: resolveLocaleUrl(
              {
                code: cfg.code,
                displayName: cfg.code,
                urlStrategy: cfg.urlStrategy,
                urlHost: cfg.urlHost,
                isDefault: cfg.isDefault,
              },
              pageRow.slug,
              siteBaseUrl,
            ),
          });
        } catch {
          // Misconfigured locale — skip its hreflang entry.
        }
      }
    }
    const canonical = resolveCanonicalUrl({
      siteBaseUrl,
      pageSlug: pageRow.slug,
      pageLocale: pageRow.locale,
      override: seoRow?.canonical_url ?? null,
      localeConfig: localeByCode.get(pageRow.locale),
    });
    const headBlock = renderSeoHead({
      title: pageRow.title,
      metaDescription: seoRow?.meta_description ?? "",
      canonical,
      noindex: seoRow?.noindex ?? false,
      ogImageUrl,
      hreflang,
      organization,
    });
    html = injectSeoIntoHead(html, headBlock);

    return ok({
      html,
      replacedSlots: [...composed.replacedSlots],
      missingSlots: [...composed.missingSlots],
      pageSlug: pageRow.slug,
      pageLocale: pageRow.locale,
    });
  },
});
