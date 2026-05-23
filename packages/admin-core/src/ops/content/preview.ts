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

interface ModuleSourceRow {
  block_name: string;
  position: number;
  module_id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
  /** v0.4.0 — module field schema (drives placeholder substitution). */
  fields: unknown;
}


/**
 * v0.4.0 — Substitute `{{fieldName}}` placeholders in module HTML using
 * the resolved content values for one placement. Missing keys fall back to
 * the module field's `default` (then empty string).
 *
 * Only handles top-level fields; nested objects / arrays are surfaced as
 * JSON-stringified text for visibility (rare in practice — `richtext` /
 * `image` / `link` values are strings/objects depending on the kind, but
 * stringification gives a non-empty default render).
 */
function substituteFields(
  html: string,
  fields: { name: string; default?: unknown }[],
  contentValues: Record<string, unknown>,
): string {
  if (fields.length === 0) return html;
  return html.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (full, name: string) => {
    if (Object.hasOwn(contentValues, name)) {
      const v = contentValues[name];
      return v === null || v === undefined ? "" : String(v);
    }
    const field = fields.find((f) => f.name === name);
    if (field && field.default !== undefined && field.default !== null) {
      return String(field.default);
    }
    // Unknown / unresolved placeholder — leave the literal so the operator
    // notices it visually. Pre-v1 fail-loud per CLAUDE.md §2.
    return full;
  });
}

