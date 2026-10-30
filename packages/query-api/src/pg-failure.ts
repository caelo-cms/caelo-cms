// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1277 — turn a Postgres failure into a sentence the caller can act
 * on, without the internals.
 *
 * No raw Postgres message, constraint name, table name or SQL text reaches
 * an AI tool result: those name our schema, not the caller's input, and a
 * model that reads `constraint=modules_slug_key` starts reasoning about
 * tables instead of about the value it sent. The raw fields stay on
 * `HandlerError.pgDetail` (audit, logs, /settings/audit). Only the column
 * and value of a key violation are kept, because they name the caller's
 * own value (`slug "hero-3"`).
 *
 * The SQLSTATE classes below are the ones a different input fixes; every
 * other code is a defect in our code (`internal`).
 */

/** The Postgres fields the adapter lifts off a thrown driver error. */
export interface PgFailureFields {
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly detail?: string;
}

/** A readable failure, and whether it is a defect rather than bad input. */
export interface PgFailureDescription {
  readonly message: string;
  readonly internal: boolean;
}

/** `Key (a, b)=(x, y) …` → its columns and values, or null. */
function parseKey(detail: string | undefined): { columns: string; values: string } | null {
  if (!detail) return null;
  // indexOf, not a regex: Postgres' detail is driver input, and the
  // backtracking pattern was polynomial on repeated "Key ((" (CodeQL).
  const start = detail.indexOf("Key (");
  if (start === -1) return null;
  const sep = detail.indexOf(")=(", start + 5);
  const end = detail.lastIndexOf(")");
  if (sep === -1 || end <= sep + 2) return null;
  const columns = detail.slice(start + 5, sep);
  if (columns.includes(")")) return null;
  return { columns, values: detail.slice(sep + 3, end) };
}

function keyPhrase(key: { columns: string; values: string }): string {
  return key.columns.includes(",")
    ? `the combination \`${key.columns}\` = (${key.values})`
    : `\`${key.columns}\` "${key.values}"`;
}

/**
 * Describe a Postgres failure for the caller.
 *
 * @param fields - the lifted Postgres fields (`extractPgFields`).
 * @returns the sentence plus `internal: true` for codes no input change fixes.
 */
export function describePgFailure(fields: PgFailureFields): PgFailureDescription {
  const key = parseKey(fields.detail);
  switch (fields.code) {
    case "23505":
      return {
        message: key
          ? `${keyPhrase(key)} already exists — choose a different value`
          : "a row with the same unique value already exists — choose a different value",
        internal: false,
      };
    case "23503":
      if (fields.detail?.includes("still referenced")) {
        return {
          message: "the row is still referenced by other content — remove those references first",
          internal: false,
        };
      }
      return {
        message: key
          ? `${keyPhrase(key)} names a row that does not exist or was deleted — use an id from the matching list tool`
          : "a referenced row does not exist or was deleted — use an id from the matching list tool",
        internal: false,
      };
    case "23502":
      return {
        message: fields.column
          ? `\`${fields.column}\` is required but was empty`
          : "a required value was empty",
        internal: false,
      };
    case "23514":
      return { message: "a value is outside the allowed range or set", internal: false };
    case "22P02":
      return {
        message: "a value has the wrong format (e.g. an id that is not a UUID) — copy ids exactly",
        internal: false,
      };
    case "22001":
      return { message: "a text value is longer than allowed — shorten it", internal: false };
    case "22003":
      return { message: "a number is out of range", internal: false };
    default:
      return {
        message: "a database error the call cannot fix — a defect in Caelo, reported automatically",
        internal: true,
      };
  }
}

/**
 * The text an AI tool result shows for an RLS denial. The raw Postgres
 * message names the policy's table; this names what the caller can check.
 */
export function rlsDenialMessage(operation: string, access: "read" | "write"): string {
  return (
    `permission denied: ${operation} may not ${access} that row as the current actor ` +
    "(it is not visible on this chat's branch, or belongs to another actor or plugin). " +
    "Check the ids against the matching list tool; if they are right, the change needs a human with the permission."
  );
}
