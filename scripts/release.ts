#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * P17.0 — Caelo release pipeline.
 *
 *   bun run scripts/release.ts <new-version> [--dry-run]
 *
 * Release stamps exist only on the release commit. Main carries the
 * unreleased marker (version 0.0.0, no CHANGELOG.md, no release-meta.json)
 * and never receives the release commit back: the current version is the
 * newest stable tag, and install surfaces name no version at all.
 *
 * What it does:
 *   1. Validates the new version is SemVer + strictly greater than the
 *      newest stable tag (and above every existing tag).
 *   2. Updates packages/shared/src/version.ts CAELO_VERSION.
 *   3. Updates root package.json + every workspace package.json `version`,
 *      bun.lock, which records those versions, the MCP Registry entry
 *      (packages/mcp-server/server.json) and the Power-MCP catalogue
 *      snapshot (packages/mcp-server/power-catalogue.json), both #841,
 *      and the Claude Code plugin (integrations/claude-code: plugin.json
 *      version + the mcp-server release its .mcp.json starts).
 *   4. Re-signs every Tier-1 plugin manifest under packages/plugins/<slug>/
 *      via apps/admin/scripts/sign-tier1-manifest.ts (the same script
 *      `bun run plugins:sign` uses).
 *   5. Generates the changelog stanza from conventional commits since the
 *      previous tag and prepends it to that tag's CHANGELOG.md, so the file
 *      on each tag is the full history.
 *   6. Commits the changes (`chore(release): vX.Y.Z`).
 *   7. Tags `vX.Y.Z`.
 *
 * Release-manifest declaration (epic #696) — checked BEFORE anything is
 * bumped, then written to release-meta.json in the release commit so the
 * tag pipeline signs exactly this:
 *   --security                     security release (needs --advisories)
 *   --advisories GHSA-…,GHSA-…     published GitHub Security Advisories
 *   --ack-contract-migrations      accept destructive migrations since the
 *                                  previous stable tag (manual-install release)
 *   --ack-infra-neutral            infra-contract files changed but nothing
 *                                  IAM/secret/resource-relevant (no bump)
 *   --owner-action "<sentence>"    what the Owner has to do for the
 *                                  release's breaking change (required when
 *                                  a commit since the previous release is
 *                                  `type!:`, refused otherwise; #868)
 *   --checks-only                  run those checks and exit, changing nothing
 * See scripts/release-checks.ts for the rules.
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
import { writePowerCatalogue } from "./power-catalogue.ts";
import {
  parseAdvisoryList,
  previousStableTag,
  previousTag,
  RELEASE_COMMIT_SUBJECT,
  RELEASE_META_PATH,
  type ReleaseMeta,
  readReleaseMeta,
  readTags,
  runReleaseChecks,
  setJsonVersionField,
  taggedAheadProblem,
  UNRELEASED_VERSION,
  writeReleaseMeta,
} from "./release-checks.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const VERSION_FILE = resolve(REPO_ROOT, "packages/shared/src/version.ts");
const ROOT_PKG = resolve(REPO_ROOT, "package.json");
/**
 * #841 — the official MCP Registry entry. release.yml publishes it after
 * npm; the registry checks its npm package version exists, so it moves
 * in lockstep like every package.json.
 */
const MCP_SERVER_JSON = resolve(REPO_ROOT, "packages/mcp-server/server.json");

/**
 * The Claude Code plugin (integrations/claude-code). Its `.mcp.json` pins
 * the exact mcp-server release (the plugin directory refuses `@latest`);
 * the shim still re-execs as the admin's release at startup (#764), so
 * the pin only decides which release bootstraps. Bumped with every
 * release so `claude plugin update` sees a new version.
 */
const CLAUDE_PLUGIN_JSON = resolve(
  REPO_ROOT,
  "integrations/claude-code/.claude-plugin/plugin.json",
);
const CLAUDE_PLUGIN_MCP_JSON = resolve(REPO_ROOT, "integrations/claude-code/.mcp.json");
const PLUGIN_MCP_PIN = /@caelo-cms\/mcp-server@[^"]+"/g;

interface McpServerJson {
  version: string;
  packages: Array<{ version: string }>;
}

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Value of `--name <v>` or `--name=<v>`. */
function argValue(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Build the release-manifest declaration from the flags and run every
 * release-cut check against HEAD. Exits before anything is written when a
 * rule fails, so a refused cut leaves the tree untouched.
 */
async function declareRelease(newVersion: string): Promise<ReleaseMeta> {
  const meta: ReleaseMeta = {
    version: newVersion,
    security: arg("security"),
    advisories: parseAdvisoryList(argValue("advisories") ?? ""),
    acknowledgeContractMigrations: arg("ack-contract-migrations"),
    acknowledgeInfraNeutral: arg("ack-infra-neutral"),
    // Derived by the checks below (carry-forward), never a flag.
    lastContractVersion: null,
    // #868 — checked below: required exactly when a commit is breaking.
    ownerAction: argValue("owner-action") ?? null,
  };
  const checks = await runReleaseChecks(meta, {
    repoRoot: REPO_ROOT,
    repo: process.env.GITHUB_REPOSITORY ?? "caelo-cms/caelo-cms",
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  });
  for (const w of checks.warnings) console.warn(`! ${w}`);
  if (checks.errors.length > 0) {
    console.error(`release refused (compared against ${checks.previousTag ?? "no previous tag"}):`);
    for (const e of checks.errors) console.error(`  ✗ ${e}`);
    process.exit(2);
  }
  console.log(
    `✓ release checks passed (security=${meta.security}, contract migrations=${checks.contractMigrations})`,
  );
  return { ...meta, lastContractVersion: checks.lastContractVersion };
}

/** The version stamped into this checkout (0.0.0 on main, vX.Y.Z on a release commit). */
function getStamped(): string {
  const src = readFileSync(VERSION_FILE, "utf8");
  const m = /CAELO_VERSION = "([^"]+)"/.exec(src);
  if (!m) throw new Error("CAELO_VERSION not found in version.ts");
  return m[1] as string;
}

/**
 * The version a bump starts from: the newest stable tag. Main never learns
 * the released version (no merge-back), so its stamp cannot be the base.
 */
function getCurrent(tags: readonly string[]): string {
  const prev = previousStableTag(tags, null);
  if (!prev) {
    throw new Error(
      "no stable vX.Y.Z tag found — fetch the tags (git fetch --tags, or fetch-depth: 0 in CI) or cut an explicit version",
    );
  }
  return prev.slice(1);
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
    // Read directly and skip on failure rather than existsSync-then-read:
    // the gap between the check and the read is a TOCTOU race (CodeQL
    // js/file-system-race).
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version && pkg.version !== newVersion) {
      pkg.version = newVersion;
      if (!dryRun) writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
      changedPaths.push(p);
    }
  }
  return changedPaths;
}

