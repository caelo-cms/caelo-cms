// SPDX-License-Identifier: MPL-2.0

/**
 * Zod input schemas for the P4 snapshot ops. Lives in @caelo-cms/shared so that
 * route actions and the ops themselves import from a single source — same
 * pattern as packages/shared/src/content.ts for P3.
 *
 * Every schema is `.strict()` so unknown keys are rejected at the Validator
 * before the handler runs. Snapshot state JSONB is *not* validated by Zod
 * here — it is emitted by trusted ops, never user-supplied (see CMS plan
 * §"Validator rules").
 */

import { z } from "zod";

export const snapshotsListInput = z
  .object({
    /** ISO timestamp; only snapshots strictly before this are returned. */
    before: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    /** When set, only snapshots that touched this module are returned. */
    forModuleId: z.string().uuid().optional(),
    /** When set, only snapshots that touched this page (metadata or layout). */
    forPageId: z.string().uuid().optional(),
    /** When set, only snapshots that touched this template (incl. block changes). */
    forTemplateId: z.string().uuid().optional(),
    /** When set, only snapshots whose op_kind matches one of these values. */
    opKinds: z.array(z.string()).optional(),
    /** When true, archived snapshots are also returned. Defaults to false. */
    includeArchived: z.boolean().default(false),
  })
  .strict();

export const archiveOlderThanInput = z
  .object({
    /** ISO timestamp; snapshots with `created_at < before` get archived_at set. */
    before: z.string().datetime(),
    /** Hard cap to keep one call from updating the whole table by mistake. */
    limit: z.number().int().min(1).max(10_000).default(1000),
  })
  .strict();
export type ArchiveOlderThanInput = z.infer<typeof archiveOlderThanInput>;

export const snapshotGetInput = z.object({ snapshotId: z.string().uuid() }).strict();

export const moduleImpactInput = z.object({ moduleId: z.string().uuid() }).strict();

export const revertSiteInput = z.object({ snapshotId: z.string().uuid() }).strict();

export const revertModuleInput = z
  .object({
    moduleId: z.string().uuid(),
    snapshotId: z.string().uuid(),
  })
  .strict();

export const revertTemplateInput = z
  .object({
    templateId: z.string().uuid(),
    snapshotId: z.string().uuid(),
  })
  .strict();

export const revertPageInput = z
  .object({
    pageId: z.string().uuid(),
    snapshotId: z.string().uuid(),
  })
  .strict();

export type SnapshotsListInput = z.infer<typeof snapshotsListInput>;
export type SnapshotGetInput = z.infer<typeof snapshotGetInput>;
export type ModuleImpactInput = z.infer<typeof moduleImpactInput>;
export type RevertSiteInput = z.infer<typeof revertSiteInput>;
export type RevertModuleInput = z.infer<typeof revertModuleInput>;
export type RevertTemplateInput = z.infer<typeof revertTemplateInput>;
export type RevertPageInput = z.infer<typeof revertPageInput>;
