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
 *   bun run scripts/security-drift-issue.ts --status drift --report out.md
 *   bun run scripts/security-drift-issue.ts --status ok
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY (`owner/repo`), GITHUB_SERVER_URL and
 * GITHUB_RUN_ID for the run link — all set by Actions.
 */

import { readFileSync } from "node:fs";

/** The fixed title the guard's issue is recognised by. */
export const DRIFT_ISSUE_TITLE =
  "Security settings are off: secret scanning, push protection or Dependabot alerts";

/** Author of the guard's issues when it runs with the workflow's GITHUB_TOKEN. */
export const DRIFT_ISSUE_AUTHOR = "github-actions[bot]";

/** The result of the check step, as reported by its exit code. */
export type CheckStatus = "ok" | "drift" | "unreadable";

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
 * @param report Markdown from `security:check --report`; required unless ok.
 * @param runUrl Link to the workflow run, cited in every body and comment.
 */
export function planIssueAction(
  status: CheckStatus,
  existing: OpenIssue | undefined,
  report: string,
  runUrl: string,
): IssueAction {
  if (status === "ok") {
    return existing
      ? {
          kind: "close",
          number: existing.number,
          comment: `All managed security settings are on again (${runUrl}).`,
        }
      : { kind: "none" };
  }
  const body = `${report.trim()}\n\nLast checked: ${runUrl}\n\nOpened and closed by \`.github/workflows/security-drift.yml\` (#105).`;
  if (!existing) return { kind: "open", body };
  return { kind: "update", number: existing.number, body, comment: `Still off as of ${runUrl}.` };
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; this script runs inside GitHub Actions.`);
  return v;
}

async function main(): Promise<void> {
  const status = arg("status");
  if (status !== "ok" && status !== "drift" && status !== "unreadable") {
    throw new Error("--status must be ok, drift or unreadable");
  }
  const reportPath = arg("report");
  if (status !== "ok" && !reportPath)
    throw new Error(`--report is required for --status ${status}`);
  const report = reportPath ? readFileSync(reportPath, "utf8") : "";

  const token = requireEnv("GITHUB_TOKEN");
  const slug = requireEnv("GITHUB_REPOSITORY");
  const runUrl = `${requireEnv("GITHUB_SERVER_URL")}/${slug}/actions/runs/${requireEnv("GITHUB_RUN_ID")}`;

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

  const action = planIssueAction(status, findDriftIssue(open), report, runUrl);
  switch (action.kind) {
    case "none":
      console.log("no drift issue to open or close");
      return;
    case "open": {
      const created = (await api("POST", "/issues", {
        title: DRIFT_ISSUE_TITLE,
        body: action.body,
      })) as {
        number: number;
      };
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
