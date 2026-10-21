// SPDX-License-Identifier: MPL-2.0

/**
 * One upgrade at a time per self-hosted install (#696 Phase 4c): the host
 * agent and a hand-run `cms-provision upgrade` both take
 * `.caelo/upgrade.lock` for the whole run — two concurrent rolls would
 * overwrite each other's Compose file and restore the wrong one on rollback.
 *
 * The file holds the holder's pid; a lock whose process is gone (a crash, a
 * reboot) is taken over rather than blocking updates forever.
 *
 * The record is written to a private temp file first and then hard-linked
 * into place, so the lock file never exists half-written: a reader that
 * finds it can always trust its pid. (An unreadable file is only taken over
 * once it is older than any run could be.)
 *
 * Only real contention throws {@link UpgradeLockHeldError} (#804): a live
 * holder, a young unreadable record, a creation race. Anything else — the
 * directory is not writable, the disk is full — throws
 * {@link UpgradeLockAccessError} naming the lock file and the fix, so
 * callers can tell "busy, try later" from "broken, fix the server" (the GCP
 * upgrader's StateLockHeldError, #799).
 */

import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `.caelo/upgrade.lock`. */
export function upgradeLockPath(caeloDir: string): string {
  return join(caeloDir, "upgrade.lock");
}

/** Another upgrade holds the lock: the one failure that waiting fixes. */
export class UpgradeLockHeldError extends Error {
  override readonly name = "UpgradeLockHeldError";
}

/**
 * The lock could not be taken for a reason waiting does not fix (no write
 * access, a full disk); the message names the lock file and the fix.
 */
export class UpgradeLockAccessError extends Error {
  override readonly name = "UpgradeLockAccessError";
}

/** {@link UpgradeLockAccessError}'s message for filesystem error `e`. */
function lockAccessFailure(caeloDir: string, e: unknown): string {
  const path = upgradeLockPath(caeloDir);
  const code = (e as NodeJS.ErrnoException | null)?.code;
  const said = e instanceof Error ? e.message : String(e);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return `the upgrade lock ${path} cannot be written (${said}). Give the account the update runs as write access to ${caeloDir} (the agent runs as root through its systemd unit), then try again.`;
  }
  if (code === "ENOSPC" || code === "EDQUOT") {
    return `the upgrade lock ${path} cannot be written because the disk is full (${said}). Free space on the server, then try again.`;
  }
  if (code === "ENOENT") {
    return `the upgrade lock ${path} cannot be created: ${caeloDir} does not exist (${said}). Run the command from the install's directory, or re-run the installer to restore it.`;
  }
  return `the upgrade lock ${path} could not be taken (${said}). Check that ${caeloDir} is writable and the disk has space, then try again.`;
}

interface LockRecord {
  readonly pid: number;
  readonly holder: string;
  readonly at: string;
}

/** An unreadable lock file younger than this still counts as held (longer than any run). */
const UNREADABLE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** The lock file's modification time (0 when it vanished meanwhile). */
function lockMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether process `pid` exists (signal 0 checks without signalling). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is just someone else's.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the install's upgrade lock for `holder`.
 *
 * @returns the release function (idempotent)
 * @throws UpgradeLockHeldError when another upgrade holds it, naming that holder
 * @throws UpgradeLockAccessError for anything else (permissions, disk space)
 */
export function acquireUpgradeLock(
  caeloDir: string,
  holder: string,
  deps: { readonly pid?: number; readonly alive?: (pid: number) => boolean } = {},
): () => void {
  try {
    return takeUpgradeLock(caeloDir, holder, deps);
  } catch (e) {
    if (e instanceof UpgradeLockHeldError) throw e;
    throw new UpgradeLockAccessError(lockAccessFailure(caeloDir, e), { cause: e });
  }
}

/** {@link acquireUpgradeLock} without the classification of its errors. */
function takeUpgradeLock(
  caeloDir: string,
  holder: string,
  deps: { readonly pid?: number; readonly alive?: (pid: number) => boolean } = {},
): () => void {
  const path = upgradeLockPath(caeloDir);
  const alive = deps.alive ?? processAlive;
  const record: LockRecord = {
    pid: deps.pid ?? process.pid,
    holder,
    at: new Date().toISOString(),
  };
  const temp = `${path}.${record.pid}.${crypto.randomUUID()}`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Atomic: fails with EEXIST when someone holds the lock.
        linkSync(temp, path);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          rmSync(path, { force: true });
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        // Released between the link and the read: try again. A file this
        // account may not read is an access problem, not a busy lock.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      let held: Partial<LockRecord> | null = null;
      try {
        held = JSON.parse(text) as Partial<LockRecord>;
      } catch {
        // Corrupt (never half-written, see above): take it over only when old.
      }
      if (held === null) {
        if (Date.now() - lockMtime(path) < UNREADABLE_LOCK_MAX_AGE_MS) {
          throw new UpgradeLockHeldError(
            `another upgrade holds ${path} (its record is unreadable).`,
          );
        }
      } else if (typeof held.pid === "number" && alive(held.pid)) {
        throw new UpgradeLockHeldError(
          `${held.holder ?? "another upgrade"} is running on this install (pid ${held.pid}, since ${held.at ?? "?"}).`,
        );
      }
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(temp, { force: true });
  }
  throw new UpgradeLockHeldError(`could not take ${path}; another process keeps creating it.`);
}
