// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — every transaction the Database Adapter opens names its
 * holder (the operation, or the `withAdminTransaction` holder label) in the
 * session's `application_name`, set LOCAL in the same statement as the
 * caller's identity, so it costs no extra round trip and reverts at COMMIT.
 *
 * Postgres prints it with `%a` in `log_line_prefix`, which lets the query
 * index gate (docs/dev/query-index-gate.md) attribute every logged plan to
 * the operation that ran it — including the RI-trigger and journal-trigger
 * statements the operation's writes fire — and ignore test-fixture SQL,
 * which runs on the raw pools outside any adapter transaction and carries
 * no tag. In production it shows the running operation in
 * `pg_stat_activity`.
 */

/** Every tag starts with this; untagged statements are not Query API work. */
const STATEMENT_TAG_PREFIX = "caelo/";

/**
 * Postgres truncates `application_name` to NAMEDATALEN - 1 bytes and turns
 * non-ASCII bytes into `?`; the tag is cut here so the logged value is the
 * one this function returns.
 */
const MAX_APPLICATION_NAME = 63;

/**
 * The `application_name` of a transaction opened for `holder`.
 *
 * @example transactionTag("pages.update_many") // "caelo/pages.update_many"
 */
export function transactionTag(holder: string): string {
  const printable = holder.replace(/[^\x20-\x7e]/g, "?");
  return `${STATEMENT_TAG_PREFIX}${printable}`.slice(0, MAX_APPLICATION_NAME);
}
