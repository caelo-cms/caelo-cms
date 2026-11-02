#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * The issue side of the security-settings drift guard (#105,
 * `.github/workflows/security-drift.yml`). After `security:check` ran, this
 * keeps exactly one open issue in step with its result:
 *
 *   drift or unreadable, no open issue   → open one
 *   drift or unreadable, issue open      → update its body, comment once per run
 *   all on, issue open                   → comment and close it
 *   all on, no open issue                → nothing
 *
 * One issue, found by its exact title and the `github-actions[bot]` author, so
 * a weekly failure never piles up a new issue per week. It runs with the
 * workflow's own GITHUB_TOKEN (`issues: write`) and never sees the admin-read
 * token of the check step.
 *
 * The check step hands over only setting names and a reason code (step
 * outputs), and this script accepts nothing outside `MANAGED_SETTINGS` /
 * `UNREADABLE_REASONS`. The issue body is assembled from fixed strings, so no
 * text from the API or from a file reaches the issue.
 *
 *   STATUS=drift DRIFT=secret_scanning bun run scripts/security-drift-issue.ts
 *   STATUS=unreadable REASON=missing-secret bun run scripts/security-drift-issue.ts
 *   STATUS=ok bun run scripts/security-drift-issue.ts
 *
 * Env: STATUS, DRIFT, REASON (from the check step) and GITHUB_TOKEN,
 * GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID (set by Actions).
 */

import {
  MANAGED_SETTINGS,
  type ManagedSetting,
  UNREADABLE_REASONS,
  type UnreadableReason,
} from "./enable-security-features.ts";

/** The fixed title the guard's issue is recognised by. */
export const DRIFT_ISSUE_TITLE =
  "Security settings are off: secret scanning, push protection or Dependabot alerts";

/** Author of the guard's issues when it runs with the workflow's GITHUB_TOKEN. */
export const DRIFT_ISSUE_AUTHOR = "github-actions[bot]";

/** The check result, validated: which settings are off, or why none could be read. */
export type CheckResult =
  | { status: "ok" }
  | { status: "drift"; drift: ManagedSetting[] }
  | { status: "unreadable"; reason: UnreadableReason };

/** An open issue as the list endpoint returns it (only the fields used). */
export type OpenIssue = {
  number: number;
  title: string;
  user: { login: string } | null;
  pull_request?: unknown;
};

/** What to do with the guard's issue for one run. */
export type IssueAction =
  | { kind: "none" }
  | { kind: "open"; body: string }
  | { kind: "update"; number: number; body: string; comment: string }
  | { kind: "close"; number: number; comment: string };

/** Human-readable names for the issue body. */
const LABELS: Record<ManagedSetting, string> = {
  secret_scanning: "Secret scanning",
  secret_scanning_push_protection: "Push protection",
  dependabot_alerts: "Dependabot alerts (and with them the dependency graph)",
};

/** What to do about each unreadable reason. */
const REASON_TEXT: Record<UnreadableReason, string> = {
  "missing-secret":
    "The Actions secret `SECURITY_SETTINGS_READ_TOKEN` is not set (or not available to this run).",
  "no-admin-read":
    "The token in `SECURITY_SETTINGS_READ_TOKEN` cannot see the settings: it lacks repo-admin read " +
    "(fine-grained PAT of a repo admin, this repository only, Administration: read-only). " +
    "An expired token ends up here too.",
};

/**
 * Validate the check step's outputs into a `CheckResult`. Every value is
 * matched against the fixed lists and replaced by the list's own constant, so
 * the result holds no input text at all.
 *
 * @throws Error on an unknown status, setting or reason, or an empty drift list.
 */
export function parseCheckResult(status: string, drift: string, reason: string): CheckResult {
  if (status === "ok") return { status: "ok" };
  if (status === "drift") {
    const names = drift.split(",").filter((n) => n !== "");
    const settings = names.map((n) => {
      const known = MANAGED_SETTINGS.find((m) => m === n);
      if (!known) throw new Error(`unknown setting in DRIFT: ${JSON.stringify(n)}`);
      return known;
    });
    if (settings.length === 0) throw new Error("STATUS=drift needs at least one setting in DRIFT");
    return { status: "drift", drift: settings };
  }
  if (status === "unreadable") {
    const known = UNREADABLE_REASONS.find((r) => r === reason);
    if (!known) throw new Error(`unknown REASON: ${JSON.stringify(reason)}`);
    return { status: "unreadable", reason: known };
  }
  throw new Error(`unknown STATUS: ${JSON.stringify(status)}`);
}

