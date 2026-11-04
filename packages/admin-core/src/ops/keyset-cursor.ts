// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1269 — the cursor of the keyset-paged list ops (`pages.list`,
 * `content_instances.list`): the creation time and id of the last row a
 * page returned, as opaque base64url text. The ops order by
 * `(created_at, id)` — immutable, indexed — and continue with
 * `(created_at, id) > cursor`, so a deep page costs what a first page does
 * (no OFFSET). The time is printed in UTC with microseconds
 * (`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`)
 * and read back with `::timestamp AT TIME ZONE 'UTC'`, so the session's
 * DateStyle and time zone cannot change it.
 */

/** Encode the last row of a page. */
export function encodeKeysetCursor(createdKey: string, id: string): string {
  return Buffer.from(JSON.stringify([createdKey, id])).toString("base64url");
}

/** Decode a cursor this module issued; null for anything else. */
export function decodeKeysetCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "string" &&
      typeof v[1] === "string" &&
      /^[0-9a-f-]{36}$/i.test(v[1]) &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(v[0])
    ) {
      return { createdAt: v[0], id: v[1] };
    }
  } catch {
    // Not base64url JSON: an unknown cursor.
  }
  return null;
}
