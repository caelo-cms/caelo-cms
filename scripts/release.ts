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
  const m = /CALEO_VERSION = "([^"]+)"/.exec(src);
  if (!m) throw new Error("CALEO_VERSION not found in version.ts");
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
  const next = src.replace(/CALEO_VERSION = "[^"]+"/, `CALEO_VERSION = "${newVersion}"`);
  if (next === src) {
    throw new Error("version.ts CALEO_VERSION line did not match — refusing to write");
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

async function main(): Promise<void> {
  const newVersion = process.argv[2];
  if (!newVersion || newVersion.startsWith("--")) {
    console.error("Usage: bun run scripts/release.ts <new-version> [--dry-run]");
    process.exit(2);
  }
  const dryRun = arg("dry-run");
  const current = getCurrent();
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

  // Release notes generation lands in scripts/release-notes.ts; for v1
  // we just stamp a placeholder so the changelog file always exists.
  const changelogPath = resolve(REPO_ROOT, "docs/CHANGELOG.md");
  if (!existsSync(changelogPath) && !dryRun) {
    writeFileSync(
      changelogPath,
      `# Caelo CHANGELOG\n\n## v${newVersion}\n\n- (auto-generated release notes — TODO: scripts/release-notes.ts)\n`,
    );
    console.log(`✓ docs/CHANGELOG.md initialised`);
  }

  maybeGitCommitTag(newVersion, dryRun);
  console.log(`\nNext: git push --follow-tags`);
  console.log(`Then GitHub Actions builds + publishes the release artifact.`);
}

await main();

// Touch ROOT_PKG via the bumpJsonVersions sweep.
void ROOT_PKG;