/** Render the issue body for a failing result. `slug` is `owner/repo`. */
export function renderReport(slug: string, result: Exclude<CheckResult, { status: "ok" }>): string {
  if (result.status === "unreadable") {
    return [
      `The weekly security-settings check could not read the settings of \`${slug}\`.`,
      "",
      REASON_TEXT[result.reason],
      "",
      "Until this is fixed, nobody notices when secret scanning or push protection get switched off.",
      "Setup: docs/dev/codeql.md, section 'Drift guard'.",
    ].join("\n");
  }
  return [
    `These security settings of \`${slug}\` are off:`,
    "",
    ...result.drift.map((d) => `- **${LABELS[d]}**`),
    "",
    "Turn them back on with `bun run security:enable` (repo admin), or in",
    `https://github.com/${slug}/settings/security_analysis. The weekly check closes this issue once all are on.`,
  ].join("\n");
}

/** The guard's own open issue among `open`, or undefined. Pull requests never count. */
export function findDriftIssue(open: OpenIssue[]): OpenIssue | undefined {
  return open.find(
    (i) => !i.pull_request && i.title === DRIFT_ISSUE_TITLE && i.user?.login === DRIFT_ISSUE_AUTHOR,
  );
}

/**
 * Decide the one issue action for this run. Pure, so the dedup contract is
 * unit-tested without the GitHub API.
 *
 * @param runUrl Link to the workflow run, cited in every body and comment.
 */
export function planIssueAction(
  result: CheckResult,
  existing: OpenIssue | undefined,
  slug: string,
  runUrl: string,
): IssueAction {
  if (result.status === "ok") {
    return existing
      ? {
          kind: "close",
          number: existing.number,
          comment: `All managed security settings are on again (${runUrl}).`,
        }
      : { kind: "none" };
  }
  const body = `${renderReport(slug, result)}\n\nLast checked: ${runUrl}\n\nOpened and closed by \`.github/workflows/security-drift.yml\` (#105).`;
  if (!existing) return { kind: "open", body };
  return { kind: "update", number: existing.number, body, comment: `Still off as of ${runUrl}.` };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; this script runs inside GitHub Actions.`);
  return v;
}

async function main(): Promise<void> {
  const result = parseCheckResult(
    process.env.STATUS ?? "",
    process.env.DRIFT ?? "",
    process.env.REASON ?? "",
  );
  const token = requireEnv("GITHUB_TOKEN");
  const slug = requireEnv("GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug))
    throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${slug}`);
  const runId = requireEnv("GITHUB_RUN_ID");
  if (!/^\d+$/.test(runId)) throw new Error(`GITHUB_RUN_ID is not numeric: ${runId}`);
  const runUrl = `${requireEnv("GITHUB_SERVER_URL")}/${slug}/actions/runs/${runId}`;

  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`https://api.github.com/repos/${slug}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}\n${await res.text()}`);
    return res.json();
  };

  const open: OpenIssue[] = [];
  for (let page = 1; ; page++) {
    const batch = (await api(
      "GET",
      `/issues?state=open&creator=${encodeURIComponent(DRIFT_ISSUE_AUTHOR)}&per_page=100&page=${page}`,
    )) as OpenIssue[];
    open.push(...batch);
    if (batch.length < 100) break;
  }

  const action = planIssueAction(result, findDriftIssue(open), slug, runUrl);
  switch (action.kind) {
    case "none":
      console.log("no drift issue to open or close");
      return;
    case "open": {
      const created = (await api("POST", "/issues", {
        title: DRIFT_ISSUE_TITLE,
        body: action.body,
      })) as { number: number };
      console.log(`opened #${created.number}`);
      return;
    }
    case "update":
      await api("PATCH", `/issues/${action.number}`, { body: action.body });
      await api("POST", `/issues/${action.number}/comments`, { body: action.comment });
      console.log(`updated #${action.number}`);
      return;
    case "close":
      await api("POST", `/issues/${action.number}/comments`, { body: action.comment });
      await api("PATCH", `/issues/${action.number}`, {
        state: "closed",
        state_reason: "completed",
      });
      console.log(`closed #${action.number}`);
      return;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
