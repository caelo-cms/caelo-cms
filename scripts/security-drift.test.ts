// SPDX-License-Identifier: MPL-2.0

/**
 * The security-settings drift guard (issue #105): the drift computation of
 * `enable-security-features.ts`, the one-issue dedup of
 * `security-drift-issue.ts`, and the load-bearing shape of
 * `.github/workflows/security-drift.yml` (pure-string, like the other
 * workflow-contract tests in `scripts/`).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeDrift, SettingsUnreadableError } from "./enable-security-features.ts";
import {
  DRIFT_ISSUE_AUTHOR,
  DRIFT_ISSUE_TITLE,
  findDriftIssue,
  type OpenIssue,
  parseCheckResult,
  planIssueAction,
  renderReport,
} from "./security-drift-issue.ts";

const on = { status: "enabled" };
const off = { status: "disabled" };

describe("computeDrift", () => {
  it("reports nothing when every managed setting is on", () => {
    expect(
      computeDrift({
        securityAndAnalysis: { secret_scanning: on, secret_scanning_push_protection: on },
        dependabotAlerts: "enabled",
      }),
    ).toEqual([]);
  });

  it("reports each setting that is off, in apply order", () => {
    expect(
      computeDrift({
        securityAndAnalysis: { secret_scanning: off, secret_scanning_push_protection: off },
        dependabotAlerts: "disabled",
      }).map((d) => d.flag),
    ).toEqual(["secret_scanning", "secret_scanning_push_protection", "dependabot_alerts"]);
  });

  it("treats a flag missing from a readable block as off", () => {
    expect(
      computeDrift({ securityAndAnalysis: { secret_scanning: on }, dependabotAlerts: "enabled" }),
    ).toEqual([{ flag: "secret_scanning_push_protection", from: "disabled", to: "enabled" }]);
  });

  it("refuses to guess when the token cannot see the block (no false drift, no false pass)", () => {
    for (const securityAndAnalysis of [undefined, null]) {
      expect(() => computeDrift({ securityAndAnalysis, dependabotAlerts: "disabled" })).toThrow(
        SettingsUnreadableError,
      );
    }
  });

  it("ignores flags it does not manage", () => {
    expect(
      computeDrift({
        securityAndAnalysis: {
          secret_scanning: on,
          secret_scanning_push_protection: on,
          secret_scanning_validity_checks: off,
        },
        dependabotAlerts: "enabled",
      }),
    ).toEqual([]);
  });
});

describe("parseCheckResult (the only input the issue step accepts)", () => {
  it("accepts known settings and reasons", () => {
    expect(parseCheckResult("ok", "", "")).toEqual({ status: "ok" });
    expect(parseCheckResult("drift", "secret_scanning,dependabot_alerts", "")).toEqual({
      status: "drift",
      drift: ["secret_scanning", "dependabot_alerts"],
    });
    expect(parseCheckResult("unreadable", "", "missing-secret")).toEqual({
      status: "unreadable",
      reason: "missing-secret",
    });
  });

  it("rejects anything outside the fixed lists", () => {
    expect(() => parseCheckResult("drift", "secret_scanning,<script>", "")).toThrow(
      /unknown setting/,
    );
    expect(() => parseCheckResult("drift", "", "")).toThrow(/at least one/);
    expect(() => parseCheckResult("unreadable", "", "anything")).toThrow(/unknown REASON/);
    expect(() => parseCheckResult("error", "", "")).toThrow(/unknown STATUS/);
  });
});

describe("renderReport", () => {
  it("names every setting that is off and how to turn it on", () => {
    const md = renderReport("o/r", { status: "drift", drift: ["secret_scanning_push_protection"] });
    expect(md).toContain("**Push protection**");
    expect(md).toContain("bun run security:enable");
    expect(md).toContain("https://github.com/o/r/settings/security_analysis");
  });

  it("says the settings are unreadable, not off, with the fix per reason", () => {
    const missing = renderReport("o/r", { status: "unreadable", reason: "missing-secret" });
    expect(missing).toContain("could not read");
    expect(missing).toContain("is not set");
    const noAdmin = renderReport("o/r", { status: "unreadable", reason: "no-admin-read" });
    expect(noAdmin).toContain("Administration: read-only");
  });
});

describe("drift issue dedup", () => {
  const run = "https://github.com/o/r/actions/runs/1";
  const mine: OpenIssue = {
    number: 7,
    title: DRIFT_ISSUE_TITLE,
    user: { login: DRIFT_ISSUE_AUTHOR },
  };
  const drift = { status: "drift", drift: ["secret_scanning"] } as const;

  it("finds only the guard's own issue: exact title, bot author, not a PR", () => {
    const sameTitleHuman = { ...mine, number: 1, user: { login: "someone" } };
    const pr = { ...mine, number: 2, pull_request: {} };
    const other = { ...mine, number: 3, title: "Something else" };
    expect(findDriftIssue([sameTitleHuman, pr, other])).toBeUndefined();
    expect(findDriftIssue([sameTitleHuman, pr, other, mine])?.number).toBe(7);
  });

  it("opens one issue on first drift", () => {
    const a = planIssueAction(
      { status: "drift", drift: ["secret_scanning"] },
      undefined,
      "o/r",
      run,
    );
    expect(a.kind).toBe("open");
    if (a.kind === "open") {
      expect(a.body).toContain("**Secret scanning**");
      expect(a.body).toContain(run);
    }
  });

  it("updates the open issue instead of opening another", () => {
    const a = planIssueAction({ status: "unreadable", reason: "no-admin-read" }, mine, "o/r", run);
    expect(a).toMatchObject({ kind: "update", number: 7 });
    expect(planIssueAction({ ...drift, drift: [...drift.drift] }, mine, "o/r", run)).toMatchObject({
      kind: "update",
    });
  });

  it("closes the open issue once everything is on, and does nothing otherwise", () => {
    expect(planIssueAction({ status: "ok" }, mine, "o/r", run)).toMatchObject({
      kind: "close",
      number: 7,
    });
    expect(planIssueAction({ status: "ok" }, undefined, "o/r", run)).toEqual({ kind: "none" });
  });
});

describe("security-drift.yml", () => {
  const wf = readFileSync(
    resolve(import.meta.dir, "../.github/workflows/security-drift.yml"),
    "utf8",
  );
  const stepBlocks = wf.split(/\n(?=\s+- (?:name|uses):)/);

  it("runs weekly and on demand, never on pull requests", () => {
    expect(wf).toMatch(/cron:\s*"\d+ \d+ \* \* [0-6]"/);
    expect(wf).toMatch(/^\s+workflow_dispatch:/m);
    expect(wf).not.toMatch(/pull_request/);
  });

  it("keeps the PAT to main's code: environment secret, main-only job, main checkout", () => {
    // The environment's branch policy (main only) is what GitHub enforces even
    // when a branch rewrites this file; the `if` and the pinned checkout keep a
    // dispatch on another ref from running that ref's scripts.
    expect(wf).toMatch(/^ {4}environment: security-drift$/m);
    expect(wf).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    const checkout = stepBlocks.find((b) => b.includes("actions/checkout@"));
    expect(checkout).toMatch(/\n\s+ref: main\n/);
    expect(checkout).toMatch(/persist-credentials: false/);
  });

  it("grants nothing at the top level and only contents:read + issues:write to the job", () => {
    expect(wf).toMatch(/^permissions: \{\}$/m);
    const job = wf.match(/\n {4}permissions:\n((?: {6}\S.*\n)+)/);
    expect(
      job?.[1]
        ?.trim()
        .split("\n")
        .map((l) => l.trim())
        .sort(),
    ).toEqual(["contents: read", "issues: write"]);
  });

  it("hands the admin-read PAT to the check step only", () => {
    const withPat = stepBlocks.filter((b) => b.includes("secrets.SECURITY_SETTINGS_READ_TOKEN"));
    expect(withPat).toHaveLength(1);
    expect(withPat[0]).toContain("enable-security-features.ts --check --github-output");
    const issueStep = stepBlocks.find((b) => b.includes("security-drift-issue.ts"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(issueStep).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(issueStep).not.toContain("secrets.");
  });

  it("passes only step outputs to the issue step, no files", () => {
    expect(wf).not.toMatch(/--report/);
    const issueStep = stepBlocks.find((b) => b.includes("security-drift-issue.ts")) ?? "";
    for (const key of ["status", "drift", "reason"]) {
      expect(issueStep).toContain(`steps.check.outputs.${key}`);
    }
  });

  it("maps the check's exit codes to the issue statuses", () => {
    expect(wf).toContain("0) status=ok");
    expect(wf).toContain("1) status=drift");
    expect(wf).toContain("2) status=unreadable");
    expect(wf).toContain("*) status=error");
  });
});