function parseFields(raw: unknown): { name: string; default?: unknown }[] {
  const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((f): f is { name: string; default?: unknown } => {
      return (
        typeof f === "object" && f !== null && typeof (f as { name: unknown }).name === "string"
      );
    })
    .map((f) => ({ name: f.name, default: (f as { default?: unknown }).default }));
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
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware preview. The iframe shows the caller's
    // branched-create pages / templates / layouts (in addition to
    // main). Without this filter, a brand-new chat that just created
    // its first page+template+layout would fail to render because
    // the JOIN'd live rows are branched to the chat (invisible to
    // an unfiltered query when chat_branch_id is set on this row).
    const branchScope = ctx.chatBranchId
      ? sql`AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)
            AND (t.chat_branch_id IS NULL OR t.chat_branch_id = ${ctx.chatBranchId}::uuid)
            AND (l.chat_branch_id IS NULL OR l.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`AND p.chat_branch_id IS NULL AND t.chat_branch_id IS NULL AND l.chat_branch_id IS NULL`;
    const pageRows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, p.slug AS slug, p.locale AS locale, p.title AS title,
             t.html AS template_html, t.css AS template_css,
             l.id::text AS layout_id, l.slug AS layout_slug,
             l.html AS layout_html, l.css AS layout_css
      FROM pages p
      JOIN templates t ON t.id = p.template_id
      JOIN layouts l   ON l.id = t.layout_id
      WHERE p.id = ${input.pageId}::uuid AND p.deleted_at IS NULL ${branchScope}
      LIMIT 1
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

    // v0.5.5 — page meta overlay. v0.5.3 branched pages.update writes
    // slug/title into page_snapshots but the live join above still
    // carries the pre-branch values; iframe <title> + URL composition
    // would leak the live slug/title to a chat that renamed the page.
    // Overlay slug + title only — templateId overlay (which would
    // cascade through template_html / layout_html) is out of scope
    // until pages.change_template branching lands.
    if (input.chatBranchId) {
      const snap = (await tx.execute(sql`
        SELECT state FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
        WHERE ps.page_id = ${input.pageId}::uuid
          AND ss.chat_branch_id = ${input.chatBranchId}::uuid
        ORDER BY ss.created_at DESC LIMIT 1
      `)) as unknown as { state: unknown }[];
      const raw = snap[0]?.state;
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const s = parsed as { slug?: string; title?: string };
        if (s.slug) pageRow.slug = s.slug;
        if (s.title) pageRow.title = s.title;
      }
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

    let modRows = (await tx.execute(sql`
      SELECT pm.block_name AS block_name,
             pm.position AS position,
             m.id::text AS module_id,
             m.slug AS slug,
             m.display_name AS display_name,
             m.html AS html,
             m.css AS css,
             m.js AS js,
             m.fields AS fields
      FROM page_modules pm JOIN modules m ON m.id = pm.module_id
      WHERE pm.page_id = ${input.pageId}::uuid AND m.deleted_at IS NULL
      ORDER BY pm.block_name ASC, pm.position ASC
    `)) as unknown as ModuleSourceRow[];

    // v0.5.3 — page layout overlay: when the caller's chat has a
    // branched page_layout_snapshot for this page, replace the live
    // page_modules ordering with the snapshot's blocks/moduleIds.
    // Module rows (html/css/js) still join from `modules`; the module
    // overlay below applies branched module CODE on top.
    if (input.chatBranchId) {
      const layoutSnap = (await tx.execute(sql`
        SELECT state FROM page_layout_snapshots pls
        JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
        WHERE pls.page_id = ${input.pageId}::uuid
          AND ss.chat_branch_id = ${input.chatBranchId}::uuid
        ORDER BY ss.created_at DESC
        LIMIT 1
      `)) as unknown as { state: unknown }[];
      const raw = layoutSnap[0]?.state;
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const blocks = (parsed as { blocks?: { blockName: string; moduleIds: string[] }[] }).blocks;
        if (Array.isArray(blocks)) {
          const moduleIds = [...new Set(blocks.flatMap((b) => b.moduleIds))];
          if (moduleIds.length === 0) {
            modRows = [];
          } else {
            const byId = new Map<string, ModuleSourceRow>();
            // v0.9.0 — branch-aware module fetch so chat sees its
            // own branched-create modules in the iframe.
            const moduleBranchScope = ctx.chatBranchId
              ? sql`AND (m.chat_branch_id IS NULL OR m.chat_branch_id = ${ctx.chatBranchId}::uuid)`
              : sql`AND m.chat_branch_id IS NULL`;
            const fetched = (await tx.execute(sql`
              SELECT m.id::text AS module_id, m.slug AS slug, m.display_name AS display_name,
                     m.html AS html, m.css AS css, m.js AS js, m.fields AS fields
              FROM modules m
              WHERE m.id IN (${sql.join(
                moduleIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}) AND m.deleted_at IS NULL ${moduleBranchScope}
            `)) as unknown as Omit<ModuleSourceRow, "block_name" | "position">[];
            for (const m of fetched) {
              byId.set(m.module_id, { ...m, block_name: "", position: 0 });
            }
            const replaced: ModuleSourceRow[] = [];
            for (const b of blocks) {
              let pos = 0;
              for (const mid of b.moduleIds) {
                const m = byId.get(mid);
                if (!m) continue;
                replaced.push({ ...m, block_name: b.blockName, position: pos });
                pos += 1;
              }
            }
            modRows = replaced;
          }
        }
      }
    }

    // v0.5.1 — module code overlay: apply staged + caller-branch snapshots
    // on top of the live `modules` row. Order:
    //   main → all-staged-overlay → caller's-branch-overlay
    // Caller's branch wins ties (it sees its own pending edits + everyone
    // else's already-staged work, but not other chats' un-staged pendings).
    if (modRows.length > 0) {
      // Build the IN clause once. Bun's SQL adapter rejects an empty IN().
      const moduleIds = modRows.map((r) => sql`${r.module_id}::uuid`);

      // 1. Staged overlay — latest snapshot per module from any branch
      // currently marked stage_state='staged'. EXCLUDE the caller's own
      // branch so we don't double-apply (caller wins below).
      const stagedRows = (await tx.execute(sql`
        SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS module_id, ms.state
        FROM module_snapshots ms
        JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
        JOIN chat_branch_publish_marks m
          ON m.chat_branch_id = ss.chat_branch_id
         AND m.entity_kind = 'module'
         AND m.entity_id = ms.module_id
         AND m.stage_state = 'staged'
        WHERE ms.module_id IN (${sql.join(moduleIds, sql`, `)})
          ${input.chatBranchId ? sql`AND ss.chat_branch_id <> ${input.chatBranchId}::uuid` : sql``}
        ORDER BY ms.module_id, ss.created_at DESC
      `)) as unknown as { module_id: string; state: unknown }[];

      const overlayByModule = new Map<
        string,
        {
          html: string;
          css: string;
          js: string;
          displayName: string;
          slug: string;
          deleted: boolean;
        }
      >();
      for (const r of stagedRows) {
        const raw = typeof r.state === "string" ? JSON.parse(r.state) : r.state;
        const s = raw as {
          html?: string;
          css?: string;
          js?: string;
          displayName?: string;
          slug?: string;
          deletedAt?: string | null;
        };
        overlayByModule.set(r.module_id, {
          html: s.html ?? "",
          css: s.css ?? "",
          js: s.js ?? "",
          displayName: s.displayName ?? "",
          slug: s.slug ?? "",
          deleted: !!s.deletedAt,
        });
      }

      // 2. Caller-branch overlay — supersedes staged for modules the
      // caller's chat has edited.
      if (input.chatBranchId) {
        const branchRows = (await tx.execute(sql`
          SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS module_id, ms.state
          FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ss.chat_branch_id = ${input.chatBranchId}::uuid
            AND ms.module_id IN (${sql.join(moduleIds, sql`, `)})
          ORDER BY ms.module_id, ss.created_at DESC
        `)) as unknown as { module_id: string; state: unknown }[];
        for (const r of branchRows) {
          const raw = typeof r.state === "string" ? JSON.parse(r.state) : r.state;
          const s = raw as {
            html?: string;
            css?: string;
            js?: string;
            displayName?: string;
            slug?: string;
            deletedAt?: string | null;
          };
          overlayByModule.set(r.module_id, {
            html: s.html ?? "",
            css: s.css ?? "",
            js: s.js ?? "",
            displayName: s.displayName ?? "",
            slug: s.slug ?? "",
            deleted: !!s.deletedAt,
          });
        }
      }

      // Apply the merged overlay.
      for (const m of modRows) {
        const overlay = overlayByModule.get(m.module_id);
        if (!overlay) continue;
        if (overlay.deleted) continue; // soft-deleted in the overlay — keep live
        m.html = overlay.html;
        m.css = overlay.css;
        m.js = overlay.js;
        m.display_name = overlay.displayName;
        m.slug = overlay.slug;
      }
    }

    // v0.12.0 — module CONTENT lives in content_instances now, joined
    // via page_modules.content_instance_id. Read the live binding +
    // values for each placement; for branched callers, also overlay any
    // page_layout_snapshots (rebound placements via placement.set_content
    // / fork_placement_content) AND content_instance_snapshots (values
    // edits via content_instances.set_values).
    //
    // The lookup is keyed by content_instance_id (not by block+position
    // as it was pre-v0.12) so re-using the same instance across pages
    // and forking diverging copies both compose correctly.
    const placementBindings = new Map<
      string, // `${block_name}#${position}`
      { contentInstanceId: string }
    >();
    const liveBindings = (await tx.execute(sql`
      SELECT block_name, position, content_instance_id::text AS content_instance_id
      FROM page_modules
      WHERE page_id = ${input.pageId}::uuid
    `)) as unknown as { block_name: string; position: number; content_instance_id: string }[];
    for (const r of liveBindings) {
      placementBindings.set(`${r.block_name}#${r.position}`, {
        contentInstanceId: r.content_instance_id,
      });
    }
    if (input.chatBranchId) {
      // Branched page_layout_snapshots authoritatively replace live
      // bindings for the active chat. Re-read the layout state below.
      const layoutSnapForBindings = (await tx.execute(sql`
        SELECT state FROM page_layout_snapshots pls
        JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
        WHERE pls.page_id = ${input.pageId}::uuid
          AND ss.chat_branch_id = ${input.chatBranchId}::uuid
        ORDER BY ss.created_at DESC
        LIMIT 1
      `)) as unknown as { state: unknown }[];
      const raw = layoutSnapForBindings[0]?.state;
      if (raw) {
        const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
          blocks?: {
            blockName: string;
            placements?: { moduleId: string; contentInstanceId: string; syncMode: string }[];
          }[];
        };
        if (parsed.blocks) {
          placementBindings.clear();
          for (const b of parsed.blocks) {
            const placements = b.placements ?? [];
            for (let i = 0; i < placements.length; i += 1) {
              const p = placements[i];
              if (p) {
                placementBindings.set(`${b.blockName}#${i}`, {
                  contentInstanceId: p.contentInstanceId,
                });
              }
            }
          }
        }
      }
    }

    // Load values for every referenced content_instance_id.
    const allInstanceIds = [...new Set([...placementBindings.values()].map((b) => b.contentInstanceId))];
    const valuesByInstance = new Map<string, Record<string, unknown>>();
    if (allInstanceIds.length > 0) {
      const valueRows = (await tx.execute(sql`
        SELECT id::text AS id, "values" AS values
        FROM content_instances
        WHERE id IN (${sql.join(
          allInstanceIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND deleted_at IS NULL
      `)) as unknown as { id: string; values: unknown }[];
      for (const r of valueRows) {
        const raw = typeof r.values === "string" ? JSON.parse(r.values) : r.values;
        valuesByInstance.set(r.id, (raw ?? {}) as Record<string, unknown>);
      }
      // Branch overlay — content_instance_snapshots tagged with this
      // chat's branch_id supersede live values for the same instance.
      if (input.chatBranchId) {
        const branchRows = (await tx.execute(sql`
          SELECT DISTINCT ON (cis.content_instance_id)
                 cis.content_instance_id::text AS id,
                 cis.state AS state
          FROM content_instance_snapshots cis
          JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
          WHERE ss.chat_branch_id = ${input.chatBranchId}::uuid
            AND cis.content_instance_id IN (${sql.join(
              allInstanceIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
          ORDER BY cis.content_instance_id, ss.created_at DESC
        `)) as unknown as { id: string; state: unknown }[];
        for (const r of branchRows) {
          const raw = typeof r.state === "string" ? JSON.parse(r.state) : r.state;
          const state = (raw ?? {}) as { values?: Record<string, unknown>; deletedAt?: string | null };
          if (state.deletedAt) continue;
          if (state.values) {
            valuesByInstance.set(r.id, state.values);
          }
        }
      }
    }

    // v0.12.0 — substitute {{fieldName}} placeholders in module HTML using
    // resolved content (branch content_instance overlay → live row →
    // module field default).
    for (const m of modRows) {
      const fields = parseFields(m.fields);
      const binding = placementBindings.get(`${m.block_name}#${m.position}`);
      const contentValues = binding
        ? (valuesByInstance.get(binding.contentInstanceId) ?? {})
        : {};
      m.html = substituteFields(m.html, fields, contentValues);
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

    // v0.5.3 — structured_set overlay. Same shape as the module overlay:
    //   main → all-staged-overlay → caller's-branch-overlay
    // Theme stays whole-blob (replaces items[]); list kinds also overlay
    // whole-blob here — per-item granularity in structured_set_operations
    // is the picker's concern, not the renderer's.
    if (setRows.length > 0) {
      const overlayBySetId = new Map<string, { kind: string; slug: string; items: unknown[] }>();
      const stagedSets = (await tx.execute(sql`
        SELECT DISTINCT ON (sss.structured_set_id)
          sss.structured_set_id::text AS set_id, sss.state
        FROM structured_set_snapshots sss
        JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
        JOIN chat_branch_publish_marks m
          ON m.chat_branch_id = ss.chat_branch_id
         AND m.entity_kind = 'structuredSet'
         AND m.entity_id = sss.structured_set_id
         AND m.stage_state = 'staged'
        ${input.chatBranchId ? sql`WHERE ss.chat_branch_id <> ${input.chatBranchId}::uuid` : sql``}
        ORDER BY sss.structured_set_id, ss.created_at DESC
      `)) as unknown as { set_id: string; state: unknown }[];
      for (const r of stagedSets) {
        const raw = typeof r.state === "string" ? JSON.parse(r.state) : r.state;
        const s = raw as { kind?: string; slug?: string; items?: unknown[] };
        if (s.kind && s.slug && Array.isArray(s.items)) {
          overlayBySetId.set(r.set_id, { kind: s.kind, slug: s.slug, items: s.items });
        }
      }
      if (input.chatBranchId) {
        const branchSets = (await tx.execute(sql`
          SELECT DISTINCT ON (sss.structured_set_id)
            sss.structured_set_id::text AS set_id, sss.state
          FROM structured_set_snapshots sss
          JOIN site_snapshots ss ON ss.id = sss.site_snapshot_id
          WHERE ss.chat_branch_id = ${input.chatBranchId}::uuid
          ORDER BY sss.structured_set_id, ss.created_at DESC
        `)) as unknown as { set_id: string; state: unknown }[];
        for (const r of branchSets) {
          const raw = typeof r.state === "string" ? JSON.parse(r.state) : r.state;
          const s = raw as { kind?: string; slug?: string; items?: unknown[] };
          if (s.kind && s.slug && Array.isArray(s.items)) {
            overlayBySetId.set(r.set_id, { kind: s.kind, slug: s.slug, items: s.items });
          }
        }
      }
      for (const { kind, slug, items } of overlayBySetId.values()) {
        byKindSlug[`${kind}/${slug}`] = items;
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
