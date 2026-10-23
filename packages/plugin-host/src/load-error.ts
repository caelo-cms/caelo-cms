// SPDX-License-Identifier: MPL-2.0

/**
 * One readable line for a plugin load failure (issue #1008).
 *
 * A failed DDL statement surfaces as drizzle's `DrizzleQueryError`, whose
 * message is "Failed query: <the whole emitted schema SQL>" and whose
 * `cause` holds the actual Postgres error. Logging only the message buried
 * the reason under hundreds of lines of DDL and dropped the SQLSTATE — the
 * 2026-10-22 incident log said "Failed query: CREATE SCHEMA …" and nothing
 * about the duplicate-key race behind it. This walks the cause chain and
 * keeps what an operator (and the bug intake) needs: each message, plus the
 * Postgres SQLSTATE, message and detail. Only a "Failed query:" message is
 * cut to its first line (the failing statement) — every other message is
 * the reason an Owner reads on the activation screen and stays whole.
 */

/** Upper bound per message: a reason, not a dump. */
const MAX_MESSAGE = 2000;
/** The failing statement of a drizzle query error, without the SQL after it. */
const MAX_QUERY_HEAD = 160;

interface ErrorLike {
  message?: unknown;
  errno?: unknown;
  detail?: unknown;
  cause?: unknown;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function readable(message: string): string {
  if (message.startsWith("Failed query:")) {
    return clip(message.split("\n", 1)[0] ?? "", MAX_QUERY_HEAD);
  }
  return clip(message, MAX_MESSAGE);
}

/** SQLSTATE codes are five characters of digits and upper-case letters. */
function sqlState(e: ErrorLike): string | null {
  return typeof e.errno === "string" && /^[0-9A-Z]{5}$/.test(e.errno) ? e.errno : null;
}

/**
 * Describe `error` and its causes in one line, outermost first.
 *
 * @example
 *   describeLoadError(drizzleError)
 *   // "Failed query: CREATE SCHEMA IF NOT EXISTS \"plugin_x\"; ← [23505] duplicate key value
 *   //  violates unique constraint \"pg_namespace_nspname_index\" (Key (nspname)=(plugin_x) already exists.)"
 */
export function describeLoadError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (typeof current !== "object") {
      parts.push(readable(String(current)));
      break;
    }
    const e = current as ErrorLike;
    const message = typeof e.message === "string" ? readable(e.message) : readable(String(e));
    const state = sqlState(e);
    const detail = typeof e.detail === "string" && e.detail !== "" ? ` (${e.detail})` : "";
    parts.push(state ? `[${state}] ${message}${detail}` : `${message}${detail}`);
    current = e.cause;
  }
  return parts.join(" ← ");
}
