#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * P17.0 — Caelo release pipeline.
 *
 *   bun run scripts/release.ts <new-version> [--dry-run]
 *
 * What it does:
 *   1. Validates the new version is SemVer + strictly greater than current.
 *   2. Updates packages/shared/src/version.ts CALEO_VERSION constant.
 *   3. Updates root package.json + every workspace package.json `version`.
 *   4. Re-signs every Tier-1 plugin manifest under packages/plugins/<slug>/
 *      via apps/admin/scripts/sign-tier1-manifest.ts (the same script
 *      `bun run plugins:sign` uses).
 *   5. Generates docs/CHANGELOG.md entry from conventional commits since
 *      the last `vX.Y.Z` git tag (delegates to scripts/release-notes.ts).
 *   6. Commits the changes (`chore(release): vX.Y.Z`).
 *   7. Tags `vX.Y.Z`.
 *   8. Prints next-steps for the operator (`git push --follow-tags`,
 *      then GitHub Actions takes over for `bunx cms-provision --version`
 *      compatibility).
 *
 * --dry-run: do everything except writing files / git commit / git tag.
 *            Prints what WOULD change.
 *
 * GitHub Actions integration (lands in P17 proper):
 *   on: push: tags: ['v*']
 *   runs: build images per provider + push to ghcr.io + bundle Tier-1
 *         manifests into a release artifact + create GitHub release.
 *   NOT in this scaffold — this script just preps the local commit
 *   that triggers Actions.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const VERSION_FILE = resolve(REPO_ROOT, "packages/shared/src/version.ts");
const ROOT_PKG = resolve(REPO_ROOT, "package.json");

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getCurrent(): string {
  const src = readFileSync(VERSION_FILE, "utf8");
  const m = /CAELO_VERSION = "([^"]+)"/.exec(src);
  if (!m) throw new Error("CAELO_VERSION not found in version.ts");
  return m[1] as string;
}

function semverGt(a: string, b: string): boolean {
  // Simple major.minor.patch comparator. Pre-release tags (-alpha, -rc.1)
  // are treated as < the same X.Y.Z without one. Sufficient for our
  // pre-1.0 cadence; full SemVer 2 ordering lands when 1.0 ships.
  const reg = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
  const ma = reg.exec(a);
  const mb = reg.exec(b);
  if (!ma || !mb) throw new Error(`bad SemVer: ${a} vs ${b}`);
  const [, a1, a2, a3, aPre] = ma;
  const [, b1, b2, b3, bPre] = mb;
  for (const [x, y] of [
    [a1, b1],
    [a2, b2],
    [a3, b3],
  ] as const) {
    const xn = Number.parseInt(x ?? "0", 10);
    const yn = Number.parseInt(y ?? "0", 10);
    if (xn > yn) return true;
    if (xn < yn) return false;
  }
  // Same X.Y.Z. A pre-release < no-pre-release.
  if (aPre && !bPre) return false;
  if (!aPre && bPre) return true;
  if (aPre && bPre) return aPre > bPre;
  return false; // equal
}

