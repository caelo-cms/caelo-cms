// SPDX-License-Identifier: MPL-2.0
import { chmodSync, writeFileSync } from "node:fs";

/**
 * Write a file only its owner may read (0600). `writeFileSync`'s `mode`
 * applies only when the call creates the file, so an install whose secret
 * files an older CLI wrote world-readable would keep them that way on every
 * rewrite; the explicit chmod tightens them on the next write.
 */
export function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}
