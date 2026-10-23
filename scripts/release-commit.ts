#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Is a commit exactly what `scripts/release.ts` writes on top of its parent?
 *
 *   bun scripts/release-commit.ts verify [--base <ref>] [--head <ref>]
 *
 * A release is cut from a main commit that CI and the real-AI suite already
 * passed, and the release commit only moves version stamps and regenerates
 * data (changelog, release declaration, Power-MCP catalogue). When this
 * check proves that, release.yml's gate re-checks those files (lint,
 * typecheck, lockstep, catalogue) instead of re-running the whole test suite
 * a second time on the same code. Anything else in the commit — one more
 * file, a dependency edited next to a version, a script line in a
 * package.json — sends the release through the full gate.
 *
 * Every rule compares the two versions of a file after normalising the
 * version stamps away, so the only difference a rule tolerates is a version.
 */

import { resolve } from "node:path";
import { UNRELEASED_VERSION } from "./release-checks.ts";

/**
 * Files release.ts regenerates wholesale. Their content is data that the
 * gate checks on its own (the catalogue against the code, the declaration
 * when the release manifest is generated), so any change is accepted. Main
 * carries no CHANGELOG.md or release-meta.json, so the release commit adds
 * them; adding is accepted for these files only.
 */
const REGENERATED = new Set([
  "CHANGELOG.md",
  "release-meta.json",
  "packages/mcp-server/power-catalogue.json",
]);

/** JSON files whose only release change is their `version` fields. */
const VERSIONED_JSON = new Set([
  "packages/mcp-server/server.json",
  "integrations/claude-code/.claude-plugin/plugin.json",
]);

/** Text files with a version-stamp pattern; everything outside it must match. */
const STAMPED_TEXT: Record<string, RegExp> = {
  "packages/shared/src/version.ts": /CAELO_VERSION = "[^"]+"/g,
  "integrations/claude-code/.mcp.json": /@caelo-cms\/mcp-server@[^"]+"/g,
  // Workspace entries in the lockfile record each package's version.
  "bun.lock": /^(\s*)"version": "[^"]+",?$/gm,
};

/** One file of the commit, as git reports it. */
export interface ReleaseCommitFile {
  readonly path: string;
  /** Content at the base; null when the commit adds the file. */
  readonly base: string | null;
  /** Content at the head; null when the commit deletes the file. */
  readonly head: string | null;
}

/** JSON with every `version` key removed, at any depth, for comparison. */
function withoutVersions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVersions);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "version")
        .map(([key, v]) => [key, withoutVersions(v)]),
    );
  }
  return value;
}

function sameJsonButVersions(base: string, head: string): boolean {
  try {
    return (
      JSON.stringify(withoutVersions(JSON.parse(base))) ===
      JSON.stringify(withoutVersions(JSON.parse(head)))
    );
  } catch {
    return false;
  }
}

/** Why `file` is not a release-commit change, or null when it is. */
export function releaseFileProblem(file: ReleaseCommitFile): string | null {
  const { path, base, head } = file;
  if (head === null) return `${path}: deleted (a release commit never deletes a file)`;
  if (REGENERATED.has(path)) return null;
  if (base === null) {
    return `${path}: added (a release commit adds only the changelog and the release declaration)`;
  }
  if (VERSIONED_JSON.has(path) || path === "package.json" || path.endsWith("/package.json")) {
    return sameJsonButVersions(base, head) ? null : `${path}: changes more than its version`;
  }
  const stamp = STAMPED_TEXT[path];
  if (stamp) {
    return base.replace(stamp, "<version>") === head.replace(stamp, "<version>")
      ? null
      : `${path}: changes more than its version stamp`;
  }
  return `${path}: not a file the release script writes`;
}

/**
 * Every problem across the commit's files; empty when it is a pure release
 * commit.
 *
 * @param version - the version the commit is stamped with (its package.json)
 */
export function releaseCommitProblems(
  files: readonly ReleaseCommitFile[],
  version: string,
): string[] {
  if (version === UNRELEASED_VERSION) {
    return [`the commit is stamped v${UNRELEASED_VERSION}, the unreleased marker, not a release`];
  }
  if (files.length === 0) return ["the commit changes nothing"];
  return files.flatMap((f) => releaseFileProblem(f) ?? []);
}

function git(args: readonly string[], cwd: string): string | null {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout) : null;
}

/** The files `head` changes against `base`, with both contents. */
export function readCommitFiles(base: string, head: string, cwd: string): ReleaseCommitFile[] {
  const names = git(["diff", "--name-only", "--no-renames", base, head], cwd);
  if (names === null)
    throw new Error(`git diff ${base} ${head} failed — are both commits fetched?`);
  return names
    .split("\n")
    .filter(Boolean)
    .map((path) => ({
      path,
      base: git(["show", `${base}:${path}`], cwd),
      head: git(["show", `${head}:${path}`], cwd),
    }));
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  if (process.argv[2] !== "verify") {
    console.error("Usage: bun scripts/release-commit.ts verify [--base <ref>] [--head <ref>]");
    process.exit(2);
  }
  const repoRoot = resolve(import.meta.dir, "..");
  const head = argValue("head") ?? "HEAD";
  const base = argValue("base") ?? `${head}^`;
  const pkg = git(["show", `${head}:package.json`], repoRoot);
  if (pkg === null) throw new Error(`no package.json at ${head}`);
  const { version } = JSON.parse(pkg) as { version: string };
  const problems = releaseCommitProblems(readCommitFiles(base, head, repoRoot), version);
  if (problems.length > 0) {
    console.log(`${head} is not a pure release commit on ${base}:`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log(`${head} only moves ${base} to v${version} (release-script files only).`);
}
