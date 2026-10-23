// SPDX-License-Identifier: MPL-2.0

/**
 * Release-cut checks shared by `scripts/release.ts` (before the bump) and
 * `release.yml` (before the manifest is signed) — epic #696.
 *
 * The facts the signed manifest asserts are decided at release-cut time
 * and committed in `release-meta.json` with the release commit, so the
 * tag-triggered pipeline (which has no workflow inputs) signs exactly what
 * the maintainer declared. Both ends run the same checks: a release PR
 * edited after the cut still cannot sign a `security` flag without a
 * published advisory, or skip an infra-contract bump.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { INFRA_CONTRACT_VERSION } from "../packages/provisioning/src/infra-contract.ts";
import { isInfraContractPath } from "../packages/provisioning/src/release-contract.ts";
import { compareSemver } from "../packages/provisioning/src/release-manifest.ts";
import { OWNER_ACTION_MAX_CHARS } from "../packages/shared/src/release-manifest.ts";
import {
  formatFindings,
  lintMigrationsSince,
  outOfOrderMigrationsSince,
} from "./migration-lint.ts";

/** Repo-relative path of the release-cut declaration. */
export const RELEASE_META_PATH = "release-meta.json";

const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/** What the maintainer declared when cutting the release. */
export const ReleaseMetaSchema = z.strictObject({
  version: z.string(),
  security: z.boolean(),
  advisories: z.array(z.string()),
  /** The release carries contract migrations and the maintainer accepts that. */
  acknowledgeContractMigrations: z.boolean(),
  /** Infra-contract files changed but the maintainer confirmed no IAM/secret/resource change. */
  acknowledgeInfraNeutral: z.boolean(),
  /**
   * Newest release (up to this one) with contract migrations — carried
   * forward release to release; see {@link expectedLastContractVersion}.
   */
  lastContractVersion: z.string().nullable(),
  /**
   * #868 — what the Owner has to do for this release's breaking change, in
   * one sentence; signed into the manifest as `ownerAction` and shown in
   * Settings → Updates. Required when a commit since the previous release
   * is breaking (`type!:`), refused otherwise (it would never be shown).
   */
  ownerAction: z.string().nullable(),
});
export type ReleaseMeta = z.infer<typeof ReleaseMetaSchema>;

/** Read and schema-check `release-meta.json`. */
export function readReleaseMeta(repoRoot: string): ReleaseMeta {
  const raw = readFileSync(resolve(repoRoot, RELEASE_META_PATH), "utf8");
  return ReleaseMetaSchema.parse(JSON.parse(raw));
}

