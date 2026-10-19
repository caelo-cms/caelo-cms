// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job's checkpoint (#819): `install/converge-job.json` in the
 * install's ops bucket, next to install.json and the install job's
 * `install-job.json`. It has the install job's status shape
 * (install-job.ts {@link InstallJobStatusSchema}: which execution runs, its
 * phase, whether it finished) plus what a killed run's successor must
 * reuse instead of recomputing:
 *
 *   - `targetVersion` / `fromVersion`: the update it belongs to. A run for
 *     another target starts fresh; a run for the same target resumes;
 *   - `backup`: the pre-upgrade backup (a new one could hold the
 *     half-migrated schema);
 *   - `priorRevisions`: the revisions that served before the update (the
 *     rollback targets; the serving one may already be the new release's).
 *
 * Whether a successor starts, attaches or is done is {@link decideInstallJob}'s
 * call, as for the install job. No secret ever lands here (assertNoSecrets).
 */

import { z } from "zod";
import { InstallJobStatusSchema, readJobStatusDoc, writeJobStatusDoc } from "./install-job.js";
import { OPS_INSTALL_PREFIX } from "./state-backend.js";
import type { SyncGcloud } from "./state-store.js";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

export const ConvergeCheckpointSchema = InstallJobStatusSchema.extend({
  /** The release this converge installs. */
  targetVersion: z.string().regex(VERSION),
  /** install.json's release when the update first started (the version it is judged from). */
  fromVersion: z.string().regex(VERSION),
  /** The update request it serves (the last one that ran it). */
  requestId: z.string().uuid(),
  backup: z
    .object({
      projectId: z.string().min(1),
      instance: z.string().min(1),
      backupId: z.string().min(1),
    })
    .optional(),
  priorRevisions: z.object({ admin: z.string().min(1), gateway: z.string().min(1) }).optional(),
});
/** What `install/converge-job.json` records. */
export type ConvergeCheckpoint = z.infer<typeof ConvergeCheckpointSchema>;

/** `gs://<bucket>/install/converge-job.json`. */
export function convergeCheckpointUrl(bucket: string): string {
  return `gs://${bucket}/${OPS_INSTALL_PREFIX}/converge-job.json`;
}

/** The checkpoint as the bucket holds it now (never cached), or null. */
export function readConvergeCheckpoint(bucket: string, run: SyncGcloud): ConvergeCheckpoint | null {
  return readJobStatusDoc(convergeCheckpointUrl(bucket), ConvergeCheckpointSchema, run);
}

/** Replace the checkpoint. */
export function writeConvergeCheckpoint(
  bucket: string,
  checkpoint: ConvergeCheckpoint,
  run: SyncGcloud,
): void {
  writeJobStatusDoc(convergeCheckpointUrl(bucket), ConvergeCheckpointSchema, checkpoint, run);
}
