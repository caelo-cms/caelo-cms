// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1648, #1649) — where plugin collections live (plugin-host
 * collections-host.ts reads the same names): the staging store (change
 * files, the index job's releases, the staging gateway's reads) and the
 * live store (what Publish live copied, the live gateway's reads).
 * `gs://<bucket>` on Google Cloud (collections-setup.ts creates them),
 * `file://<dir>` on self-hosted (compose.ts). Each gateway gets only its
 * own environment's store; AWS and Azure get none until #749 / #750, and a
 * Stage's collections fail there with that gap.
 *
 * Pure module: the stacks and the env contracts import it.
 */

import { gcpBucketName } from "./gcp-names.js";

export const COLLECTIONS_STAGING_STORE_ENV = "CAELO_COLLECTIONS_STAGING_STORE";
export const COLLECTIONS_LIVE_STORE_ENV = "CAELO_COLLECTIONS_LIVE_STORE";

/** {@link COLLECTIONS_STAGING_STORE_ENV} / {@link COLLECTIONS_LIVE_STORE_ENV} of a GCP install. */
export function gcpCollectionStore(
  projectId: string,
  env: string,
  which: "staging" | "live",
): string {
  return `gs://${gcpBucketName(projectId, env, which === "staging" ? "coll-staging" : "coll-live")}`;
}
