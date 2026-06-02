#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Enable GitHub's free repo-level secret scanning + push protection as
 * config-as-code (issue #26). These are repo *settings*, not source files, so
 * — like the branch-protection ruleset (`apply-rulesets.ts`) — the supported
 * path is this script run by a maintainer, not a click in the GitHub UI. That
 * keeps the desired state reviewable and drift-checkable.
 *
 *   bun run security:enable    # PATCH any flag not yet `enabled`
 *   bun run security:check     # exit 1 if any managed flag drifts from desired
 *
 * Idempotent: a flag already `enabled` is skipped, so re-runs are no-ops.
 *
 * Auth: reuses the `gh` CLI's token (`gh auth token`). Enabling these settings
 * requires a token with **repo-admin** scope; a non-admin token gets a 403 from
 * the PATCH, surfaced as a clear error. Owner + repo come from the `origin`
 * remote unless overridden via `--owner` / `--repo`.
 *
 * Why push protection matters: it rejects a `git push` that contains a detected
 * secret pattern before it ever lands — the mechanical backstop for CLAUDE.md
 * §7 "secrets never in code", and the control that would have caught the PAT
 * leak called out in #26. Push protection requires secret scanning, so the two
 * managed flags are applied secret-scanning-first.
 */

import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const CHECK = FLAGS.has("--check");

/**
 * The repo security flags this script manages, in apply order. Secret scanning
 * must be enabled before push protection (push protection depends on it), so
 * the array order is load-bearing for the apply loop.
 */
export const MANAGED_FLAGS = ["secret_scanning", "secret_scanning_push_protection"] as const;

export type ManagedFlag = (typeof MANAGED_FLAGS)[number];

/** The `security_and_analysis` shape, with each flag carrying a `status`. */
export type SecurityAnalysis = Partial<Record<string, { status?: string } | null>>;

/** A single flag that needs to change from its current status to `enabled`. */
export type DriftEntry = { flag: ManagedFlag; from: string; to: "enabled" };

/**
 * The desired end state: every managed flag `enabled`. This is exactly the set
 * of flags AC#2 (issue #26) requires on — nothing else is touched.
 */
export function desiredState(): Record<ManagedFlag, { status: "enabled" }> {
  return {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  };
}

/**
 * Compare the repo's current `security_and_analysis` against the desired state
 * and return the managed flags that are not yet `enabled`, in apply order.
 * Flags outside `MANAGED_FLAGS` (e.g. `dependabot_security_updates`) are
 * ignored so this script never disturbs settings it doesn't own.
 */
export function computeDrift(current: SecurityAnalysis | null | undefined): DriftEntry[] {
  const drift: DriftEntry[] = [];
  for (const flag of MANAGED_FLAGS) {
    const status = current?.[flag]?.status ?? "disabled";
    if (status !== "enabled") drift.push({ flag, from: status, to: "enabled" });
  }
  return drift;
}

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function ghToken(): Promise<string> {
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

async function api<T>(
  token: string,
  method: "GET" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const hint =
      res.status === 403
        ? "\nHint: enabling these settings needs a token with repo-admin scope."
        : "";
    throw new Error(`GitHub ${method} ${path} → ${res.status}\n${text}${hint}`);
  }
  // PATCH returns the full repo object; GET likewise. Callers pick fields off it.
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const { owner, repo } = originSlug();
  const token = await ghToken();

  const live = await api<{ security_and_analysis?: SecurityAnalysis }>(
    token,
    "GET",
    `/repos/${owner}/${repo}`,
  );
  const drift = computeDrift(live.security_and_analysis);

  if (CHECK) {
    if (drift.length === 0) {
      console.log(`ok:    secret scanning + push protection enabled on ${owner}/${repo}`);
      return;
    }
    for (const d of drift) {
      console.error(`drift: ${d.flag} is "${d.from}", want "enabled" on ${owner}/${repo}`);
    }
    process.exit(1);
  }

  if (drift.length === 0) {
    console.log(`nothing to do: ${owner}/${repo} already has both flags enabled.`);
    return;
  }

  // Apply secret-scanning-first (MANAGED_FLAGS order). Push protection depends
  // on secret scanning, so a one-shot PATCH could race; sequential is safe.
  for (const d of drift) {
    await api(token, "PATCH", `/repos/${owner}/${repo}`, {
      security_and_analysis: { [d.flag]: { status: "enabled" } },
    });
    console.log(`enabled: ${d.flag} on ${owner}/${repo}`);
  }
}

// Only run when invoked directly, so the exported helpers can be imported by
// the test suite without triggering a live API call.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
