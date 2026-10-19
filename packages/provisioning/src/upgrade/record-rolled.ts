// SPDX-License-Identifier: MPL-2.0

/**
 * After a CLI upgrade rolled: record the digests that now serve, so nothing
 * re-deploys an older release — install.json (what a wizard re-run deploys
 * and what the in-cloud upgrader judges the next update by) and the Pulumi
 * stack config (what a plain `pulumi up` deploys).
 *
 * The roll already succeeded, so a failed write never undoes it, and one
 * failing never skips the other. But it is a failed upgrade, not a warning
 * (#860, CLAUDE.md §2 no fallbacks): a run that exits 0 while install.json
 * still names the previous release leaves every later update judging
 * against a stale record. So each failure prints the exact manual fix and
 * the result makes the command exit non-zero.
 */

import type { ImageDigests } from "../install-state.js";

/** Where the records go; the real ones are wired in lifecycle.ts. */
export interface RecordRolledDeps {
  /** Write install.json (recordImageDigests). Throws when it cannot. */
  readonly recordInstall: (digests: ImageDigests, releaseVersion: string | null) => void;
  /** Pin the digests in the Pulumi stack config. Throws when it cannot. */
  readonly pinStack: (
    digests: ImageDigests,
  ) => Promise<{ readonly removedOverrides: readonly string[] }>;
  /** The commands that pin `digests` in the stack by hand. */
  readonly stackRecovery: (digests: ImageDigests) => string;
  /** Where install.json lives, for the manual fix (`gs://…/install.json` or a path). */
  readonly installJsonLocation: string;
  readonly log: {
    readonly info: (message: string) => void;
    readonly warn: (message: string) => void;
    readonly error: (message: string) => void;
  };
}

/**
 * Record the rolled `digests` (and `releaseVersion`, when known).
 *
 * @returns whether every record was written; false means the upgrade must
 *   exit non-zero — the fix for each failure has been printed.
 */
export async function recordRolledDigests(
  digests: ImageDigests,
  releaseVersion: string | null,
  deps: RecordRolledDeps,
): Promise<boolean> {
  const { log } = deps;
  const reason = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
  if (!releaseVersion) {
    log.warn(
      "Could not tell which Caelo release these images are (no version tag points at them), so install.json records none; in-product updates stay unavailable until an upgrade to a released version.",
    );
  }
  let ok = true;
  try {
    deps.recordInstall(digests, releaseVersion);
  } catch (e) {
    ok = false;
    const fields = {
      imageDigests: digests,
      ...(releaseVersion ? { releaseVersion } : {}),
    };
    log.error(
      `The new release serves, but its digests could not be recorded in ${deps.installJsonLocation} (${reason(e)}). Set these fields there before anything else, or a re-run of the installer deploys another release and in-product updates refuse to run:\n${JSON.stringify(fields, null, 2)}`,
    );
  }
  try {
    const { removedOverrides } = await deps.pinStack(digests);
    log.info("Pinned the rolled image digests in the Pulumi stack config.");
    if (removedOverrides.length > 0) {
      log.warn(
        `Removed ${removedOverrides.join(", ")} from the stack config: those image overrides win over the digest pins, so a later \`pulumi up\` would have rolled back to them.`,
      );
    }
  } catch (e) {
    ok = false;
    log.error(
      `Could not pin the rolled digests in the Pulumi stack config (${reason(e)}). Before any manual \`pulumi up\`, run:\n${deps.stackRecovery(digests)}`,
    );
  }
  return ok;
}
