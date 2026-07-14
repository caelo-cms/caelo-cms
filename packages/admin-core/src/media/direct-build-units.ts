// SPDX-License-Identifier: MPL-2.0

/**
 * issue #302 — direct-build unit collection for `imports.migrate_media`,
 * BRANCH-AWARE.
 *
 * Run #15 forensics: the #278 homepage-first migration runs inside a chat,
 * and chat writes are BRANCHED —
 *
 *   - `pages.set_modules` in branched mode NEVER writes live `page_modules`
 *     rows; placements exist only as `page_layout_snapshots` on the chat's
 *     branch (pages.ts, "v0.5.3 — branched: skip live page_modules write").
 *   - `modules.update` in branched mode NEVER updates the live row; the
 *     current html lives in the latest branched `module_snapshots.state`
 *     (modules.ts, "v0.5.1 — branched writes skip the live UPDATE").
 *
 * The pre-#302 fallback joined live `page_modules` directly, so a chat-built
 * site produced ZERO page-module units — media_assets got zero inserts for
 * the whole run even though the pages were full of hotlinked images.
 *
 * This module provides:
 *   - `resolveDirectBuildModuleRows` — PURE placement→text resolution over
 *     branch-overlay-resolved inputs, unit-testable without Postgres.
 *   - `assembleDirectBuildUnits` — PURE unit assembly (moved here from
 *     import_media.ts; same contract).
 *   - `loadModuleTextWithBranchProvenance` / `loadTemplateWithBranchProvenance`
 *     — thin DB loaders that return the branch-latest state PLUS provenance
 *     (did it come from a branched snapshot? is the live row main-owned?)
 *     so the rewrite step can decide live-update vs snapshot-only.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { ModuleState, PageLayoutState, TemplateState } from "../snapshots/state.js";

/** One rewritable text (module html/css or template css) + its base URL. */
export interface TextUnit {
  kind: "module" | "template";
  id: string;
  /** Empty string for templates (css-only units). */
  html: string;
  css: string;
  /** The page's original source URL — relative refs resolve against it. */
  baseUrl: string;
  /**
   * Direct-build fallback only — full snapshot state so the rewrite step
   * can emit a BRANCHED snapshot carrying the rewritten text. Without it,
   * `chat.publish` replays the pre-rewrite branched snapshot over the live
   * row and the media rewrite is silently reverted (issue #302).
   */
  moduleState?: ModuleState;
  templateState?: TemplateState;
  /** True when the text came from a branched snapshot (not the live row). */
  fromBranchSnapshot?: boolean;
  /** The live row's chat_branch_id (null = main-owned row). */
  liveChatBranchId?: string | null;
}

/** Raw module row (page module OR layout-bound chrome) for the fallback. */
export interface ModuleTextRow {
  id: string;
  html: string;
  css: string;
  moduleState?: ModuleState;
  fromBranchSnapshot?: boolean;
  liveChatBranchId?: string | null;
}

/** Raw template row (css-only) for the fallback. */
export interface TemplateCssRow {
  id: string;
  css: string;
  templateState?: TemplateState;
  fromBranchSnapshot?: boolean;
  liveChatBranchId?: string | null;
}

/** Branch-overlay-resolved module text + provenance for the rewrite step. */
export interface ModuleTextWithProvenance {
  readonly state: ModuleState;
  readonly fromBranchSnapshot: boolean;
  readonly liveChatBranchId: string | null;
}

/** Branch-overlay-resolved template state + provenance. */
export interface TemplateWithProvenance {
  readonly state: TemplateState;
  readonly fromBranchSnapshot: boolean;
  readonly liveChatBranchId: string | null;
}

/**
 * PURE placement→text resolution for the direct-build fallback.
 *
 * Inputs are already branch-overlay-resolved by the caller:
 *   - `layoutStatesByPage` — each built page's placements, from
 *     `loadPageLayoutStateWithBranchOverlay` (branched runs: the latest
 *     `page_layout_snapshots` state, because live `page_modules` is EMPTY
 *     for chat-built pages; live runs: the live `page_modules` rows).
 *   - `chromeModuleIds` — layout-bound chrome from the `layout_modules`
 *     join (written live even in branched chats, layouts.ts).
 *   - `moduleTextById` — per-module branch-latest text + provenance.
 *
 * Returns the page-module and chrome rows for `assembleDirectBuildUnits`,
 * plus every referenced module id that had NO resolvable text — the caller
 * must surface those loudly (CLAUDE.md §2: nothing silently dropped).
 */