function bumpMcpServerJson(newVersion: string, dryRun: boolean): void {
  const entry = JSON.parse(readFileSync(MCP_SERVER_JSON, "utf8")) as McpServerJson;
  entry.version = newVersion;
  for (const pkg of entry.packages) pkg.version = newVersion;
  if (!dryRun) writeFileSync(MCP_SERVER_JSON, `${JSON.stringify(entry, null, 2)}\n`);
}

function bumpClaudePlugin(newVersion: string, dryRun: boolean): void {
  const manifest = setJsonVersionField(readFileSync(CLAUDE_PLUGIN_JSON, "utf8"), newVersion);
  const mcp = readFileSync(CLAUDE_PLUGIN_MCP_JSON, "utf8");
  const nextMcp = mcp.replace(PLUGIN_MCP_PIN, `@caelo-cms/mcp-server@${newVersion}"`);
  if (nextMcp === mcp && !mcp.includes(`@caelo-cms/mcp-server@${newVersion}"`)) {
    throw new Error("integrations/claude-code/.mcp.json has no @caelo-cms/mcp-server pin to bump");
  }
  if (dryRun) return;
  writeFileSync(CLAUDE_PLUGIN_JSON, manifest);
  writeFileSync(CLAUDE_PLUGIN_MCP_JSON, nextMcp);
}

