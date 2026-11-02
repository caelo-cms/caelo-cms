// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/**
 * #1332 — what an Owner approves of a release-signed (shipped) plugin: the
 * digest of its whole manifest, independent of JSON key order. A release
 * that changes the manifest — its visitor operations, table kinds,
 * capabilities, tools — is a new artifact and waits for a new approval
 * (CLAUDE.md §2); one that leaves the manifest as it was keeps running.
 */
export function releaseManifestDigest(manifest: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(manifest)))
    .digest("hex");
}

/** Identity includes the reviewed source and every manifest declaration, independent of JSON key order. */
export function externalArtifactDigest(manifest: unknown, source: string): string {
  return createHash("sha256")
    .update(JSON.stringify([canonical(manifest), source]))
    .digest("hex");
}
