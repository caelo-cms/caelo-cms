// SPDX-License-Identifier: MPL-2.0

/**
 * Render a page to composed HTML for the admin preview iframe.
 *
 * Read-only — no audit row, same convention as `users.list`. Returns an
 * object (per the `defineReadOperation` shape); the route handler
 * unwraps `html` into a `text/html` response.
 *
 * P6.7 — accepts an optional `chatBranchId`. When set, every module
 * referenced by the page is resolved against the latest branch snapshot
 * for that branch (P5 schema); modules with no branch snapshot fall
 * back to the live `modules` row. Lets the live-edit overlay's iframe
 * render the post-AI-edit view of a page without requiring publish.
 *
 * Issue #1212 — a read operation: it holds NO transaction while plugins
 * answer, fonts resolve or the page composes. A render reads in short
 * transactions —
 *
 *   1. the site view (`site-view.ts`, cached per branch and generation)
 *      and the page bundle (`preview-page-load.ts`);
 *   2. only when the plugin answers name something not loaded yet: the
 *      modules of list entries and content variants;
 *   3. font bytes, one short read each (`resolveThemeFonts`);
 *   4. only when the composed page embeds media: the image variants;
 *
 * — and asks every plugin in between, holding nothing. Before, ~10 plugin
 * calls ran inside one held transaction and each plugin storage access
 * took a second connection from the same pool: ten concurrent previews
 * on a pool of ten deadlocked for good (#1209).
 */

import { fontReader } from "@caelo-cms/font-service";
import {
  collectBuildAssets,
  collectContributions,
  composeHeadBlock,
  createPluginRenderFailureSink,
  dormantListSourceNames,
  injectPluginAssets,
  pluginNotRunningMarker,
  pluginRenderFailedMarker,
  pluginsNotRunningHere,
  type RenderScope,
  reportListOverlayIssues,
  resolveListSources,
  resolveModuleDeferrals,
  resolvePublicPageUrls,
} from "@caelo-cms/plugin-host";
import type { DeferralCandidate } from "@caelo-cms/plugin-sdk";
import { defineReadOperation, type QueryError, type ReadScope } from "@caelo-cms/query-api";
import {
  applyDocumentLanguage,
  buildMediaUrl,
  ComposeError,
  type ComposeFonts,
  collectListModuleRefs,
  composePageWithLayout,
  createListRenderContext,
  type ExecutionContext,
  enrichResponsiveImages,
  err,
  extractMediaRefs,
  finalizeEditMarkers,
  fontUnresolvableMarker,
  type ImageVariantInfo,
  injectSeoIntoHead,
  isListFailureMarker,
  linkMarkersOf,
  listThemeCssVarNames,
  type NestedModuleResource,
  type NestedRenderResolver,
  ok,
  type PaginationRequest,
  pagedPath,
  pagedUrl,
  paginationMarkers,
  parsePagedPath,
  type Result,
  renderModuleWithContent,
  renderSeoHead,
  resolveDocumentLanguage,
  type SiteSeoSettings,
  scanCssVars,
  type TemplateField,
  unknownCssVarMarker,
  wrapEditableValues,
} from "@caelo-cms/shared";
import {
  defaultFontsCacheDir,
  followUpHeadEntries,
  loadSiteFontUsage,
  resolveThemeFonts,
  withListOverlays,
} from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { previewLinkIndexOf, siteViewDriftPaths } from "../../links/link-targets.js";
import {
  listRenderDataOf,
  resolveLinkPartition,
  resolvePageListOverlays,
} from "../../lists/load.js";
import { pageListOverlayScope } from "../../lists/overlay-scope.js";
import { loadSiteView, type SiteView } from "../../site-view.js";
import { previewBreadcrumbs } from "./preview-breadcrumbs.js";
import {
  expandNestedResources,
  hasUnloadedRefs,
  loadPreviewPage,
  PreviewLoadError,
  type PreviewPageBundle,
  parseFields,
} from "./preview-page-load.js";
import {
  askContentVariants,
  finishContentVariants,
  loadVariantModules,
} from "./preview-variants.js";