/** The plugin's manifest version and every mcp-server pin in its .mcp.json, with their files. */
function claudePluginVersions(): { file: string; v: string }[] {
  const manifest = JSON.parse(readFileSync(CLAUDE_PLUGIN_JSON, "utf8")) as { version: string };
  const mcp = readFileSync(CLAUDE_PLUGIN_MCP_JSON, "utf8");
  return [
    { file: CLAUDE_PLUGIN_JSON, v: manifest.version },
    ...[...mcp.matchAll(PLUGIN_MCP_PIN)].map((m) => ({
      file: CLAUDE_PLUGIN_MCP_JSON,
      v: m[0].slice("@caelo-cms/mcp-server@".length, -1),
    })),
  ];
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
  // Pre-check that a signing key is reachable. Maintainers running the
  // release script need EITHER a local `.caelo-dev-key` (default dev
  // pair) OR `CAELO_TIER1_PRIVATE_KEY` set (production release flow).
  // Without one the sign script aborts with a confusing stack; surface
  // the actionable hint up-front.
  const devKeyPath = resolve(REPO_ROOT, ".caelo-dev-key");
  if (!existsSync(devKeyPath) && !process.env.CAELO_TIER1_PRIVATE_KEY) {
    throw new Error(
      "no signing key found.\n" +
        "  • For dev releases: run `bun apps/admin/scripts/sign-tier1-manifest.ts --new-key` " +
        "to mint a local pair, then re-run.\n" +
        "  • For production releases: export CAELO_TIER1_PRIVATE_KEY=<hex> from your secrets " +
        "manager before running.",
    );
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

/**
 * bun.lock records every workspace's version, so the bump has to reach it
 * in the same commit — otherwise CI's lockfile-freshness check fails on
 * the release commit (v0.10.25 shipped without this step).
 */
function refreshLockfile(dryRun: boolean): void {
  if (dryRun) {
    console.log("[dry-run] would run: bun install --lockfile-only");
    return;
  }
  const proc = Bun.spawnSync(["bun", "install", "--lockfile-only"], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error("bun install --lockfile-only failed");
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
  // Main carries neither file; the release commit adds both.
  Bun.spawnSync(["git", "add", RELEASE_META_PATH, "CHANGELOG.md"], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
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
  const entry = JSON.parse(readFileSync(MCP_SERVER_JSON, "utf8")) as McpServerJson;
  for (const v of [entry.version, ...entry.packages.map((pkg) => pkg.version)]) {
    if (v !== target) mismatches.push({ file: MCP_SERVER_JSON, v });
  }
  for (const pin of claudePluginVersions()) {
    if (pin.v !== target) mismatches.push(pin);
  }
  return { ok: mismatches.length === 0, mismatches };
}

function generateChangelog(prevTag: string | null, newVersion: string): string {
  const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
  const proc = Bun.spawnSync(["git", "log", range, "--pretty=format:%h %s", "--no-merges"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
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
    if (RELEASE_COMMIT_SUBJECT.test(line.slice(line.indexOf(" ") + 1))) continue;
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
        "      [--security --advisories GHSA-…,…] [--ack-contract-migrations] [--ack-infra-neutral]\n" +
        '      [--owner-action "<what the Owner does for the breaking change>"]\n' +
        "      [--checks-only]   # run the release-cut checks, change nothing\n" +
        "  bun run scripts/release.ts --check     # verify lockstep, no bump",
    );
    process.exit(2);
  }
  if (arg0 === "--check") {
    const target = getStamped();
    const result = checkLockstep(target);
    // The tag pipeline signs release-meta.json's declaration; one left
    // over from another version means the commit did not come from this
    // script. Main (the unreleased marker) carries none.
    if (target !== UNRELEASED_VERSION) {
      const metaVersion = readReleaseMeta(REPO_ROOT).version;
      if (metaVersion !== target) {
        console.error(`✗ ${RELEASE_META_PATH} declares v${metaVersion}, expected v${target}`);
        process.exit(1);
      }
    }
    if (result.ok) {
      console.log(`✓ all packages at v${target}`);
      process.exit(0);
    }
    console.error(`✗ ${result.mismatches.length} package(s) drift from v${target}:`);
    for (const m of result.mismatches) console.error(`  ${m.file}: ${m.v}`);
    process.exit(1);
  }
  const dryRun = arg("dry-run");
  // Release commits are cut from main's unreleased stamps; a checkout that
  // already carries a release (a release branch, an old main) would stack
  // a second release commit on top of the first.
  const stamped = getStamped();
  if (stamped !== UNRELEASED_VERSION) {
    console.error(
      `release refused: this checkout is stamped v${stamped}, not the unreleased marker v${UNRELEASED_VERSION}. Cut from main.`,
    );
    process.exit(2);
  }
  const tags = readTags(REPO_ROOT);
  const current = getCurrent(tags);
  const newVersion = ["patch", "minor", "major"].includes(arg0)
    ? bumpKind(current, arg0 as "patch" | "minor" | "major")
    : arg0;
  if (!semverGt(newVersion, current)) {
    console.error(`new version ${newVersion} must be strictly greater than current ${current}`);
    process.exit(2);
  }
  console.log(`Caelo release: ${current} → ${newVersion}${dryRun ? " (dry-run)" : ""}`);
  const ahead = taggedAheadProblem(tags, newVersion);
  if (ahead) {
    console.error(`release refused: ${ahead}`);
    process.exit(2);
  }

  const meta = await declareRelease(newVersion);
  // release-cut.yml validates the declaration before its (slow, paid)
  // real-AI gate; nothing is written in this mode.
  if (arg("checks-only")) return;
  if (dryRun) console.log(`[dry-run] ${RELEASE_META_PATH} would be: ${JSON.stringify(meta)}`);
  else writeReleaseMeta(REPO_ROOT, meta);

  bumpVersionFile(newVersion, dryRun);
  console.log(`✓ packages/shared/src/version.ts updated`);

  const changed = bumpJsonVersions(newVersion, dryRun);
  console.log(`✓ ${changed.length} package.json files updated`);

  bumpMcpServerJson(newVersion, dryRun);
  console.log(`✓ packages/mcp-server/server.json updated`);

  bumpClaudePlugin(newVersion, dryRun);
  console.log(`✓ integrations/claude-code plugin version + mcp-server pin updated`);

  writePowerCatalogue(newVersion, dryRun);
  console.log(`✓ packages/mcp-server/power-catalogue.json regenerated`);

  refreshLockfile(dryRun);
  console.log(`✓ bun.lock updated`);

  await resignManifests(dryRun);
  console.log(`✓ Tier-1 manifests resigned`);

  // Generate the changelog stanza from conventional commits since the
  // previous tag and prepend it to THAT tag's CHANGELOG.md: the file lives
  // on release commits only (main has none), so each tag carries the whole
  // history and the previous one is the base.
  const prevTag = previousTag(tags, newVersion);
  const stanza = generateChangelog(prevTag, newVersion);
  const changelogPath = resolve(REPO_ROOT, "CHANGELOG.md");
  const HEADER = "# Changelog\n\n";
  if (!dryRun) {
    const prior = (prevTag ? gitShow(`${prevTag}:CHANGELOG.md`) : null) ?? HEADER;
    const body = prior.startsWith(HEADER) ? prior.slice(HEADER.length) : prior;
    writeFileSync(changelogPath, `${HEADER}${stanza}\n${body}`);
    console.log(`✓ CHANGELOG.md ${prevTag ? `appended commits since ${prevTag}` : "initialised"}`);
  } else {
    console.log(`[dry-run] changelog stanza would prepend:\n${stanza}`);
  }

  maybeGitCommitTag(newVersion, dryRun);
  console.log(`\nNext: git push origin v${newVersion}`);
  console.log(`Then release.yml gates and publishes the release (RELEASING.md).`);
}

/** `git show <ref:path>`, or null when the file is not there. */
function gitShow(spec: string): string | null {
  const proc = Bun.spawnSync(["git", "show", spec], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout) : null;
}

await main();

// Touch ROOT_PKG via the bumpJsonVersions sweep.
void ROOT_PKG;
