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

export type StateSchemaVersion = 1;

export interface ModuleState {
  readonly schemaVersion: StateSchemaVersion;
  readonly slug: string;
  readonly displayName: string;
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
  readonly locale: string;
  readonly title: string;
  readonly templateId: string;
  readonly status: "draft" | "published";
  readonly version: number;
  readonly deletedAt: string | null;
}

export interface PageLayoutState {
  readonly schemaVersion: StateSchemaVersion;
  readonly blocks: readonly {
    readonly blockName: string;
    readonly moduleIds: readonly string[];
  }[];
}

/**
 * v0.5.3 — Whole-blob branched state for structured_sets (theme tokens,
 * nav menu, taxonomy, link list). The branched snapshot is authoritative
 * for reads; per-item ops in structured_set_operations are the picker's
 * stage-granularity layer.
 */
export interface StructuredSetState {
  readonly schemaVersion: StateSchemaVersion;
  readonly kind: string;
  readonly slug: string;
  readonly displayName: string;
  readonly items: readonly unknown[];
  readonly deletedAt: string | null;
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
