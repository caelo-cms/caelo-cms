// SPDX-License-Identifier: MPL-2.0

import { CAELO_VERSION, provisioningCommand } from "@caelo-cms/shared";

/**
 * A command line for this CLI, pinned to the version that is running
 * (#696): `bunx @caelo-cms/provisioning@<this version> <args>`. Hints the
 * CLI prints — resume the wizard, rotate a secret, check status — then
 * run the same release the operator is using now, instead of whatever
 * copy `bunx` cached for the bare package name.
 *
 * Not for upgrades: an upgrade must run as the *target* release, so
 * `status` and the admin's Settings → Updates page build that command
 * with the target version (`provisioningUpgradeCommand` in @caelo-cms/shared).
 *
 * @example selfCommand("rotate-secret", "internal-secret")
 *   // → "bunx @caelo-cms/provisioning@0.10.43 rotate-secret internal-secret"
 */
export function selfCommand(...args: string[]): string {
  return provisioningCommand(CAELO_VERSION, args);
}
