#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Enable GitHub's free repo-level secret scanning, push protection and
 * Dependabot alerts as config-as-code (issues #26, #105). These are repo
 * *settings*, not source files, so — like the branch-protection ruleset
 * (`apply-rulesets.ts`) — the supported path is this script, not a click in the
 * GitHub UI. That keeps the desired state reviewable and drift-checkable.
 *
 *   bun run security:enable    # turn on any managed setting that is off
 *   bun run security:check     # exit 1 if any managed setting is off
 *   bun run security:check -- --github-output     # also write step outputs (CI)
 *
 * Idempotent: a setting already on is skipped, so re-runs are no-ops.
 *
 * Exit codes of `--check`: 0 all on, 1 drift, 2 the token cannot read the
 * settings, 3 any other failure (network, GitHub 5xx). Code 2 is deliberately not "drift": GitHub omits
 * `security_and_analysis` for a token without repo-admin read, and treating
 * the missing block as "disabled" would report false drift (and treating it as
 * "enabled" a false pass).
 *
 * `--github-output` appends `drift=<setting,...>` and `reason=<code>` to
 * `$GITHUB_OUTPUT`. Both carry only names from `MANAGED_SETTINGS` and
 * `UNREADABLE_REASONS`, never text from the API, so the issue step builds its
 * body from fixed strings (`security-drift-issue.ts`).
 *
 * Auth: `SECURITY_SETTINGS_READ_TOKEN` when that variable is set (the
 * scheduled drift guard, `.github/workflows/security-drift.yml`), otherwise the
 * `gh` CLI's token. Reading needs repo-admin read (fine-grained PAT:
 * Administration read-only); enabling needs repo-admin write. The variable set
 * but empty means the Actions secret is missing, which fails loudly instead of
 * falling back to another token.
 *
 * Why push protection matters: it rejects a `git push` that contains a detected
 * secret pattern before it ever lands — the mechanical backstop for CLAUDE.md
 * §7 "secrets never in code", and the control that would have caught the PAT
 * leak called out in #26. Push protection requires secret scanning, so the
 * flags are applied secret-scanning-first.
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const CHECK = FLAGS.has("--check");

/**
 * The `security_and_analysis` flags this script manages, in apply order. Secret
 * scanning must be enabled before push protection (push protection depends on
 * it), so the array order is load-bearing for the apply loop.
 */
export const MANAGED_FLAGS = ["secret_scanning", "secret_scanning_push_protection"] as const;

/**
 * Every managed setting: the two `security_and_analysis` flags plus
 * Dependabot alerts, which GitHub exposes on its own endpoint
 * (`/vulnerability-alerts`). Dependabot alerts require the dependency graph,
 * so "alerts on" also proves the graph is on.
 */
export const MANAGED_SETTINGS = [...MANAGED_FLAGS, "dependabot_alerts"] as const;

/** One managed setting. */
export type ManagedSetting = (typeof MANAGED_SETTINGS)[number];

/**
 * Why the settings could not be read: the Actions secret is missing, or the
 * token lacks repo-admin read.
 */
export const UNREADABLE_REASONS = ["missing-secret", "no-admin-read"] as const;

/** One unreadable reason. */
export type UnreadableReason = (typeof UNREADABLE_REASONS)[number];

/** The `security_and_analysis` shape, with each flag carrying a `status`. */
export type SecurityAnalysis = Partial<Record<string, { status?: string } | null>>;

/** A single setting that needs to change from its current status to `enabled`. */
export type DriftEntry = { flag: ManagedSetting; from: string; to: "enabled" };

/** What the settings read returned: the flags block (absent when unreadable) and alerts. */
export type LiveSettings = {
  securityAndAnalysis: SecurityAnalysis | null | undefined;
  dependabotAlerts: "enabled" | "disabled";
};

