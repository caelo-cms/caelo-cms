// SPDX-License-Identifier: MPL-2.0

/**
 * Read-only views of a source tree for the docs scripts (#827, #828): a
 * directory on disk, or a git ref read with `git show <ref>:<path>`.
 *
 * The git view is how the docs-sync workflow reads the release tag and the
 * `docs/cms-seed` branch: straight from the object database of its single
 * `main` checkout. Nothing from those refs is ever checked out, imported or
 * executed, so a ref's content is data to the workflow, never code.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Files of one tree, addressed by repo-relative POSIX paths. */
export interface SourceTree {
  /** For error messages: the directory or `git:<ref>`. */
  readonly label: string;
  /** The file's text, or `null` when the tree has no such file. */
  read(path: string): string | null;
  /** Names of the files directly inside `dir` (no recursion), sorted. */
  list(dir: string): string[];
}

/** A directory on disk. */
export function fsTree(root: string): SourceTree {
  return {
    label: root,
    read(path) {
      const abs = join(root, path);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    },
    list(dir) {
      const abs = join(root, dir);
      return existsSync(abs)
        ? readdirSync(abs, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort()
        : [];
    },
  };
}

/** Synchronous git runner: exit code + stdout. Injected for tests. */
export type GitRunner = (args: readonly string[]) => { code: number; stdout: string };

const defaultGit =
  (cwd: string): GitRunner =>
  (args) => {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stdout: p.stdout.toString() };
  };

/**
 * Fully-qualified refs only (`refs/tags/v1.2.3`, `refs/remotes/origin/x`),
 * so a branch can never stand in for a tag of the same name, and nothing
 * shaped like an option reaches git.
 */
const QUALIFIED_REF = /^refs\/(?:tags|remotes\/origin)\/[A-Za-z0-9._/-]+$/;

/**
 * A git ref of the repository at `cwd`.
 *
 * @throws when `ref` is not a fully-qualified tag or remote-branch ref, or
 *   does not exist.
 */
export function gitTree(ref: string, cwd: string, git: GitRunner = defaultGit(cwd)): SourceTree {
  if (!QUALIFIED_REF.test(ref) || ref.includes("..")) {
    throw new Error(`not a fully-qualified tag or remote-branch ref: ${ref}`);
  }
  if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code !== 0) {
    throw new Error(`git ref ${ref} does not exist in ${cwd}`);
  }
  return {
    label: `git:${ref}`,
    read(path) {
      const r = git(["show", `${ref}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    },
    list(dir) {
      const r = git(["ls-tree", "--name-only", `${ref}:${dir}`]);
      return r.code === 0 ? r.stdout.split("\n").filter(Boolean).sort() : [];
    },
  };
}
