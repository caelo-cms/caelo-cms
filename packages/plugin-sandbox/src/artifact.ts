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

/** Identity includes the reviewed source and every manifest declaration, independent of JSON key order. */
export function externalArtifactDigest(manifest: unknown, source: string): string {
  return createHash("sha256")
    .update(JSON.stringify([canonical(manifest), source]))
    .digest("hex");
}
