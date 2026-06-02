// SPDX-License-Identifier: MPL-2.0

/**
 * Runtime Zod schemas for snapshot `state` payloads, keyed by schemaVersion.
 *
 * Why we need them: revert ops cast `row.state` from JSONB to a TypeScript
 * interface — that cast is not enforced at runtime. If a future migration
 * evolves the state shape (a new field, a renamed key) and an old snapshot
 * is reverted, the revert SQL would silently splat `undefined` into the
 * live row and corrupt it. Closes the snapshot ↔ live-row boundary,
 * which was the only validator gap left after CLAUDE.md §4.
 *
 * P4 ships only schemaVersion 1 for every entity kind. When a shape
 * changes, add the new entry to the matching map and write a small
 * `upgrade` function that takes the old shape and returns the new one;
 * `parseAndUpgrade*State` calls it transparently so revert ops always see
 * the latest shape.
 */

import { z } from "zod";
import type { ModuleState, PageLayoutState, PageState, TemplateState } from "./state.js";

const moduleStateV1 = z
  .object({
    schemaVersion: z.literal(1),
    slug: z.string(),
    displayName: z.string(),
    /** v0.12.3 (issue #106) — stable module `type`. Defaults to "" for
     *  snapshots written before 0103; `parseAndUpgradeModuleState`
     *  fills it from `slug` when empty (matching the 0103 backfill). */
    type: z.string().default(""),
    html: z.string(),
    css: z.string(),
    js: z.string(),
    /** v0.4.0 — field schema captured for restore. Defaults to [] for
     *  snapshots written pre-v0.4.0 (post-truncate-only install — should
     *  not happen in practice but safer than rejecting on parse). */
    fields: z.array(z.unknown()).default([]),
    deletedAt: z.string().nullable(),
  })
  .strict();

const templateStateV1 = z
  .object({
    schemaVersion: z.literal(1),
    slug: z.string(),
    displayName: z.string(),
    html: z.string(),
    css: z.string(),
    deletedAt: z.string().nullable(),
    blocks: z.array(
      z
        .object({
          name: z.string(),
          displayName: z.string(),
          position: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();

const pageStateV1 = z
  .object({
    schemaVersion: z.literal(1),
    slug: z.string(),
    locale: z.string(),
    title: z.string(),
    templateId: z.string().uuid(),
    status: z.enum(["draft", "published"]),
    version: z.number().int().nonnegative(),
    deletedAt: z.string().nullable(),
  })
  .strict();

const pageLayoutStateV1 = z
  .object({
    schemaVersion: z.literal(1),
    blocks: z.array(
      z
        .object({
          blockName: z.string(),
          moduleIds: z.array(z.string().uuid()),
          // v0.12.0 — per-placement binding metadata (moduleId,
          // contentInstanceId, syncMode). Producers always write it
          // post-v0.12; pre-v0.12 snapshots leave it undefined and the
          // merge / revert paths fall back to minting fresh unsynced
          // content_instances per moduleId.
          placements: z
            .array(
              z
                .object({
                  moduleId: z.string().uuid(),
                  contentInstanceId: z.string().uuid(),
                  syncMode: z.enum(["synced", "unsynced"]),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

export class SnapshotSchemaError extends Error {
  readonly kind: "SnapshotSchemaError" = "SnapshotSchemaError";
  constructor(
    readonly entity: "module" | "template" | "page" | "pageLayout",
    readonly version: unknown,
    readonly issues: unknown,
  ) {
    super(
      `snapshot ${entity} state failed schema check (version=${String(version)}): ${JSON.stringify(issues)}`,
    );
  }
}

function pickVersion(raw: unknown): number | "unknown" {
  if (raw && typeof raw === "object" && "schemaVersion" in raw) {
    const v = (raw as { schemaVersion: unknown }).schemaVersion;
    return typeof v === "number" ? v : "unknown";
  }
  return "unknown";
}

export function parseAndUpgradeModuleState(raw: unknown): ModuleState {
  const v = pickVersion(raw);
  if (v === 1) {
    const r = moduleStateV1.safeParse(raw);
    if (!r.success) throw new SnapshotSchemaError("module", v, r.error.issues);
    // v0.12.3 — a pre-0103 snapshot has no `type`; fall back to `slug`
    // so revert restores the column the same way the migration backfilled
    // the live rows (type = slug), never NULL.
    return r.data.type === "" ? { ...r.data, type: r.data.slug } : r.data;
  }
  throw new SnapshotSchemaError("module", v, "no upgrade path from this version");
}

export function parseAndUpgradeTemplateState(raw: unknown): TemplateState {
  const v = pickVersion(raw);
  if (v === 1) {
    const r = templateStateV1.safeParse(raw);
    if (!r.success) throw new SnapshotSchemaError("template", v, r.error.issues);
    return r.data;
  }
  throw new SnapshotSchemaError("template", v, "no upgrade path from this version");
}

export function parseAndUpgradePageState(raw: unknown): PageState {
  const v = pickVersion(raw);
  if (v === 1) {
    const r = pageStateV1.safeParse(raw);
    if (!r.success) throw new SnapshotSchemaError("page", v, r.error.issues);
    return r.data;
  }
  throw new SnapshotSchemaError("page", v, "no upgrade path from this version");
}

export function parseAndUpgradePageLayoutState(raw: unknown): PageLayoutState {
  const v = pickVersion(raw);
  if (v === 1) {
    const r = pageLayoutStateV1.safeParse(raw);
    if (!r.success) throw new SnapshotSchemaError("pageLayout", v, r.error.issues);
    return r.data;
  }
  throw new SnapshotSchemaError("pageLayout", v, "no upgrade path from this version");
}