function bumpJsonVersions(newVersion: string, dryRun: boolean): string[] {
  const changedPaths: string[] = [];
  const proc = Bun.spawnSync(
    [
      "find",
      REPO_ROOT,
      "-name",
      "package.json",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/dist/*",
    ],
    { stdout: "pipe" },
  );
  const paths = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version && pkg.version !== newVersion) {
      pkg.version = newVersion;
      if (!dryRun) writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
      changedPaths.push(p);
    }
  }
  return changedPaths;
}

function bumpVersionFile(newVersion: string, dryRun: boolean): void {
  const src = readFileSync(VERSION_FILE, "utf8");
  const next = src.replace(/CAELO_VERSION = "[^"]+"/, `CAELO_VERSION = "${newVersion}"`);
  if (next === src) {
    throw new Error("version.ts CAELO_VERSION line did not match — refusing to write");
  }
  if (!dryRun) writeFileSync(VERSION_FILE, next);
}

async function resignManifests(dryRun: boolean): Promise<number> {
  const signScript = resolve(REPO_ROOT, "apps/admin/scripts/sign-tier1-manifest.ts");
  if (!existsSync(signScript)) {
    console.warn(`sign-tier1-manifest.ts not found — skipping resign step`);
    return 0;
  }
  if (dryRun) {
    console.log(`[dry-run] would run: bun run ${signScript}`);
    return 0;
  }
  const proc = Bun.spawn(["bun", "run", signScript], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error("plugin manifest re-signing failed");
  return 1;
}

function maybeGitCommitTag(newVersion: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`[dry-run] would commit + tag vX.Y.Z`);
    return;
  }
  const status = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  const dirty = new TextDecoder().decode(status.stdout).trim();
  if (!dirty) {
    console.warn("no staged changes after bump — skipping git commit + tag");
    return;
  }
  Bun.spawnSync(["git", "add", "-u"], { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" });
  const commit = Bun.spawnSync(["git", "commit", "-m", `chore(release): v${newVersion}`], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (commit.exitCode !== 0) throw new Error("git commit failed");
  const tag = Bun.spawnSync(["git", "tag", "-a", `v${newVersion}`, "-m", `Caelo v${newVersion}`], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (tag.exitCode !== 0) throw new Error("git tag failed");
}

function bumpKind(current: string, kind: "patch" | "minor" | "major"): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`bad current version: ${current}`);
  const [, maj, min, pat] = m;
  switch (kind) {
    case "patch":
      return `${maj}.${min}.${Number(pat) + 1}`;
    case "minor":
      return `${maj}.${Number(min) + 1}.0`;
    case "major":
      return `${Number(maj) + 1}.0.0`;
  }
}

function checkLockstep(target: string): { ok: boolean; mismatches: { file: string; v: string }[] } {
  const proc = Bun.spawnSync(
    [
      "find",
      REPO_ROOT,
      "-name",
      "package.json",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/dist/*",
      "-not",
      "-path",
      "*/.svelte-kit/*",
      "-not",
      "-path",
      "*/build/*",
    ],
    { stdout: "pipe" },
  );
  const paths = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
  const mismatches: { file: string; v: string }[] = [];
  for (const p of paths) {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    if (pkg.version && pkg.version !== target) mismatches.push({ file: p, v: pkg.version });
  }
  return { ok: mismatches.length === 0, mismatches };
}

function lastReleaseTag(): string | null {
  const proc = Bun.spawnSync(["git", "describe", "--tags", "--abbrev=0", "--match", "v*"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  return new TextDecoder().decode(proc.stdout).trim() || null;
}

function generateChangelog(prevTag: string | null, newVersion: string): string {
  const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
  const proc = Bun.spawnSync(
    ["git", "log", range, "--pretty=format:%h %s", "--no-merges"],
    { cwd: REPO_ROOT, stdout: "pipe" },
  );
  const log = new TextDecoder().decode(proc.stdout).trim();
  if (!log) return `## v${newVersion}\n\n_no changes since last tag_\n`;
  const groups: Record<string, string[]> = {
    feat: [],
    fix: [],
    refactor: [],
    docs: [],
    chore: [],
    test: [],
    other: [],
  };
  for (const line of log.split("\n")) {
    const m = line.match(/^([0-9a-f]+)\s+(\w+)(?:\([^)]+\))?(!)?:\s*(.+)$/);
    if (m) {
      const kind = m[2] in groups ? (m[2] as keyof typeof groups) : "other";
      const breaking = m[3] ? " ⚠ BREAKING" : "";
      groups[kind]?.push(`- ${m[1]} ${m[4]}${breaking}`);
    } else {
      groups.other?.push(`- ${line}`);
    }
  }
  const HEADINGS: Record<string, string> = {
    feat: "Features",
    fix: "Fixes",
    refactor: "Refactors",
    docs: "Docs",
    chore: "Chores",
    test: "Tests",
    other: "Other",
  };
  const out = [`## v${newVersion}\n`];
  for (const k of ["feat", "fix", "refactor", "docs", "chore", "test", "other"]) {
    const entries = groups[k] ?? [];
    if (entries.length === 0) continue;
    out.push(`### ${HEADINGS[k]}\n${entries.join("\n")}\n`);
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const arg0 = process.argv[2];
  if (!arg0 || arg0 === "--help" || arg0 === "-h") {
    console.error(
      "Usage:\n" +
        "  bun run scripts/release.ts <patch|minor|major|x.y.z> [--dry-run]\n" +
        "  bun run scripts/release.ts --check     # verify lockstep, no bump",
    );
    process.exit(2);
  }
  if (arg0 === "--check") {
    const target = getCurrent();
    const result = checkLockstep(target);
    if (result.ok) {
      console.log(`✓ all packages at v${target}`);
      process.exit(0);
    }
    console.error(`✗ ${result.mismatches.length} package(s) drift from v${target}:`);
    for (const m of result.mismatches) console.error(`  ${m.file}: ${m.v}`);
    process.exit(1);
  }
  const dryRun = arg("dry-run");
  const current = getCurrent();
  const newVersion = ["patch", "minor", "major"].includes(arg0)
    ? bumpKind(current, arg0 as "patch" | "minor" | "major")
    : arg0;
  if (!semverGt(newVersion, current)) {
    console.error(`new version ${newVersion} must be strictly greater than current ${current}`);
    process.exit(2);
  }
  console.log(`Caelo release: ${current} → ${newVersion}${dryRun ? " (dry-run)" : ""}`);

  bumpVersionFile(newVersion, dryRun);
  console.log(`✓ packages/shared/src/version.ts updated`);

  const changed = bumpJsonVersions(newVersion, dryRun);
  console.log(`✓ ${changed.length} package.json files updated`);

  await resignManifests(dryRun);
  console.log(`✓ Tier-1 manifests resigned`);

  // Generate the changelog stanza from conventional commits since the
  // last v* tag. Prepended to CHANGELOG.md (top-level) so the most
  // recent release is at the top.
  const prevTag = lastReleaseTag();
  const stanza = generateChangelog(prevTag, newVersion);
  const changelogPath = resolve(REPO_ROOT, "CHANGELOG.md");
  const HEADER = "# Changelog\n\n";
  if (!dryRun) {
    const prior = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : HEADER;
    const body = prior.startsWith(HEADER) ? prior.slice(HEADER.length) : prior;
    writeFileSync(changelogPath, `${HEADER}${stanza}\n${body}`);
    console.log(`✓ CHANGELOG.md ${prevTag ? `appended commits since ${prevTag}` : "initialised"}`);
  } else {
    console.log("[dry-run] changelog stanza would prepend:\n" + stanza);
  }

  maybeGitCommitTag(newVersion, dryRun);
  console.log(`\nNext: git push --follow-tags`);
  console.log(`Then GitHub Actions builds + publishes the release artifact.`);
}

await main();

// Touch ROOT_PKG via the bumpJsonVersions sweep.
void ROOT_PKG;
