// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the ids and digests of imported rows (docs/data-imports.md).
 *
 * A row's id is a UUID v5 of its import and its `sourceKey`. A retried call
 * of the same import therefore writes the same target rows again (an upsert
 * on that id) instead of new ones, while a new import of a key whose old
 * import was undone gets fresh ids that cannot collide with the old rows a
 * rolled-back release may still show.
 */

import { createHash } from "node:crypto";
import type { ImportValue } from "@caelo-cms/shared";

/** The namespace of data import row ids (a random v4, fixed forever). */
const ROW_NAMESPACE = "6b3f0d2e-58a4-4c1b-9e0f-2d7a41c9b8e5";

function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id of the row with `sourceKey` in import `importId`. */
export function importRowId(importId: string, sourceKey: string): string {
  return uuidV5(ROW_NAMESPACE, `${importId}\u0000${sourceKey}`);
}

/** What a row's digest covers: everything an update could change. */
export interface DigestInput {
  readonly parentRowId: string | null;
  readonly pageId: string | null;
  readonly values: Readonly<Record<string, ImportValue | null>>;
}

/** sha256 of a row's content, with keys in a fixed order. */
export function importRowDigest(row: DigestInput): string {
  const values = Object.fromEntries(
    Object.keys(row.values)
      .sort()
      .map((k) => [k, row.values[k] ?? null]),
  );
  return createHash("sha256")
    .update(JSON.stringify([row.parentRowId, row.pageId, values]), "utf8")
    .digest("hex");
}
