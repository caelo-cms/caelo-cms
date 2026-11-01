// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — the query index gate's lists (docs/dev/query-index-gate.md).
 *
 * A finding is (op, relation, normalised filter) as analyze.ts prints it.
 * A rule matches by `table` (schema-qualified, `*` globs), optionally
 * narrowed by `op` (globs), the exact `filter` and the `kind`. Every rule
 * must match at least one finding of the run — a stale rule fails the gate,
 * so the lists never outlive the code they describe.
 *
 *   - {@link ALLOWED}: reasoned, permanent exemptions — singleton or
 *     fixed-size tables, deliberate whole-table reads, maintenance scans.
 *     Pattern of `LICENSE_EXCEPTIONS` in scripts/license-check.ts.
 *   - {@link PENDING}: known findings a tracked issue fixes. Each one is a
 *     FIXME(issue #N): the fix's PR deletes the entries it makes stale.
 */

/** What a list entry matches. */
export interface GateRule {
  /** Schema-qualified relation; `*` matches any run of characters. */
  readonly table: string;
  /** Operation / holder name; `*` globs. Omitted: any. */
  readonly op?: string;
  /** Exact normalised filter. Omitted: any. */
  readonly filter?: string;
  /** Omitted: both kinds. */
  readonly kind?: "filter" | "fk";
}

/** A permanent exemption and why the scan is fine. */
export interface AllowedRule extends GateRule {
  readonly reason: string;
}

/** A known finding and the issue whose fix removes it. */
export interface PendingRule extends GateRule {
  readonly issue: 1291 | 1292;
}

export const ALLOWED: readonly AllowedRule[] = [];

export const PENDING: readonly PendingRule[] = [];
