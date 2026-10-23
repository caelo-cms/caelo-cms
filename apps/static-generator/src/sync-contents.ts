// SPDX-License-Identifier: MPL-2.0

import { copyFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { runBatched } from "@caelo-cms/shared";

/**
 * Files in flight at once. One at a time cost a full syscall round trip
 * per file (#1003: ~3 ms per copy, the largest step of a 5,000-page
 * Stage); unbounded would run out of file descriptors (macOS defaults
 * to 256).
 */
const FS_PARALLELISM = 32;

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

  const source = await listTree(src);

  // A file in dst where src now has a directory blocks the mkdir below.
  await runBatched([...source.dirs], FS_PARALLELISM, async (rel) => {
    if ((await kindOf(join(dst, rel))) === "file") {
      await tolerate(() => rm(join(dst, rel), { force: true }));
    }
  });
  // Every directory once, parents first, instead of a mkdir per file.
  for (const level of byDepth(source.dirs, "shallowest-first")) {
    await runBatched(level, FS_PARALLELISM, async (rel) => {
      await mkdir(join(dst, rel), { recursive: true });
    });
  }
  await runBatched([...source.files], FS_PARALLELISM, async (rel) => {
    const target = join(dst, rel);
    // A directory in dst where src now has a file blocks the copy.
    if ((await kindOf(target)) === "dir") {
      await tolerate(() => rm(target, { recursive: true, force: true }));
    }
    await copyFile(join(src, rel), target);
  });

  const mirrored = await listTree(dst);
  await runBatched(
    [...mirrored.files].filter((rel) => !source.files.has(rel)),
    FS_PARALLELISM,
    (rel) => tolerate(() => rm(join(dst, rel), { force: true })),
  );
  // Deepest first, so a directory emptied by pruning its children goes too.
  // rmdir, not rm: rm refuses a directory without `recursive` (EISDIR), and
  // recursive is wrong here — only an EMPTY directory may go.
  for (const level of byDepth(mirrored.dirs, "deepest-first")) {
    await runBatched(level, FS_PARALLELISM, async (rel) => {
      const remaining = await readdir(join(dst, rel)).catch(() => []);
      if (remaining.length === 0) await tolerate(() => rmdir(join(dst, rel)));
    });
  }
}

/** Every file and directory under `root`, as paths relative to it. */
async function listTree(root: string): Promise<{ files: Set<string>; dirs: Set<string> }> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        dirs.add(childRel);
        await walk(childRel);
      } else files.add(childRel);
    }
  };
  await walk("");
  return { files, dirs };
}

/** `paths` grouped by directory depth; paths of one level never contain each other. */
function byDepth(
  paths: ReadonlySet<string>,
  order: "shallowest-first" | "deepest-first",
): string[][] {
  const levels = new Map<number, string[]>();
  for (const p of paths) {
    const depth = p.split(sep).length;
    const level = levels.get(depth);
    if (level) level.push(p);
    else levels.set(depth, [p]);
  }
  const depths = [...levels.keys()].sort((a, b) => (order === "shallowest-first" ? a - b : b - a));
  return depths.map((d) => levels.get(d) ?? []);
}
