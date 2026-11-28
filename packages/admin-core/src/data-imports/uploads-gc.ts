// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the scheduler's sweep of expired uploads (docs/data-imports.md).
 * An upload is kept 7 days (`DATA_UPLOAD_TTL_DAYS`); an import that used a
 * file without problems drops it at once (`run.ts`). The rows go first,
 * then the bytes: a file whose delete fails is unreachable, never a row
 * pointing at nothing.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import { getMediaStorage } from "../media/storage.js";

/** One sweep: every expired upload, 500 per call until none is left. */
export async function sweepExpiredDataUploads(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<{ readonly deleted: number }> {
  const ctx = {
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system" as const,
    requestId: "scheduler:data-upload-gc",
  };
  let deleted = 0;
  for (;;) {
    const r = await execute(deps.registry, deps.adapter, ctx, "data_uploads.forget", {});
    if (!r.ok) throw new Error(`data_uploads.forget failed: ${JSON.stringify(r.error)}`);
    const keys = (r.value as { storageKeys: string[] }).storageKeys;
    for (const key of keys) await getMediaStorage().delete(key);
    deleted += keys.length;
    if (keys.length < 500) return { deleted };
  }
}
