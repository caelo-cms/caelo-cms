// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Write a file only its owner may read (0600), replacing any file at `path`.
 *
 * The data goes into a fresh temp file created 0600 (`wx`, so never an
 * existing file or a planted symlink) and is renamed over `path`. Writing in
 * place would not do: `writeFileSync`'s `mode` applies only when the call
 * creates the file, so a secret file an older CLI wrote world-readable would
 * hold the new secret world-readable until a chmod after the write — and a
 * reader that opened it before any chmod keeps its descriptor. The rename
 * gives the new contents a new inode that was never readable by anyone else.
 */
export function writePrivateFile(path: string, data: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Take group/other access off an install's secrets directory and the secret
 * files in it, for installs an older CLI created with the default umask
 * (`.caelo/` 0755, `config.json` / `internal-secret.json` 0644). Those files
 * are written once and rarely rewritten, so tightening only on the next write
 * would leave them readable to every local user. Missing paths are skipped:
 * which secrets exist depends on the provider and how far `init` got.
 *
 * @param dir the install's directory, tightened to 0700
 * @param privateDirs subdirectories (relative to `dir`) tightened to 0700
 * @param privateFiles files (relative to `dir`) tightened to 0600
 */
export function tightenPrivateTree(
  dir: string,
  privateDirs: readonly string[],
  privateFiles: readonly string[],
): void {
  const tighten = (path: string, mode: number) => {
    if (existsSync(path) && (statSync(path).mode & 0o077) !== 0) chmodSync(path, mode);
  };
  tighten(dir, 0o700);
  for (const sub of privateDirs) tighten(`${dir}/${sub}`, 0o700);
  for (const file of privateFiles) tighten(`${dir}/${file}`, 0o600);
}
