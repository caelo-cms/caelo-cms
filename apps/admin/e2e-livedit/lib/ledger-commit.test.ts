// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ledgerFileName } from "./budget.js";
import { mainGreenFileName } from "./main-greens.js";

const SCRIPT = resolve(import.meta.dir, "ledger-commit.sh");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** A bare repo standing in for GitHub, plus a source dir per commit. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "ledger-commit-"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const commit = (message: string, files: Record<string, string>): void => {
    const src = mkdtempSync(join(root, "src-"));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(src, path, ".."), { recursive: true });
      writeFileSync(join(src, path), body);
    }
    execFileSync("bash", [SCRIPT, message, src], {
      env: { ...process.env, LEDGER_REMOTE: remote, RUNNER_TEMP: root },
      stdio: "pipe",
    });
  };
  const ls = (dir: string): string[] =>
    execFileSync(
      "git",
      ["--git-dir", remote, "ls-tree", "--name-only", `e2e-livedit-ledger:${dir}`],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter(Boolean)
      .sort();
  /** Plant files on the branch directly, as an older run would have. */
  const seed = (files: Record<string, string>): void => {
    const wt = mkdtempSync(join(root, "seed-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: wt, stdio: "pipe" });
    git("init", "-q");
    git("checkout", "-q", "--orphan", "e2e-livedit-ledger");
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(wt, path, ".."), { recursive: true });
      writeFileSync(join(wt, path), body);
    }
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "seed",
    );
    git("push", "-q", remote, "HEAD:refs/heads/e2e-livedit-ledger");
  };
  return { commit, ls, seed };
}

describe("ledger-commit.sh", () => {
  it("creates the branch when it does not exist yet", () => {
    const { commit, ls } = setup();
    const run = ledgerFileName(new Date(), "9", "1", 3);
    commit("first", { [`runs/${run}`]: "{}\n" });
    expect(ls("runs")).toEqual([run]);
  });

  it("adds spend and greens, pruning both", () => {
    const { commit, ls, seed } = setup();
    const now = new Date();
    const old = new Date(now.getTime() - 10 * 86_400_000);
    const staleRun = ledgerFileName(old, "1", "1", 5);
    const freshRun = ledgerFileName(now, "2", "1", 7);
    seed({ [`runs/${staleRun}`]: "{}\n" });

    const olderGreen = mainGreenFileName("homepage", old, SHA_A, "1", "1");
    const otherGreen = mainGreenFileName("consent", old, SHA_A, "1", "1");
    commit("second", {
      [`runs/${freshRun}`]: "{}\n",
      [`greens/${olderGreen}`]: "{}\n",
      [`greens/${otherGreen}`]: "{}\n",
    });
    // The 10-day-old spend entry is pruned when the next one is written.
    expect(ls("runs")).toEqual([freshRun]);
    expect(ls("greens")).toEqual([otherGreen, olderGreen].sort());

    const newerGreen = mainGreenFileName("homepage", now, SHA_B, "3", "1");
    commit("third", { [`greens/${newerGreen}`]: "{}\n" });
    // Only the newest green per scenario stays; other scenarios keep theirs.
    expect(ls("greens")).toEqual([otherGreen, newerGreen].sort());
    expect(ls("runs")).toEqual([freshRun]);
  });
});
