// SPDX-License-Identifier: MPL-2.0

import { copyFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Mirror `src` into `dst` so dst contains exactly src's tree. Files are
 * overwritten in place; files in dst not present in src are removed.
 * Empty subdirectories are pruned bottom-up.
 *
 * `dst` is synced in place rather than swapped because it is a bind
 * mount target: its inode must not change (see the caller).
 *
 * A path can change kind between builds — a page `/kontakt` that
 * shipped as `kontakt/index.html` and now ships as a file, or the
 * reverse — so the copy clears whatever of the other kind stands in its
 * way. Tolerates EFAULT on removal (Docker Desktop quirk on
 * rm-inside-bind-mount on macOS) so a build never fails the whole deploy
 * because a stale child couldn't be unlinked.
 */
export async function syncContents(src: string, dst: string): Promise<void> {
  const tolerate = async (op: () => Promise<unknown>) => {
    try {
      await op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EFAULT" && code !== "ENOENT") throw e;
    }
  };
  const kindOf = async (path: string) => {
    const s = await stat(path).catch(() => null);
    return s === null ? null : s.isDirectory() ? "dir" : "file";
  };

  const srcFiles = new Set<string>();
  const srcDirs = new Set<string>();
  const collect = async (rel: string): Promise<void> => {
    const entries = await readdir(join(src, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        srcDirs.add(childRel);
        await collect(childRel);
      } else srcFiles.add(childRel);
    }
  };
  await collect("");

  // A file in dst where src now has a directory blocks the mkdir below.
  for (const rel of [...srcDirs].sort()) {
    if ((await kindOf(join(dst, rel))) === "file") {
      await tolerate(() => rm(join(dst, rel), { force: true }));
    }
  }
  for (const rel of srcFiles) {
    const target = join(dst, rel);
    await mkdir(join(target, ".."), { recursive: true });
    // A directory in dst where src now has a file blocks the copy.
    if ((await kindOf(target)) === "dir") {
      await tolerate(() => rm(target, { recursive: true, force: true }));
    }
    await copyFile(join(src, rel), target);
  }

  const sweep = async (rel: string): Promise<void> => {
    const here = join(dst, rel);
    if ((await kindOf(here)) !== "dir") return;
    const entries = await readdir(here, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await sweep(childRel);
        const remaining = await readdir(join(dst, childRel)).catch(() => []);
        // rmdir, not rm: rm refuses a directory without `recursive`
        // (EISDIR), and recursive is wrong here — only an EMPTY
        // directory may go.
        if (remaining.length === 0) await tolerate(() => rmdir(join(dst, childRel)));
      } else if (!srcFiles.has(childRel)) {
        await tolerate(() => rm(join(dst, childRel), { force: true }));
      }
    }
  };
  await sweep("");
}