const OP = "pages.render_preview";

const inputSchema = z
  .object({
    /** The page to render. Give this or `path`. */
    pageId: z.string().uuid().optional(),
    /**
     * #390 / #1212 — the page at this public path in the caller's view
     * (`/`, `/de/about`): its `current_path`, or for a page a pending
     * rename or move changes, the path the chat gives it. Give this or
     * `pageId`.
     */
    path: z.string().startsWith("/").max(2048).optional(),
    chatBranchId: z.string().uuid().optional(),
    /**
     * P6.6b deferred — module ids whose branch state should be skipped
     * when rendering (the chat-side diff's partial view). Accepted for the
     * diff panel's URL contract; not applied yet.
     */
    excludeBranchModules: z.array(z.string().uuid()).optional(),
    /**
     * #917 — mark which placement + field each piece of page text came
     * from (HTML comments, see `edit-markers.ts`) so the Live Edit
     * preview can edit it in place. Only the editor's preview iframe
     * sets this; published output never carries markers.
     */
    editMarkers: z.boolean().optional(),
    /**
     * #1257 — page `n` ≥ 2 of a paginated overview given by `pageId` (a
     * `path` names it as `<overview path>/page/<n>`).
     */
    pageNumber: z.number().int().min(2).optional(),
  })
  .strict()
  .refine((v) => (v.pageId === undefined) !== (v.path === undefined), {
    message: "give exactly one of pageId or path",
  });