export function resolveDirectBuildModuleRows(args: {
  layoutStatesByPage: ReadonlyArray<{ pageId: string; state: PageLayoutState }>;
  chromeModuleIds: readonly string[];
  moduleTextById: ReadonlyMap<string, ModuleTextWithProvenance>;
}): {
  pageModules: ModuleTextRow[];
  chromeModules: ModuleTextRow[];
  missingModuleIds: string[];
} {
  const missing = new Set<string>();
  const toRow = (moduleId: string): ModuleTextRow | null => {
    const resolved = args.moduleTextById.get(moduleId);
    if (!resolved) {
      missing.add(moduleId);
      return null;
    }
    return {
      id: moduleId,
      html: resolved.state.html,
      css: resolved.state.css,
      moduleState: resolved.state,
      fromBranchSnapshot: resolved.fromBranchSnapshot,
      liveChatBranchId: resolved.liveChatBranchId,
    };
  };

  const pageModules: ModuleTextRow[] = [];
  const seenPage = new Set<string>();
  for (const { state } of args.layoutStatesByPage) {
    for (const block of state.blocks) {
      // v0.12+ snapshots carry placements; pre-v0.12 (and live-derived)
      // states always carry moduleIds. Prefer placements when present —
      // same precedence as chat/publish.ts.
      const moduleIds =
        block.placements && block.placements.length > 0
          ? block.placements.map((p) => p.moduleId)
          : block.moduleIds;
      for (const moduleId of moduleIds) {
        if (seenPage.has(moduleId)) continue;
        seenPage.add(moduleId);
        const row = toRow(moduleId);
        if (row) pageModules.push(row);
      }
    }
  }

  const chromeModules: ModuleTextRow[] = [];
  const seenChrome = new Set<string>();
  for (const moduleId of args.chromeModuleIds) {
    if (seenChrome.has(moduleId)) continue;
    seenChrome.add(moduleId);
    const row = toRow(moduleId);
    if (row) chromeModules.push(row);
  }

  return { pageModules, chromeModules, missingModuleIds: [...missing] };
}

/**
 * Assemble rewritable text units for the DIRECT-BUILD migration flow
 * (issue #278 homepage-first), where pages are created straight through
 * `pages.create` and never get an `import_pages.accepted_page_id`
 * linkage — so the compose-keyed collection in the handler finds nothing.
 *
 * Every unit resolves relative asset refs against `sourceUrl` (the run's
 * origin): a migration runs on a fresh site, so the run origin is the
 * correct base for all of them — mirroring how the compose path already
 * bases its chrome + template units on `run.source_url`.
 *
 * Modules are deduped by id (a module placed on several pages, or bound
 * as chrome AND also present as a page module, is rewritten and
 * usage-counted exactly once). Page modules are inserted first so their
 * row wins the dedup, matching the compose path's ordering.
 *
 * Pure (no I/O) so the handler's fallback collection is unit-testable
 * without Postgres.
 */
export function assembleDirectBuildUnits(
  rows: {
    pageModules: readonly ModuleTextRow[];
    chromeModules: readonly ModuleTextRow[];
    templates: readonly TemplateCssRow[];
  },
  sourceUrl: string,
): TextUnit[] {
  const moduleUnitsById = new Map<string, TextUnit>();
  for (const m of [...rows.pageModules, ...rows.chromeModules]) {
    if (!moduleUnitsById.has(m.id)) {
      moduleUnitsById.set(m.id, {
        kind: "module",
        id: m.id,
        html: m.html,
        css: m.css,
        baseUrl: sourceUrl,
        ...(m.moduleState !== undefined ? { moduleState: m.moduleState } : {}),
        ...(m.fromBranchSnapshot !== undefined ? { fromBranchSnapshot: m.fromBranchSnapshot } : {}),
        ...(m.liveChatBranchId !== undefined ? { liveChatBranchId: m.liveChatBranchId } : {}),
      });
    }
  }
  return [
    ...moduleUnitsById.values(),
    ...rows.templates.map(
      (t): TextUnit => ({
        kind: "template",
        id: t.id,
        html: "",
        css: t.css,
        baseUrl: sourceUrl,
        ...(t.templateState !== undefined ? { templateState: t.templateState } : {}),
        ...(t.fromBranchSnapshot !== undefined ? { fromBranchSnapshot: t.fromBranchSnapshot } : {}),
        ...(t.liveChatBranchId !== undefined ? { liveChatBranchId: t.liveChatBranchId } : {}),
      }),
    ),
  ];
}

/**
 * Load a module's branch-latest text WITH provenance. Mirrors
 * `loadModuleStateWithBranchOverlay` but additionally reports whether the
 * state came from a branched snapshot and whether the live row is
 * main-owned — the rewrite step needs both to avoid leaking branch-derived
 * html into a main-owned live row (see import_media.ts step 4).
 *
 * Returns null when the module row doesn't exist or is soft-deleted.
 */
