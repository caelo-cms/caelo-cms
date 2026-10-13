// SPDX-License-Identifier: MPL-2.0

/**
 * One upgrade at a time per self-hosted install (#696 Phase 4c): the host
 * agent and a hand-run `cms-provision upgrade` both take
 * `.caelo/upgrade.lock` for the whole run — two concurrent rolls would
 * overwrite each other's Compose file and restore the wrong one on rollback.
 *
 * The file holds the holder's pid; a lock whose process is gone (a crash, a
 * reboot) is taken over rather than blocking updates forever.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `.caelo/upgrade.lock`. */
export function upgradeLockPath(caeloDir: string): string {
  return join(caeloDir, "upgrade.lock");
}

interface LockRecord {
  readonly pid: number;
  readonly holder: string;
  readonly at: string;
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
 * @throws when a live process holds it, naming that holder
 */
export function acquireUpgradeLock(
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let held: Partial<LockRecord> = {};
    try {
      held = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    } catch {
      // Unreadable or half-written: treat as abandoned.
    }
    if (typeof held.pid === "number" && alive(held.pid)) {
      throw new Error(
        `${held.holder ?? "another upgrade"} is running on this install (pid ${held.pid}, since ${held.at ?? "?"}).`,
      );
    }
    rmSync(path, { force: true });
  }
  throw new Error(`could not take ${path}; another process keeps creating it.`);
}
