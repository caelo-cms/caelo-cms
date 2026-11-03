// SPDX-License-Identifier: MPL-2.0

/**
 * The script tests' git fixture (git-fixture.test-helpers.ts, #814): a git
 * that would wait fails in time, and nothing of the machine's git setup
 * reaches the fixture.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitEnv, gitFixture } from "./git-fixture.test-helpers.ts";

describe("gitFixture", () => {
  it("stops a git command that waits instead of holding the job", () => {
    const f = gitFixture("caelo-git-fixture-", 300);
    try {
      const started = Date.now();
      expect(() => f.git("-c", "alias.wait=!sleep 5", "wait")).toThrow(/was stopped after 300 ms/);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      f.remove();
    }
  });

  it("commits and tags without the caller's identity, signing or hooks", () => {
    const f = gitFixture("caelo-git-fixture-");
    try {
      f.write("a/b.txt", "x\n");
      f.git("add", ".");
      f.git("commit", "-qm", "base");
      f.git("tag", "v0.1.0");
      expect(f.git("log", "--format=%an <%ae> %s").trim()).toBe("t <t@example.com> base");
      expect(f.git("config", "--global", "--list").trim()).toBe("");
    } finally {
      f.remove();
    }
  });

  it("ignores a GIT_DIR the caller set (a hook's), so it never touches the real repository", () => {
    const decoy = mkdtempSync(join(tmpdir(), "caelo-git-decoy-"));
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy, "not-a-repo");
    try {
      const f = gitFixture("caelo-git-fixture-");
      try {
        expect(realpathSync(f.git("rev-parse", "--absolute-git-dir").trim())).toBe(
          realpathSync(join(f.repo, ".git")),
        );
      } finally {
        f.remove();
      }
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe("fixtureGitEnv", () => {
  it("drops every GIT_ variable, isolates HOME and turns prompts off", () => {
    const home = mkdtempSync(join(tmpdir(), "caelo-git-home-"));
    try {
      writeFileSync(join(home, ".gitconfig"), "");
      const env = fixtureGitEnv(home, {
        PATH: "/usr/bin",
        HOME: "/Users/someone",
        GIT_DIR: "/real/.git",
        GIT_INDEX_FILE: "/real/.git/index",
        GIT_SSH_COMMAND: "ssh -i key",
      });
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe(home);
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_INDEX_FILE).toBeUndefined();
      expect(env.GIT_SSH_COMMAND).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(home, ".gitconfig"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