export async function loadModuleTextWithBranchProvenance(
  tx: TransactionRunner,
  moduleId: string,
  chatBranchId: string | null,
): Promise<ModuleTextWithProvenance | null> {
  const liveRows = (await tx.execute(sql`
    SELECT slug, display_name, type, html, css, js, fields, deleted_at,
           chat_branch_id::text AS chat_branch_id
    FROM modules WHERE id = ${moduleId}::uuid AND deleted_at IS NULL LIMIT 1
  `)) as unknown as Array<{
    slug: string;
    display_name: string;
    type: string | null;
    html: string;
    css: string;
    js: string;
    fields: unknown;
    deleted_at: string | Date | null;
    chat_branch_id: string | null;
  }>;
  const live = liveRows[0];
  if (!live) return null;

  if (chatBranchId) {
    const snapRows = (await tx.execute(sql`
      SELECT ms.state
        FROM module_snapshots ms
        JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
       WHERE ms.module_id = ${moduleId}::uuid
         AND ss.chat_branch_id = ${chatBranchId}::uuid
       ORDER BY ss.created_at DESC
       LIMIT 1
    `)) as unknown as Array<{ state: unknown }>;
    const snap = snapRows[0];
    if (snap !== undefined) {
      const raw = (
        typeof snap.state === "string" ? JSON.parse(snap.state) : snap.state
      ) as ModuleState;
      return {
        // Pre-0103 branched snapshots lack `type` — same fallback as
        // loadModuleStateWithBranchOverlay.
        state: raw.type ? raw : { ...raw, type: raw.slug },
        fromBranchSnapshot: true,
        liveChatBranchId: live.chat_branch_id,
      };
    }
  }

  const rawFields = typeof live.fields === "string" ? JSON.parse(live.fields) : live.fields;
  return {
    state: {
      schemaVersion: 1,
      slug: live.slug,
      displayName: live.display_name,
      type: live.type ?? live.slug,
      html: live.html,
      css: live.css,
      js: live.js,
      fields: Array.isArray(rawFields) ? (rawFields as unknown[]) : [],
      deletedAt: null,
    },
    fromBranchSnapshot: false,
    liveChatBranchId: live.chat_branch_id,
  };
}

/**
 * Load a template's branch-latest state WITH provenance. Branched template
 * edits (templates.update) skip the live UPDATE just like modules, so the
 * branch-latest css lives in `template_snapshots.state`.
 *
 * Returns null when the template row doesn't exist or is soft-deleted.
 */
export async function loadTemplateWithBranchProvenance(
  tx: TransactionRunner,
  templateId: string,
  chatBranchId: string | null,
): Promise<TemplateWithProvenance | null> {
  const liveRows = (await tx.execute(sql`
    SELECT slug, display_name, html, css, chat_branch_id::text AS chat_branch_id
    FROM templates WHERE id = ${templateId}::uuid AND deleted_at IS NULL LIMIT 1
  `)) as unknown as Array<{
    slug: string;
    display_name: string;
    html: string;
    css: string;
    chat_branch_id: string | null;
  }>;
  const live = liveRows[0];
  if (!live) return null;

  if (chatBranchId) {
    const snapRows = (await tx.execute(sql`
      SELECT ts.state
        FROM template_snapshots ts
        JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
       WHERE ts.template_id = ${templateId}::uuid
         AND ss.chat_branch_id = ${chatBranchId}::uuid
       ORDER BY ss.created_at DESC
       LIMIT 1
    `)) as unknown as Array<{ state: unknown }>;
    const snap = snapRows[0];
    if (snap !== undefined) {
      const raw = (
        typeof snap.state === "string" ? JSON.parse(snap.state) : snap.state
      ) as TemplateState;
      return { state: raw, fromBranchSnapshot: true, liveChatBranchId: live.chat_branch_id };
    }
  }

  const blocks = (await tx.execute(sql`
    SELECT name, display_name, position FROM template_blocks
    WHERE template_id = ${templateId}::uuid
    ORDER BY position ASC
  `)) as unknown as Array<{ name: string; display_name: string; position: number }>;
  return {
    state: {
      schemaVersion: 1,
      slug: live.slug,
      displayName: live.display_name,
      html: live.html,
      css: live.css,
      deletedAt: null,
      blocks: blocks.map((b) => ({
        name: b.name,
        displayName: b.display_name,
        position: b.position,
      })),
    },
    fromBranchSnapshot: false,
    liveChatBranchId: live.chat_branch_id,
  };
}
