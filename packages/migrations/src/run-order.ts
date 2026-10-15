// SPDX-License-Identifier: MPL-2.0

/**
 * Release ordering for contract migrations, enforced by the migration runner
 * instead of by release process (issue #635).
 *
 * A contract migration breaks the previous release's images, so it ships one
 * release after the expand migration that made the new code path work. If an
 * install jumps from before the expand release straight to the contract
 * release, both run in ONE migration run and the services that were serving
 * (the old release's) break mid-roll — with no release in between that ever
 * ran on the expanded schema. A migration declares that dependency in its
 * leading comment header:
 *
 *   -- caelo:requires-earlier-run 0281_public_projection_outbox.sql
 *
 * and the runner refuses the whole run, BEFORE applying anything, unless that
 * migration was recorded by an earlier run. Refusing before applying matters:
 * applying the expand half and then stopping would make a plain retry of the
 * same jump succeed. A database with no recorded migration is a fresh install
 * — nothing was serving, so everything may apply in one run.
 */

const REQUIRES_EARLIER_RUN = /^--\s*caelo:requires-earlier-run\s+(\S+)\s*$/;

/**
 * The migrations a migration's leading comment header names with
 * `caelo:requires-earlier-run`. Only the header counts (the comment lines
 * before the first statement), like `caelo:contract`.
 */
export function requiredEarlierRuns(body: string): string[] {
  const names: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("--")) break;
    const m = REQUIRES_EARLIER_RUN.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/** A migration the run would apply. */
export interface PendingMigration {
  /** The file name, as recorded in `__drizzle_migrations.hash`. */
  readonly name: string;
  readonly body: string;
}

/**
 * Why this run must not start, one message per violation (empty when it
 * may). `appliedBefore` is what `__drizzle_migrations` held when the run
 * started; `available` is every migration file the release ships.
 */
export function runOrderViolations(input: {
  readonly pending: readonly PendingMigration[];
  readonly appliedBefore: ReadonlySet<string>;
  readonly available: readonly string[];
}): string[] {
  const violations: string[] = [];
  const fresh = input.appliedBefore.size === 0;
  for (const migration of input.pending) {
    for (const required of requiredEarlierRuns(migration.body)) {
      if (!input.available.includes(required) || required >= migration.name) {
        violations.push(
          `${migration.name} requires an earlier run of ${required}, which is not a migration that sorts before it in this release. Fix the caelo:requires-earlier-run header.`,
        );
        continue;
      }
      if (fresh || input.appliedBefore.has(required)) continue;
      violations.push(
        `${migration.name} needs ${required} applied by an EARLIER release's migration run, but this install is upgrading from a release that predates it, straight to this one. Nothing was applied, and the running release keeps serving. Upgrade to the newest release that ships ${required} but not ${migration.name} first (RELEASING.md, "Contract migrations"), let that upgrade finish, then upgrade to this release. If this is a brand-new install whose first migration run failed part-way, drop and recreate both databases and run again.`,
      );
    }
  }
  return violations;
}

/** Thrown when {@link runOrderViolations} refuses a run. */
export class MigrationRunOrderError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`migration run refused (release ordering):\n- ${violations.join("\n- ")}`);
    this.name = "MigrationRunOrderError";
  }
}