/** Thrown when the token cannot see the settings at all (exit code 2). */
export class SettingsUnreadableError extends Error {
  constructor(
    readonly reason: UnreadableReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The desired end state: every managed setting `enabled`. Nothing outside this
 * set is touched.
 */
export function desiredState(): Record<ManagedSetting, { status: "enabled" }> {
  return {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
    dependabot_alerts: { status: "enabled" },
  };
}

/**
 * Compare the live settings against the desired state and return the managed
 * settings that are not `enabled`, in apply order. Flags outside
 * `MANAGED_FLAGS` (e.g. `dependabot_security_updates`) are ignored so this
 * script never disturbs settings it doesn't own.
 *
 * @throws SettingsUnreadableError when `security_and_analysis` is missing:
 *   GitHub leaves it out for a token without repo-admin read, so its absence
 *   says nothing about the settings themselves.
 */
export function computeDrift(live: LiveSettings): DriftEntry[] {
  const block = live.securityAndAnalysis;
  if (!block || typeof block !== "object") {
    throw new SettingsUnreadableError(
      "no-admin-read",
      "GitHub returned no security_and_analysis block: the token lacks repo-admin read. " +
        "Use a fine-grained PAT of a repo admin, scoped to this repository, with " +
        "Administration: read-only (see docs/dev/codeql.md, 'Drift guard').",
    );
  }
  const drift: DriftEntry[] = [];
  for (const flag of MANAGED_FLAGS) {
    const status = block[flag]?.status ?? "disabled";
    if (status !== "enabled") drift.push({ flag, from: status, to: "enabled" });
  }
  if (live.dependabotAlerts !== "enabled") {
    drift.push({ flag: "dependabot_alerts", from: live.dependabotAlerts, to: "enabled" });
  }
  return drift;
}

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function resolveToken(): Promise<string> {
  const fromEnv = process.env.SECURITY_SETTINGS_READ_TOKEN;
  if (fromEnv !== undefined) {
    if (fromEnv.trim() === "") {
      throw new SettingsUnreadableError(
        "missing-secret",
        "SECURITY_SETTINGS_READ_TOKEN is empty: the Actions secret of that name is not set " +
          "(see docs/dev/codeql.md, 'Drift guard').",
      );
    }
    return fromEnv.trim();
  }
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error("`gh auth token` failed — run `gh auth login` first.");
  }
  return out.trim();
}

function originSlug(): { owner: string; repo: string } {
  const owner = flagValue("owner");
  const repo = flagValue("repo");
  if (owner && repo) return { owner, repo };

  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  const url = new TextDecoder().decode(proc.stdout).trim();
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`Cannot parse owner/repo from origin URL: ${url}`);
  return { owner: m[1]!, repo: m[2]! };
}

async function request(
  token: string,
  method: "GET" | "PATCH" | "PUT",
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function failOnError(res: Response, method: string, path: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  const hint =
    res.status === 403 || res.status === 404
      ? "\nHint: this endpoint needs a token with repo-admin rights (Administration)."
      : "";
  throw new Error(`GitHub ${method} ${path} → ${res.status}\n${text}${hint}`);
}

async function readLive(token: string, slug: string): Promise<LiveSettings> {
  const repoPath = `/repos/${slug}`;
  const repoRes = await request(token, "GET", repoPath);
  await failOnError(repoRes, "GET", repoPath);
  const repo = (await repoRes.json()) as { security_and_analysis?: SecurityAnalysis };

  // 204 = on, 404 = off. A 404 is also what a token without Administration
  // read gets, but that case never reaches here: the missing
  // security_and_analysis block above already marks the token unreadable.
  const alertsPath = `${repoPath}/vulnerability-alerts`;
  const alertsRes = await request(token, "GET", alertsPath);
  if (alertsRes.status !== 204 && alertsRes.status !== 404) {
    await failOnError(alertsRes, "GET", alertsPath);
  }
  return {
    securityAndAnalysis: repo.security_and_analysis,
    dependabotAlerts: alertsRes.status === 204 ? "enabled" : "disabled",
  };
}

async function enable(token: string, slug: string, flag: ManagedSetting): Promise<void> {
  if (flag === "dependabot_alerts") {
    const path = `/repos/${slug}/vulnerability-alerts`;
    await failOnError(await request(token, "PUT", path), "PUT", path);
    return;
  }
  const path = `/repos/${slug}`;
  const res = await request(token, "PATCH", path, {
    security_and_analysis: { [flag]: { status: "enabled" } },
  });
  await failOnError(res, "PATCH", path);
}

async function main(): Promise<void> {
  const { owner, repo } = originSlug();
  const slug = `${owner}/${repo}`;
  // Step outputs for the issue step: setting names and reason codes only.
  const output = (key: "drift" | "reason", value: string) => {
    const file = process.env.GITHUB_OUTPUT;
    if (FLAGS.has("--github-output") && file) appendFileSync(file, `${key}=${value}\n`);
  };

  let drift: DriftEntry[];
  try {
    const token = await resolveToken();
    drift = computeDrift(await readLive(token, slug));
    if (!CHECK && drift.length > 0) {
      // Apply in MANAGED_FLAGS order: push protection depends on secret
      // scanning, so a one-shot PATCH could race; sequential is safe.
      for (const d of drift) {
        await enable(token, slug, d.flag);
        console.log(`enabled: ${d.flag} on ${slug}`);
      }
      return;
    }
  } catch (e) {
    if (e instanceof SettingsUnreadableError) {
      console.error(`unreadable: ${e.message}`);
      output("reason", e.reason);
      process.exit(2);
    }
    throw e;
  }

  if (drift.length === 0) {
    console.log(`ok:    secret scanning, push protection and Dependabot alerts are on for ${slug}`);
    return;
  }
  for (const d of drift) {
    console.error(`drift: ${d.flag} is "${d.from}", want "enabled" on ${slug}`);
  }
  output("drift", drift.map((d) => d.flag).join(","));
  process.exit(1);
}

// Only run when invoked directly, so the exported helpers can be imported by
// the test suite without triggering a live API call.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(3);
  });
}
