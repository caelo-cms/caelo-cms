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

/** The ops that issue keyset cursors; a cursor is valid only for the op that issued it. */
export type KeysetCursorOp = "pages.list" | "content_instances.list";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/;

/** True for a real calendar time in the cursor format (no Feb 30, no 25:00). */
function isCursorTime(text: string): boolean {
  const m = TIME.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === se
  );
}

/** Encode the last row of a page of `op`. */
export function encodeKeysetCursor(op: KeysetCursorOp, createdKey: string, id: string): string {
  return Buffer.from(JSON.stringify([op, createdKey, id])).toString("base64url");
}

/**
 * Decode a cursor `op` issued; null for anything else — another op's
 * cursor, a forged one, or one whose id or time Postgres could not cast
 * (so the op answers a structured error, never a cast failure).
 */
export function decodeKeysetCursor(
  op: KeysetCursorOp,
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 3 &&
      v[0] === op &&
      typeof v[1] === "string" &&
      typeof v[2] === "string" &&
      UUID.test(v[2]) &&
      isCursorTime(v[1])
    ) {
      return { createdAt: v[1], id: v[2] };
    }
  } catch {
    // Not base64url JSON: an unknown cursor.
  }
  return null;
}
