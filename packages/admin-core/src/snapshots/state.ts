// SPDX-License-Identifier: MPL-2.0

/**
 * Typed `state` payloads for snapshot rows. The JSONB column on each
 * snapshot table holds these shapes verbatim. `schemaVersion` is on every
 * shape so revert ops can grow a version-shape map when payloads evolve;
 * P4 only has version 1.
 *
 * The shapes intentionally mirror the live-row shape (snake_case mapped to
 * camelCase) so the revert op can splat back into the live row without a
 * field-by-field translation.
 */

import type { ListItem, ListTypeDef, PageTypeDef } from "@caelo-cms/shared";

export type StateSchemaVersion = 1;

export interface ModuleState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly displayName: string;
  /** v0.12.3 (issue #106) — stable module `type`, captured so revert
   *  restores the NOT NULL column. Snapshots written before 0103 lack
   *  it; the parse-upgrade falls back to `slug` (matching how 0103
   *  backfilled the live rows). */
  readonly type: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  /** v0.4.0 — module field schema (captured for snapshot-restore). */
  readonly fields: unknown[];
  readonly deletedAt: string | null;
}

/**
 * v0.4.0 — Page-placement content state. One row per placement
 * (page + block + position).
 */
export interface PageModuleContentState {
  readonly schemaVersion: StateSchemaVersion;
  readonly pageId: string;
  readonly blockName: string;
  readonly position: number;
  readonly contentValues: Record<string, unknown>;
  readonly version: number;
}

export interface TemplateState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly displayName: string;
  readonly html: string;
  readonly css: string;
  readonly deletedAt: string | null;
  readonly blocks: readonly {
    readonly name: string;
    readonly displayName: string;
    readonly position: number;
  }[];
}

export interface PageState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly title: string;
  readonly templateId: string;
  readonly status: "draft" | "published";
  readonly version: number;
  readonly deletedAt: string | null;
  /**
   * 0263 — the parent page (nested URLs), null at top level. `undefined`
   * only on snapshots written before 0263: they never captured a parent,
   * so replaying them (merge / revert) leaves the live column untouched
   * instead of inventing a value.
   */
  readonly parentPageId?: string | null;
  /**
   * Only on a chat's PENDING rename / move whose caller asked for no
   * 301s from the old URLs (`redirectFromOld: "skip"`): the publish that
   * makes the move live honours it. Never set on live-state snapshots.
   */
  readonly pendingRedirects?: "skip";
  /** Epic #1107 — the page type (0351 backfilled every older snapshot). */
  readonly pageTypeId: string;
  /** Property values, validated against the page type. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Terms as `caelo:term/<listId>/<itemId>`, materialised into `page_terms` at merge. */
  readonly terms: readonly string[];
}

/**
 * Page layout state — the ordered (block, module) tuples that make up
 * a page's main content slot.
 *
 * v0.4.0–v0.11.x carried only `{ blockName, moduleIds }`. v0.12.0 adds
 * `placements` carrying the full `(moduleId, contentInstanceId, syncMode)`
 * triple so chat.publish can re-insert page_modules rows with the new
 * NOT NULL content_instance_id column populated.
 *
 * `moduleIds` is retained for backward-compatibility with pre-v0.12
 * snapshots: when reverting an old snapshot, `placements` is undefined,
 * the merger falls back to `moduleIds`, and mints a fresh unsynced
 * content_instance per placement.
 */
export interface PageLayoutPlacement {
  readonly moduleId: string;
  readonly contentInstanceId: string;
  readonly syncMode: "synced" | "unsynced";
}

export interface PageLayoutState {
  readonly schemaVersion: StateSchemaVersion;
  readonly blocks: readonly {
    readonly blockName: string;
    /** Pre-v0.12 shape. Always present so old snapshots can be reverted. */
    readonly moduleIds: readonly string[];
    /** v0.12.0+ — full placement metadata. Producers ALWAYS set this. */
    readonly placements?: readonly PageLayoutPlacement[];
  }[];
}

/**
 * v0.12.0 — content_instance state. One row per identity-bearing content
 * instance. Reverting copies back into the live `content_instances` row;
 * for branch overlays, the renderer reads this state via
 * `loadContentInstanceStateWithBranchOverlay` so chained branched edits
 * compose correctly (same pattern as `loadModuleStateWithBranchOverlay`
 * fixed for modules in v0.10.0).
 */
export interface ContentInstanceState {
  readonly schemaVersion: StateSchemaVersion;
  readonly moduleId: string;
  readonly slug: string | null;
  readonly displayName: string | null;
  readonly values: Record<string, unknown>;
  readonly version: number;
  readonly deletedAt: string | null;
}

/**
 * v0.11.0 (#45) — whole-blob state for one `themes` row. Stored in
 * `theme_snapshots.state` by the shared emitSnapshot path. The shape
 * matches the live `themes` row + the four media FK ids; restoring a
 * snapshot copies the values back into the live row.
 *
 * Theme is small enough (one DTCG document + four media FK ids) that
 * whole-blob is sufficient for revert.
 */
export interface ThemeState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  /**
   * v0.11.4 (issue #76 follow-up) — provenance at time of snapshot.
   * Older snapshot rows (pre-0100) carry no origin in their state jsonb;
   * the revert path treats absence as 'seed' (the column's default).
   * Optional in the type to keep historical-state reads typed.
   */
  readonly origin?: "seed" | "ai" | "operator";
  readonly isActive: boolean;
  readonly tokens: unknown;
  readonly assets: {
    readonly logo: string | null;
    readonly logoDark: string | null;
    readonly favicon: string | null;
    readonly socialShare: string | null;
  };
  readonly deletedAt: string | null;
}

/**
 * Epic #1107 — whole-entity state of a list type (`list_types` row). The
 * definition is the full ListTypeDef (`@caelo-cms/shared` lists).
 */
export interface ListTypeState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly definition: ListTypeDef;
  readonly version: number;
  readonly deletedAt: string | null;
}

/** Epic #1107 — whole-entity state of a shared list (`lists` row). */
export interface ListState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly name: string;
  readonly purpose: string;
  readonly listTypeId: string;
  readonly items: readonly ListItem[];
  readonly version: number;
  readonly deletedAt: string | null;
}

/** Epic #1107 — whole-entity state of a page type (`page_types` row). */
export interface PageTypeState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly definition: PageTypeDef;
  readonly version: number;
  readonly deletedAt: string | null;
}