const outputSchema = z.object({
  html: z.string(),
  replacedSlots: z.array(z.string()),
  missingSlots: z.array(z.string()),
  /**
   * #1087 — plugins whose contribution this render left out because
   * their call failed (each also flagged as `plugin-render-failed:<slug>`
   * in missingSlots). The preview routes show them in the banner.
   */
  pluginFailures: z.array(z.object({ slug: z.string(), reason: z.string() })),
  pageId: z.string(),
  pageSlug: z.string(),
  /** The page's public path in the caller's view (what `path` looks up). */
  pagePath: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

function failure(message: string): Result<Output, QueryError> {
  return err({ kind: "HandlerError", operation: OP, message });
}

export const renderPagePreviewOp = defineReadOperation({
  name: OP,
  // CLAUDE.md §11: read-only render. AI runs preview to verify edits
  // before publishing — same path as the iframe in /content/pages/[id].
  actorScope: ["human", "ai", "system"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx, input, reads) => {
    try {
      return await renderPreview(ctx, input, reads);
    } catch (e) {
      if (e instanceof PreviewLoadError || e instanceof ComposeError) return failure(e.message);
      throw e;
    }
  },
});

/**
 * The page `path` names in the view, and which page of its sequence:
 * a page's own path, else (#1257) a follow-up page of a paginated
 * overview (`/guides/page/2` → the overview at `/guides`, page 2 — a
 * page actually at that path wins). Whether the overview HAS that page
 * is decided by its render.
 */
function pageAtPathOrFollowUp(
  view: SiteView,
  driftPaths: ReadonlyMap<string, string>,
  path: string,
): { pageId: string; page: number } | null {
  const own = pageAtPath(view, driftPaths, path);
  if (own !== null) return { pageId: own, page: 1 };
  const paged = parsePagedPath(path);
  if (paged === null) return null;
  const base = pageAtPath(view, driftPaths, paged.basePath);
  return base === null ? null : { pageId: base, page: paged.page };
}

/**
 * The page `path` names in the view: the composed-path match, else — for
 * pre-#390 bookmarks — the one top-level page with that slug. Top-level
 * only (a nested page's URL is its parent chain + slug) and only while
 * exactly one matches: slugs repeat across URL prefixes (epic #690), and a
 * guess would open the wrong page.
 */
function pageAtPath(
  view: SiteView,
  driftPaths: ReadonlyMap<string, string>,
  path: string,
): string | null {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const lookupPath = trimmed.length === 0 ? "/" : `/${trimmed}`;
  const exact = view.pages.find((p) => (driftPaths.get(p.id) ?? p.currentPath) === lookupPath);
  if (exact) return exact.id;
  const slug = trimmed.length === 0 ? "home" : trimmed;
  const legacy = view.pages.filter((p) => p.parentPageId === null && p.slug === slug);
  return legacy.length === 1 ? (legacy[0]?.id ?? null) : null;
}

async function renderPreview(
  ctx: ExecutionContext,
  input: Input,
  reads: ReadScope,
): Promise<Result<Output, QueryError>> {
  // Run #8 live-edit CI — ONE effective branch for the whole render: the
  // /edit iframe calls with the operator's ctx (no branch) and the branch
  // in the INPUT; either source widens visibility AND drives the overlays,
  // so the two can never disagree.
  const chatBranchId = input.chatBranchId ?? ctx.chatBranchId ?? null;
  const editMarkers = input.editMarkers === true;
  // Plugin render hooks show the same branch as the core rows. #1087 — a
  // plugin whose call fails is left out of THIS render and flagged instead
  // of aborting the preview: a plugin's errors block Publish live (the
  // build throws), never the editor's view of a page.
  const pluginFailureSink = createPluginRenderFailureSink();
  const renderScope: RenderScope = {
    chatBranchId,
    onPluginFailure: pluginFailureSink.onPluginFailure,
    editorPreview: true,
    // #1213 — one pass: plugins may read their data once for all of
    // this render's composition points instead of once per point.
    renderId: crypto.randomUUID(),
  };
  const loadPage = (tx: Parameters<Parameters<ReadScope["read"]>[0]>[0], pageId: string) =>
    loadPreviewPage(tx, { pageId, chatBranchId, editMarkers });

  // 1. The site view, and the page when its id is known.
  const first = await reads.read(async (tx) => {
    const view = await loadSiteView(tx, chatBranchId);
    return { view, page: input.pageId ? await loadPage(tx, input.pageId) : null };
  });
  const view = first.view;
  const driftPaths = await siteViewDriftPaths(view, renderScope);
  let page: PreviewPageBundle;
  let requestedPage = input.pageNumber ?? 1;
  if (first.page) {
    page = first.page;
  } else {
    const found = pageAtPathOrFollowUp(view, driftPaths, input.path as string);
    if (found === null) return failure("page not found");
    requestedPage = found.page;
    page = await reads.read((tx) => loadPage(tx, found.pageId));
  }
  const pageId = page.pageRow.page_id;
  const { pageRow, modRows, layoutModRows, placementBindings, resources, pageUrlStyle } = page;
  const instanceByIdResource = resources.instances;
  const moduleByIdResource = resources.modules;

  // 2. Plugins, with no connection held. Epic #1107 — the lists this
  // render resolves; epic #724 — internal references resolve against the
  // chat's view of the site in the publish target's URL style, so a link
  // in the iframe navigates to the path `path` looks up. The list
  // overlays come later (#1223), once the page's modules are known.
  const pageVariants = await resolveLinkPartition(
    view.pages.map((p) => p.id),
    renderScope,
  );
  const baseListData = listRenderDataOf(view, pageVariants ? { pageVariants } : {});
  const linkResolver = previewLinkIndexOf({
    view,
    driftPaths,
    pageVariants,
    env: "preview",
    pageUrlStyle,
  }).forPage(pageId);
  // Plugin list sources for THIS page: the editor preview must show the
  // same thing the deploy will, including the loud marker when a plugin
  // whose source a module iterates has been switched off.
  const resolvedSources = await resolveListSources([pageId], renderScope, pageUrlStyle);
  // #592 — content variants: which chrome and which shared content this
  // page shows (e.g. the footer in the page's language). Same keys and
  // payload as the static generator's pass.
  const variantAnswers = await askContentVariants({
    pageId,
    layoutId: pageRow.layout_id,
    layoutModRows,
    modRows,
    placementBindings,
    valuesByInstance: page.valuesByInstance,
    chatBranchId,
    renderScope,
  });

  // Shared list entries can embed modules, and a variant can render
  // another module: loaded now, in a second short read, only when needed.
  const listSeeds = [{ listRefs: collectListModuleRefs(baseListData) }];
  const needsListModules = hasUnloadedRefs(resources, listSeeds);
  const variantModules =
    needsListModules || variantAnswers.moduleIds.length > 0
      ? await reads.read(async (tx) => {
          if (needsListModules) {
            await expandNestedResources(tx, resources, listSeeds, chatBranchId);
          }
          return loadVariantModules(tx, variantAnswers.moduleIds, chatBranchId);
        })
      : new Map();
  const variants = finishContentVariants(variantAnswers, variantModules);

  // #1223 — the list overlays of this page's variant, for what the page
  // can show from lists; none asked when it shows nothing a list overlay
  // changes. Before the variant values below get render-local ids.
  const overlaySources = await resolvePageListOverlays(
    pageVariants?.get(pageId)?.variant,
    pageListOverlayScope({
      pageId,
      data: baseListData,
      modules: [
        ...resources.modules.values(),
        ...layoutModRows.map((m) => ({ fields: parseFields(m.fields), html: m.html })),
        ...[...variantModules.values()].map((m) => ({
          fields: parseFields(m.fields),
          html: m.html,
        })),
      ],
      markup: [pageRow.template_html, pageRow.layout_html],
      contentInstanceIds: instanceByIdResource.keys(),
    }),
    renderScope,
  );
  const listData = withListOverlays(baseListData, overlaySources);

  const listContext = createListRenderContext(listData, {
    dormantPluginSources: dormantListSourceNames(),
  });
  for (const [key, values] of variants.pageValues) {
    const binding = placementBindings.get(key);
    const m = modRows.find((r) => `${r.block_name}#${r.position}` === key);
    if (!binding || !m) continue;
    const id = `variant:${key}`;
    instanceByIdResource.set(id, { id, moduleId: m.module_id, values, deletedAt: null });
    placementBindings.set(key, { ...binding, contentInstanceId: id });
  }

  const resolver: NestedRenderResolver = {
    getModule: (id) => moduleByIdResource.get(id) ?? null,
    getContentInstance: (id) => instanceByIdResource.get(id) ?? null,
  };
  const composeTheme = page.theme;
  const renderThemeAssets = composeTheme
    ? {
        logo: composeTheme.assets.logo?.url ?? null,
        logoDark: composeTheme.assets.logoDark?.url ?? null,
        favicon: composeTheme.assets.favicon?.url ?? null,
        socialShare: composeTheme.assets.socialShare?.url ?? null,
      }
    : undefined;

  // #917 — a copy of the placement's instance whose plain-text values
  // carry edit-marker sentinels, registered under its own id so the real
  // instance (which a nested slot elsewhere may also render) stays
  // untouched. Variant content (#592) is resolved, not stored on this
  // placement, so it is not editable in place.
  function editMarkedInstance(
    key: string,
    binding: { contentInstanceId: string },
    moduleId: string,
  ): string | null {
    if (binding.contentInstanceId.startsWith("variant:")) return null;
    const ci = instanceByIdResource.get(binding.contentInstanceId);
    const mod = moduleByIdResource.get(moduleId);
    if (!ci || !mod) return null;
    const id = `edit:${key}`;
    instanceByIdResource.set(id, {
      ...ci,
      id,
      listHolderId: ci.listHolderId ?? ci.id,
      values: wrapEditableValues(
        ci.values,
        mod.fields,
        (slug) => listData.listTypes.get(slug)?.def,
      ),
    });
    return id;
  }

  const layoutGrouped = new Map<
    string,
    {
      moduleId: string;
      slug: string;
      displayName: string;
      html: string;
      css: string;
      js: string;
      fields: TemplateField[];
      contentValues?: Record<string, unknown>;
    }[]
  >();
  for (const r of layoutModRows) {
    const arr = layoutGrouped.get(r.block_name) ?? [];
    // #592 — a locale's chrome may render other values or another module.
    const override = variants.layout.get(`layout:${r.block_name}:${arr.length}`);
    const src = override?.module ?? r;
    arr.push({
      moduleId: src.module_id,
      slug: src.slug,
      displayName: src.display_name,
      html: src.html,
      css: src.css,
      js: src.js,
      fields: parseFields(src.fields),
      ...(override?.values !== undefined ? { contentValues: override.values } : {}),
    });
    layoutGrouped.set(r.block_name, arr);
  }
  const layoutBlocks = [...layoutGrouped.entries()].map(([blockName, modules]) => ({
    blockName,
    modules,
  }));

  // issue #150 — preview/production font parity: the theme's web fonts
  // through the SAME resolver the static generator uses, served from the
  // admin's /_caelo/fonts route. Unresolvable families do NOT fail the
  // preview; they surface as `theme-font-unresolvable:<family>` (loud,
  // CLAUDE.md §2) and the deploy path hard-fails on the same state. Each
  // font read is a short transaction of its own (#1212): the resolver
  // does disk and network I/O between them.
  const settings = view.settings;
  let previewFonts: ComposeFonts | undefined;
  const fontMarkers: string[] = [];
  if (composeTheme !== undefined) {
    const themeTokens = composeTheme.tokens;
    const resolvedFonts = await resolveThemeFonts({
      readFont: (ref) => reads.read((tx) => fontReader(tx)(ref)),
      tokens: composeTheme.tokens,
      // Same loader as the build: the preview instances faces exactly as
      // the deployed site will (preview/production parity).
      loadFontUsage: () => reads.read((tx) => loadSiteFontUsage(tx, themeTokens)),
      cacheDir: defaultFontsCacheDir(process.cwd()),
      publicBasePath: "/_caelo/fonts",
      // Same preload as the build (#1065): the composed render is what
      // inspect_page_render reports as the page's HTML.
      preloadLanguage: settings.siteLanguage,
    });
    if (resolvedFonts.css.length > 0) {
      previewFonts = { css: resolvedFonts.css, preloads: resolvedFonts.preloads };
    }
    for (const family of resolvedFonts.unresolved) fontMarkers.push(fontUnresolvableMarker(family));
  }

  // #1257 — one render of the page body. A paginated overview may render
  // twice (the pager came before the list, or a follow-up page is asked
  // for): see `renderFirstPage` in shared `lists/paginated-render.ts`.
  const renderBody = async (pagination?: PaginationRequest) => {
    const lists = listContext.forPage(pageId, {
      linkResolver,
      pluginSources: resolvedSources.get(pageId) ?? {},
      pageUrlStyle,
      ...(pagination ? { pagination } : {}),
    });
    const htmlByRow = new Map<(typeof modRows)[number], string>();
    const nestedCssJsByModuleId = new Map<string, NestedModuleResource>();
    // Epic #724 — broken internal references of the page's modules; the
    // layout modules' and nav menus' join from the composer's failures.
    const pageLinkMarkers: string[] = [];
    // Epic #1107 — an unbound / deleted / malformed list of a page module
    // or of the chrome: loud on the missing-content surface too.
    const pageListMarkers: string[] = [];
    for (const m of modRows) {
      const key = `${m.block_name}#${m.position}`;
      const binding = placementBindings.get(key);
      if (!binding) {
        htmlByRow.set(m, "");
        continue;
      }
      const markers = editMarkers ? editMarkedInstance(key, binding, m.module_id) : null;
      const result = renderModuleWithContent(
        m.module_id,
        markers ?? binding.contentInstanceId,
        resolver,
        renderThemeAssets,
        lists,
        linkResolver,
      );
      const html = markers
        ? finalizeEditMarkers(
            result.html,
            key,
            // A synced placement this chat created is not in live
            // page_modules yet: then this page is the only one showing it.
            binding.synced ? (page.sharedPageCounts.get(binding.contentInstanceId) ?? 1) : 0,
          )
        : result.html;
      htmlByRow.set(m, html);
      pageLinkMarkers.push(...linkMarkersOf(result.missingSlots));
      pageListMarkers.push(...result.missingSlots.filter(isListFailureMarker));
      // Every module the recursion touched gets its CSS/JS staged (the
      // composer dedupes by moduleId, issue #158) through a virtual
      // "__nested__" block below; their HTML is already inline.
      for (const touchedId of result.touchedModuleIds) {
        if (touchedId === m.module_id) continue;
        const mod = moduleByIdResource.get(touchedId);
        if (!mod || (!mod.css && !mod.js)) continue;
        if (!nestedCssJsByModuleId.has(touchedId)) nestedCssJsByModuleId.set(touchedId, mod);
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
        html: htmlByRow.get(r) ?? "",
        css: r.css,
        js: r.js,
      });
      grouped.set(r.block_name, arr);
    }
    // v0.12.1 — nested-module CSS/JS in a virtual block (html '' to avoid
    // double-rendering: renderModuleWithContent inlined it).
    if (nestedCssJsByModuleId.size > 0) {
      const arr = grouped.get("__nested__") ?? [];
      for (const m of nestedCssJsByModuleId.values()) {
        arr.push({
          moduleId: m.moduleId,
          slug: m.slug,
          displayName: m.slug,
          html: "",
          css: m.css,
          js: m.js,
        });
      }
      grouped.set("__nested__", arr);
    }
    const blocks = [...grouped.entries()].map(([blockName, modules]) => ({ blockName, modules }));

    // #450 — which of this page's modules is a plugin withholding? The
    // editor has to see the placeholder the visitor will see; a module the
    // visitor gets nothing for shows the plugin's editor notice instead
    // (renderScope.editorPreview), so its absence is explained here. The gate
    // judges the content about to render: page modules arrive with their
    // values substituted into `html`; layout modules carry `fields`, whose
    // defaults the composer substitutes.
    const candidates = new Map<string, DeferralCandidate>();
    for (const m of [...blocks, ...layoutBlocks].flatMap((b) => b.modules)) {
      if (candidates.has(m.moduleId)) continue;
      candidates.set(m.moduleId, {
        moduleId: m.moduleId,
        html: m.html,
        css: m.css,
        js: m.js,
        fields: "fields" in m ? m.fields : [],
        contentValues: [],
      });
    }
    const deferredModules = Object.fromEntries(
      await resolveModuleDeferrals([...candidates.values()], renderScope),
    );

    const composed = composePageWithLayout({
      deferredModules,
      // Page-block modules already had their lists applied; LAYOUT modules
      // reach the composer raw, so it needs the list context and the nested
      // resolver too (the generator passes the same two).
      lists,
      nestedModules: resolver,
      templateHtml: pageRow.template_html,
      templateCss: pageRow.template_css,
      blocks,
      theme: composeTheme,
      fonts: previewFonts,
      layoutHtml: pageRow.layout_html,
      layoutCss: pageRow.layout_css,
      layoutBlocks,
      layoutSlug: pageRow.layout_slug,
      linkResolver,
    });
    return { lists, composed, pageLinkMarkers, pageListMarkers };
  };
  let body = await renderBody();
  const firstPagination = body.lists.pagination();
  if (requestedPage > 1) {
    // A follow-up page exists only while the list needs it.
    if (firstPagination === null || requestedPage > firstPagination.pageCount) {
      return failure("page not found");
    }
    body = await renderBody({ page: requestedPage, pageCount: firstPagination.pageCount });
  } else if (firstPagination?.pagerEarly && firstPagination.pageCount > 1) {
    body = await renderBody({ page: 1, pageCount: firstPagination.pageCount });
  }
  const { lists, composed, pageLinkMarkers, pageListMarkers } = body;
  const pagination = lists.pagination();
  // Epic #1107 — overlay entries this render refused are the plugin's
  // fault: the stored value rendered, and the plugin's error channel
  // (plugin_errors → list_plugins, Settings → Plugins) names them.
  const refusedOverlays = lists.overlayIssues();
  if (refusedOverlays.length > 0 && listData.overlaySources) {
    await reportListOverlayIssues(listData.overlaySources, refusedOverlays);
  }

  // issue #162 — preview/production image parity: the SAME srcset/sizes/
  // loading/decoding enrichment as the generator's media pass, with URLs
  // kept on the admin's media route. Refs are slugs (current embeds) or
  // legacy UUID ids; the enrichment map is keyed by the ref as it appears.
  let html = await enrichPreviewImages(composed.html, view, reads);

  // P8 review-pass — preview parity with the static deploy (SEO meta,
  // canonical, OG, JSON-LD). Unfilled SEO is tolerated.
  let organization: SiteSeoSettings["organization"] = {};
  if (settings.organizationJson) {
    try {
      organization = JSON.parse(settings.organizationJson) as SiteSeoSettings["organization"];
    } catch {
      organization = {};
    }
  }
  // #551 — no substituted base URL: unset, the preview renders without
  // canonical / og:url / plugin head contributions and flags it; the
  // static generator refuses to build in that state. Migration 0232 —
  // likewise for the site language.
  const siteBaseUrl = settings.siteBaseUrl;
  const seoMarkers: string[] = siteBaseUrl ? [] : ["site-base-url-unset"];
  if (!settings.siteLanguage) seoMarkers.push("site-language-unset");

  // #390 — canonical follows the MATERIALIZED composed path; #590 —
  // through the same builder as the generator and plugin hreflang.
  // #1257 — a follow-up page is self-canonical (never the override).
  const followUp = requestedPage > 1 ? requestedPage : null;
  const canonicalOverride = followUp === null ? page.seo?.canonicalUrl || null : null;
  const canonical = siteBaseUrl
    ? ((
        await resolvePublicPageUrls(
          [
            {
              id: pageId,
              slug: pageRow.slug,
              currentPath: pageRow.current_path,
              canonicalOverride,
            },
          ],
          { siteBaseUrl, pageUrlStyle },
          renderScope,
        )
      ).get(pageId) ?? null)
    : canonicalOverride;
  const headBlock = renderSeoHead({
    title: pageRow.title,
    metaDescription: page.seo?.metaDescription ?? "",
    canonical:
      followUp !== null && canonical !== null
        ? pagedUrl(canonical, followUp, pageUrlStyle)
        : canonical,
    noindex:
      (page.seo?.noindex ?? false) || (followUp !== null && pagination?.followUps === "noindex"),
    ogImageUrl: page.ogImageUrl,
    organization,
    breadcrumbs: siteBaseUrl
      ? await previewBreadcrumbs(view, lists.breadcrumbTrail(), {
          siteBaseUrl,
          pageUrlStyle,
          renderScope,
        })
      : null,
  });
  // #391 — plugin head contributions ride the SAME compose call the static
  // generator uses (byte parity by construction). They need absolute URLs:
  // with no base URL none are collected and `<html lang>` carries the
  // stored site language (or none).
  const contributions = siteBaseUrl
    ? await collectContributions([pageId], { siteBaseUrl, pageUrlStyle, ...renderScope })
    : null;
  const contributedHead = contributions?.head.get(pageId);
  html = injectSeoIntoHead(
    html,
    composeHeadBlock(
      headBlock,
      followUp === null ? contributedHead : followUpHeadEntries(contributedHead),
    ),
  );
  html = applyDocumentLanguage(
    html,
    resolveDocumentLanguage({
      contributed: contributions?.lang.get(pageId),
      siteLanguage: settings.siteLanguage,
    }),
  );

  // #449 — plugin client assets. The deploy LINKS these files; the preview
  // iframe inlines the identical bytes (same resolver), so the editor can
  // never show behaviour the deployed site won't have.
  html = injectPluginAssets(html, await collectBuildAssets([pageId], renderScope), "inline");

  // issue #156 — unknown `var(--…)` references in the page's CSS bundle
  // (layout + template + placed modules), scanned as one bundle so custom
  // properties the layout defines count as known.
  const cssVarMarkers: string[] = [];
  if (composeTheme !== undefined) {
    const cssBundle = [
      pageRow.layout_css,
      pageRow.template_css,
      ...modRows.map((m) => m.css),
      ...layoutModRows.map((m) => m.css),
    ].join("\n");
    for (const u of scanCssVars({
      css: cssBundle,
      knownVars: listThemeCssVarNames(composeTheme.tokens),
    })) {
      cssVarMarkers.push(unknownCssVarMarker(u.name));
    }
  }

  return ok({
    html,
    replacedSlots: [...composed.replacedSlots],
    // issue #150 + #156 — unresolvable web fonts and unknown CSS vars ride
    // the missing-content surface, same convention as theme-asset-unbound.
    missingSlots: [
      ...composed.missingSlots,
      ...variants.markers,
      ...fontMarkers,
      ...cssVarMarkers,
      ...seoMarkers,
      // #1008 — an active plugin this server could not load renders
      // without its contribution; loud here (and Publish live refuses).
      ...pluginsNotRunningHere().map((p) => pluginNotRunningMarker(p.slug)),
      // #1087 — a plugin that runs here but failed during this render.
      ...new Set(pluginFailureSink.failures().map((f) => pluginRenderFailedMarker(f.slug))),
      // Epic #724 — `link-target-missing:<kind>/<id>`, once per target.
      ...new Set([
        ...pageLinkMarkers,
        ...linkMarkersOf(composed.moduleFailures.map((f) => f.reason)),
      ]),
      ...new Set([
        ...pageListMarkers,
        // #1257 — a paginated page without a pager strands its entries.
        ...paginationMarkers(pagination),
        ...composed.moduleFailures.map((f) => f.reason).filter(isListFailureMarker),
      ]),
    ],
    pluginFailures: pluginFailureSink.failures().map((f) => ({ slug: f.slug, reason: f.reason })),
    pageId,
    pageSlug: pageRow.slug,
    pagePath:
      followUp === null
        ? (driftPaths.get(pageId) ?? pageRow.current_path)
        : pagedPath(driftPaths.get(pageId) ?? pageRow.current_path, followUp),
  });
}

/**
 * Responsive-image enrichment of the composed page (issue #162). Slugs
 * resolve through the site view; only the variants of the assets the page
 * embeds are read, in one short transaction (none for a page without
 * images).
 */
async function enrichPreviewImages(
  html: string,
  view: SiteView,
  reads: ReadScope,
): Promise<string> {
  const refs = extractMediaRefs(html);
  if (refs.length === 0) return html;
  const idBySlug = new Map(view.media.map((m) => [m.slug, m.id]));
  const slugToId = new Map<string, string>();
  const legacyIdRefs = new Set<string>();
  for (const r of refs) {
    if (!r.isSlug) {
      legacyIdRefs.add(r.ref);
      continue;
    }
    const id = idBySlug.get(r.ref);
    if (id !== undefined) slugToId.set(r.ref, id);
  }
  const assetIds = [...new Set([...legacyIdRefs, ...slugToId.values()])];
  if (assetIds.length === 0) return html;
  const variantRows = await reads.read(
    async (tx) =>
      (await tx.execute(sql`
        SELECT asset_id::text AS asset_id, variant, format, width
        FROM media_variants
        WHERE asset_id IN (${sql.join(
          assetIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `)) as unknown as {
        asset_id: string;
        variant: string;
        format: string;
        width: number | null;
      }[],
  );
  const variantsById = new Map<string, ImageVariantInfo[]>();
  for (const r of variantRows) {
    const list = variantsById.get(r.asset_id) ?? [];
    list.push({ variant: r.variant, format: r.format, width: r.width });
    variantsById.set(r.asset_id, list);
  }
  const variantsByRef = new Map<string, ImageVariantInfo[]>();
  for (const [slug, id] of slugToId) variantsByRef.set(slug, variantsById.get(id) ?? []);
  for (const id of legacyIdRefs) variantsByRef.set(id, variantsById.get(id) ?? []);
  return enrichResponsiveImages(html, variantsByRef, {
    rewriteSrc: false,
    urlFor: (ref, variant) => buildMediaUrl(ref, variant),
  });
}
