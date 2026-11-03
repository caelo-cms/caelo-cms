// SPDX-License-Identifier: MPL-2.0

/**
 * A throwaway git repository for the script tests that need real history
 * (release-checks, migration-lint), isolated from the machine it runs on
 * (#814).
 *
 * A `git commit` in a fixture once hung a CI job until its timeout. Plain
 * `Bun.spawnSync(["git", …])` inherits everything that can make git wait
 * or misbehave: the global and system config (commit signing that asks a
 * pinentry, hooks via `core.hooksPath`, credential helpers), a terminal
 * prompt, and the `GIT_*` variables a hook sets (`GIT_DIR`,
 * `GIT_INDEX_FILE`), which would point the fixture's commands at the real
 * repository. So every call here runs with:
 *
 *   - its own HOME / XDG_CONFIG_HOME inside the fixture's parent dir, an
 *     empty global config and no system config;
 *   - no `GIT_*` variable from the caller, `GIT_TERMINAL_PROMPT=0`, no
 *     askpass, and signing and hooks switched off explicitly;
 *   - a timeout, so a git that still waits fails the test with its command
 *     instead of holding the job.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long one git command in a fixture may take. */
export const FIXTURE_GIT_TIMEOUT_MS = 20_000;

/** The environment of a fixture's git: the caller's, minus git's own, plus isolation. */
export function fixtureGitEnv(
  home: string,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

/** A fixture repository: its path, a git runner bound to it, and cleanup. */
export interface GitFixture {
  /** The work tree, already `git init`ed. */
  readonly repo: string;
  /** Run git in the fixture; throws with the command and stderr when it fails or times out. */
  git(...args: string[]): string;
  /** Write a file, relative to the work tree, creating its directories. */
  write(rel: string, body: string): void;
  /** Delete the fixture and its isolated HOME. */
  remove(): void;
}

/**
 * Create a fixture repository under the OS temp dir. `timeoutMs` limits
 * each of the caller's git commands.
 *
 * @example
 *   const f = gitFixture("caelo-release-checks-");
 *   f.write("a.txt", "x");
 *   f.git("add", ".");
 *   f.git("commit", "-qm", "base");
 *   f.remove();
 */
export function gitFixture(prefix: string, timeoutMs = FIXTURE_GIT_TIMEOUT_MS): GitFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "");
  const env = fixtureGitEnv(home);
  const run = (args: readonly string[], limitMs: number): string => {
    const p = Bun.spawnSync(
      [
        "git",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd: repo, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: limitMs },
    );
    if (p.exitCode !== 0) {
      const why =
        p.exitCode === null
          ? `was stopped after ${limitMs} ms (${p.signalCode ?? "signal"})`
          : `exited ${p.exitCode}`;
      throw new Error(`git ${args.join(" ")} ${why}: ${new TextDecoder().decode(p.stderr).trim()}`);
    }
    return new TextDecoder().decode(p.stdout);
  };
  const git = (...args: string[]): string => run(args, timeoutMs);
  // The setup itself always gets the default limit; `timeoutMs` is for the test's commands.
  run(["init", "-q"], Math.max(timeoutMs, FIXTURE_GIT_TIMEOUT_MS));
  return {
    repo,
    git,
    write: (rel, body) => {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), body);
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