/** Write `release-meta.json` (stable key order, trailing newline). */
export function writeReleaseMeta(repoRoot: string, meta: ReleaseMeta): void {
  writeFileSync(resolve(repoRoot, RELEASE_META_PATH), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Split a comma list of advisory ids (the release-cut input).
 *
 * @returns trimmed, de-duplicated ids; empty for an empty input.
 */
export function parseAdvisoryList(input: string): string[] {
  return [
    ...new Set(
      input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Static consistency of the declaration (no network). */
export function validateReleaseMetaShape(meta: ReleaseMeta): string[] {
  const errors: string[] = [];
  if (meta.security && meta.advisories.length === 0) {
    errors.push(
      "security=true needs at least one advisory: publish a GitHub Security Advisory for the fix and pass its GHSA id.",
    );
  }
  if (!meta.security && meta.advisories.length > 0) {
    errors.push("advisories were given but security=false — set security=true or drop them.");
  }
  for (const id of meta.advisories) {
    if (!GHSA_ID.test(id)) errors.push(`"${id}" is not a GHSA id (GHSA-xxxx-xxxx-xxxx).`);
  }
  if (meta.ownerAction !== null) {
    const action = meta.ownerAction;
    if (action.trim() !== action || action.length === 0 || /[\r\n]/.test(action)) {
      errors.push(
        "owner_action must be one sentence on one line, without leading or trailing spaces.",
      );
    } else if (action.length > OWNER_ACTION_MAX_CHARS) {
      errors.push(
        `owner_action is ${action.length} characters; keep it to one sentence of at most ${OWNER_ACTION_MAX_CHARS}.`,
      );
    }
  }
  return errors;
}

/**
 * A breaking conventional-commit subject (`feat(x)!: …`) — what
 * scripts/release.ts marks `⚠ BREAKING` in the release notes and the
 * Owner's page turns into "Before you update".
 */
export const BREAKING_SUBJECT = /^\w+(?:\([^)]*\))?!:/;

/**
 * Subjects of the breaking commits between `ref` and HEAD (every commit up
 * to HEAD when `ref` is null), merges excluded like the changelog.
 */
export function breakingCommitsSince(ref: string | null, repoRoot: string): string[] {
  const log = git(
    ["log", ref ? `${ref}..HEAD` : "HEAD", "--no-merges", "--pretty=format:%s"],
    repoRoot,
  );
  if (!log.ok) {
    throw new Error(`git log ${ref ?? ""}..HEAD failed — is the tag fetched (fetch-depth: 0)?`);
  }
  return log.out.split("\n").filter((subject) => BREAKING_SUBJECT.test(subject));
}

/**
 * The ownerAction rule (#868): a release with a breaking commit names what
 * the Owner has to do (or that nothing is: "Nothing to do — Caelo handles
 * this during the update."), and one without a breaking commit names
 * nothing, since the Owner's page shows the sentence only for a breaking
 * release. No silent default either way.
 */
export function checkOwnerAction(opts: {
  breakingSubjects: readonly string[];
  ownerAction: string | null;
}): string | null {
  if (opts.breakingSubjects.length > 0 && opts.ownerAction === null) {
    return (
      `breaking commits since the previous release, but no owner_action:\n  ${opts.breakingSubjects.join("\n  ")}\n` +
      'Say in one sentence what the Owner has to do before or after installing it (release-cut input owner_action / --owner-action "…"). ' +
      'If Caelo applies it during the update, say so: "Nothing to do — Caelo handles this during the update."'
    );
  }
  if (opts.breakingSubjects.length === 0 && opts.ownerAction !== null) {
    return "owner_action was given, but no commit since the previous release is breaking (type!:), so Settings → Updates would never show it. Drop it, or mark the breaking commit.";
  }
  return null;
}

/** Fetch for the GitHub API; injectable for tests. */
export type AdvisoryFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Check every id resolves to a PUBLISHED repository security advisory of
 * `repo` (the equivalent of `gh api repos/{repo}/security-advisories/<id>`).
 * Drafts, triage and closed advisories do not count.
 *
 * @returns one error per advisory that does not qualify.
 */
export async function verifyAdvisoriesPublished(
  ids: readonly string[],
  opts: { repo: string; token?: string; fetch?: AdvisoryFetch },
): Promise<string[]> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const errors: string[] = [];
  for (const id of ids) {
    const res = await doFetch(
      `https://api.github.com/repos/${opts.repo}/security-advisories/${id}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
      },
    );
    if (!res.ok) {
      errors.push(
        `${id}: not found as a security advisory of ${opts.repo} (HTTP ${res.status}). Publish it under Security → Advisories first.`,
      );
      continue;
    }
    const body = (await res.json()) as { state?: string; ghsa_id?: string };
    if (body.ghsa_id !== id) {
      errors.push(`${id}: the API returned ${body.ghsa_id ?? "no id"}.`);
    } else if (body.state !== "published") {
      errors.push(`${id}: advisory is "${body.state ?? "unknown"}", must be "published".`);
    }
  }
  return errors;
}

function git(args: readonly string[], cwd: string): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout) };
}

/** Every `vX.Y.Z[-pre]` tag in the repo, without the `v`. */
export function readTags(repoRoot: string): string[] {
  return git(["tag", "--list", "v*"], repoRoot)
    .out.split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t))
    .map((t) => t.slice(1));
}

/**
 * The newest STABLE tag strictly older than `current` (or the newest
 * stable tag at all when `current` is null), as `vX.Y.Z`.
 *
 * Stable, not "previous of any kind": an install on the last stable jumps
 * straight to this release, so the comparison base must be what it runs.
 */
export function previousStableTag(
  versions: readonly string[],
  current: string | null,
): string | null {
  const candidates = versions
    .filter((v) => !v.includes("-"))
    .filter((v) => current === null || compareSemver(v, current) < 0)
    .sort(compareSemver);
  const last = candidates.at(-1);
  return last ? `v${last}` : null;
}

/** Where INFRA_CONTRACT_VERSION lives (shared with the upgrade split's `needsConverge`). */
export const INFRA_CONTRACT_FILE = "packages/provisioning/src/infra-contract.ts";

/** `INFRA_CONTRACT_VERSION` as committed at `ref`; null when the constant did not exist yet. */
export function infraContractVersionAt(ref: string, repoRoot: string): number | null {
  const show = git(["show", `${ref}:${INFRA_CONTRACT_FILE}`], repoRoot);
  if (!show.ok) return null;
  const m = /export const INFRA_CONTRACT_VERSION = (\d+);/.exec(show.out);
  return m ? Number(m[1]) : null;
}

/**
 * Newest release with contract migrations before release-meta.json
 * existed: v0.10.42 (0259_drop_core_ab_testing). Used when the previous
 * tag predates the file, so the carry-forward chain starts correct.
 */
export const LAST_CONTRACT_BEFORE_MANIFESTS = "0.10.42";

/**
 * `lastContractVersion` from `release-meta.json` at `ref`; undefined when
 * the file or the field did not exist there yet.
 */
export function lastContractVersionAt(ref: string, repoRoot: string): string | null | undefined {
  const show = git(["show", `${ref}:${RELEASE_META_PATH}`], repoRoot);
  if (!show.ok) return undefined;
  const parsed = z
    .object({ lastContractVersion: z.string().nullable().optional() })
    .safeParse(JSON.parse(show.out));
  return parsed.success ? parsed.data.lastContractVersion : undefined;
}

/**
 * The `lastContractVersion` this release must declare: itself when it
 * carries contract migrations, else whatever the previous release
 * declared (carried forward), so an install that skips a contract
 * release is still caught.
 *
 * @param previous - the previous tag's value; undefined = tag predates it.
 */
export function expectedLastContractVersion(opts: {
  version: string;
  contractMigrations: boolean;
  previousTag: string | null;
  previous: string | null | undefined;
}): string | null {
  if (opts.contractMigrations) return opts.version;
  if (opts.previousTag === null) return null;
  return opts.previous === undefined ? LAST_CONTRACT_BEFORE_MANIFESTS : opts.previous;
}

/** Outcome of {@link checkInfraContract}. */
export interface InfraContractCheck {
  readonly ok: boolean;
  readonly changedPaths: readonly string[];
  readonly message: string;
}

/**
 * The infra-contract rule: when infra-contract files changed since the
 * previous release, INFRA_CONTRACT_VERSION must have been bumped — or the
 * cut must record the change as infra-neutral. A decrease is always wrong.
 *
 * @param previous - the constant at the previous tag (null = no baseline yet).
 */
export function checkInfraContract(opts: {
  changedPaths: readonly string[];
  previous: number | null;
  current: number;
  acknowledgeInfraNeutral: boolean;
}): InfraContractCheck {
  const changedPaths = opts.changedPaths.filter(isInfraContractPath);
  if (opts.previous === null) {
    return {
      ok: true,
      changedPaths,
      message: "no previous infra contract to compare (first manifest)",
    };
  }
  if (opts.current < opts.previous) {
    return {
      ok: false,
      changedPaths,
      message: `INFRA_CONTRACT_VERSION went down (${opts.previous} → ${opts.current}); it only ever increases.`,
    };
  }
  if (opts.current > opts.previous) {
    return {
      ok: true,
      changedPaths,
      message: `infra contract bumped ${opts.previous} → ${opts.current}`,
    };
  }
  if (changedPaths.length === 0) {
    return { ok: true, changedPaths, message: "no infra-contract files changed" };
  }
  if (opts.acknowledgeInfraNeutral) {
    return {
      ok: true,
      changedPaths,
      message: `infra-contract files changed, recorded as infra-neutral at release cut: ${changedPaths.join(", ")}`,
    };
  }
  return {
    ok: false,
    changedPaths,
    message:
      `infra-contract files changed since the previous release without an INFRA_CONTRACT_VERSION bump:\n  ${changedPaths.join("\n  ")}\n` +
      "If any of them adds/removes/changes IAM, secrets, service accounts or cloud resources, bump INFRA_CONTRACT_VERSION in packages/provisioning/src/infra-contract.ts (installs then upgrade via Cloud Shell). " +
      "If none does, re-cut with the infra-neutral acknowledgement (release-cut input ack_infra_neutral / --ack-infra-neutral).",
  };
}

/** Repo-relative paths changed between `ref` and HEAD. */
export function changedPathsSince(ref: string, repoRoot: string): string[] {
  const diff = git(["diff", "--name-only", `${ref}..HEAD`], repoRoot);
  if (!diff.ok)
    throw new Error(`git diff ${ref}..HEAD failed — is the tag fetched (fetch-depth: 0)?`);
  return diff.out.split("\n").filter(Boolean);
}

/** Everything the release checks decided, for the manifest + logs. */
export interface ReleaseCheckResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly previousTag: string | null;
  readonly contractMigrations: boolean;
  /** What `meta.lastContractVersion` must be (see {@link expectedLastContractVersion}). */
  readonly lastContractVersion: string | null;
}

/**
 * Run every release-cut rule against HEAD for the declared `meta`.
 * Network: only the advisory lookup (skipped when there are none).
 */
export async function runReleaseChecks(
  meta: ReleaseMeta,
  opts: { repoRoot: string; repo: string; token?: string; fetch?: AdvisoryFetch },
): Promise<ReleaseCheckResult> {
  const errors = validateReleaseMetaShape(meta);
  const warnings: string[] = [];
  const previousTag = previousStableTag(readTags(opts.repoRoot), meta.version);

  const findings = lintMigrationsSince(previousTag, opts.repoRoot);
  const contractMigrations = findings.length > 0;
  if (contractMigrations && !meta.acknowledgeContractMigrations) {
    errors.push(
      `contract (destructive) migrations since ${previousTag}:\n${formatFindings(findings)}\n` +
        "Installs cannot take this release unattended. If that is intended, re-cut with the contract acknowledgement (release-cut input ack_contract_migrations / --ack-contract-migrations); otherwise move the destructive step to a later release (expand/contract).",
    );
  }

  // A migration numbered below one the previous release shipped would run
  // after it on upgraded installs but before it on fresh ones.
  for (const { file, head } of outOfOrderMigrationsSince(previousTag, opts.repoRoot)) {
    errors.push(
      `migration ${file} sorts below ${head}, which ${previousTag} already shipped: upgraded installs would apply it after ${head}, fresh installs before. Renumber it above ${head}.`,
    );
  }

  const infra = previousTag
    ? checkInfraContract({
        changedPaths: changedPathsSince(previousTag, opts.repoRoot),
        previous: infraContractVersionAt(previousTag, opts.repoRoot),
        current: INFRA_CONTRACT_VERSION,
        acknowledgeInfraNeutral: meta.acknowledgeInfraNeutral,
      })
    : { ok: true, changedPaths: [], message: "no previous stable tag" };
  if (!infra.ok) errors.push(infra.message);
  const infraBumped =
    previousTag !== null &&
    (infraContractVersionAt(previousTag, opts.repoRoot) ?? INFRA_CONTRACT_VERSION) <
      INFRA_CONTRACT_VERSION;

  const ownerAction = checkOwnerAction({
    breakingSubjects: breakingCommitsSince(previousTag, opts.repoRoot),
    ownerAction: meta.ownerAction,
  });
  if (ownerAction) errors.push(ownerAction);

  if (meta.advisories.length > 0) {
    errors.push(...(await verifyAdvisoriesPublished(meta.advisories, opts)));
  }
  if (meta.security && (contractMigrations || infraBumped)) {
    warnings.push(
      "security release with contract migrations or an infra contract bump: the manifest says security=true, but upgraders treat it as MANUAL (never auto-installed).",
    );
  }
  const lastContractVersion = expectedLastContractVersion({
    version: meta.version,
    contractMigrations,
    previousTag,
    previous: previousTag ? lastContractVersionAt(previousTag, opts.repoRoot) : null,
  });
  return { errors, warnings, previousTag, contractMigrations, lastContractVersion };
}

/**
 * Sets the top-level `"version"` of a JSON manifest by editing the text, so
 * the file keeps the layout the repo's formatter gave it. Re-serialising with
 * `JSON.stringify(…, null, 2)` breaks short arrays onto one line per item,
 * which Biome rejects; that failed the v0.10.65 release gate's lint on the
 * Claude Code plugin manifest.
 *
 * @throws when the text has no `"version"` field to replace.
 */
export function setJsonVersionField(text: string, version: string): string {
  const pattern = /^(\s*"version":\s*)"[^"]*"/m;
  if (!pattern.test(text)) throw new Error('manifest has no "version" field to bump');
  return text.replace(pattern, `$1"${version}"`);
}
