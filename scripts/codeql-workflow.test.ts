// SPDX-License-Identifier: MPL-2.0

/**
 * Asserts on the issue-#26 security-gate config: `.github/workflows/codeql.yml`,
 * `.github/workflows/dependency-review.yml`, and the CodeQL required-status
 * context in `.github/rulesets/main.json`. These workflows are CI-only and have
 * no runtime code to integration-test; pure-string / parsed-config checks are
 * the test surface, mirroring `scripts/security-review-workflow.test.ts` and
 * `scripts/dependabot-config.test.ts`.
 *
 * No YAML-parser dependency by design — assertions are pure-string (the
 * ruleset is JSON, so it is `JSON.parse`d). Failures here are regressions in
 * the load-bearing fields: triggers, analysed languages, action version pins,
 * least-privilege permissions, the query suite, the dependency-review severity
 * + scope + license gates, the license-allow-list lockstep, and the CodeQL
 * required-status context.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALLOWED_LICENSES } from "./license-check.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CODEQL_PATH = resolve(REPO_ROOT, ".github/workflows/codeql.yml");
const DEP_REVIEW_PATH = resolve(REPO_ROOT, ".github/workflows/dependency-review.yml");
const RULESET_PATH = resolve(REPO_ROOT, ".github/rulesets/main.json");

const codeql = readFileSync(CODEQL_PATH, "utf8");
const depReview = readFileSync(DEP_REVIEW_PATH, "utf8");
const rulesetRaw = readFileSync(RULESET_PATH, "utf8");

describe("codeql.yml workflow", () => {
  it("CQ1: triggers on pull_request targeting main", () => {
    expect(codeql).toMatch(/on:\s*\n\s*pull_request:\s*\n\s*branches:\s*\[main\]/);
  });

  it("CQ2: triggers on push to main (baseline rescan on merge)", () => {
    expect(codeql).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it("CQ3: runs on a weekly schedule (not daily/hourly, not absent)", () => {
    const m = codeql.match(/cron:\s*["']([^"']+)["']/);
    expect(m).not.toBeNull();
    // 5 fields, day-of-week pinned to a single 0-6 value => once per week.
    expect(m?.[1]).toMatch(/^\d+\s+\d+\s+\*\s+\*\s+[0-6]$/);
  });

  it("CQ4: analyses both javascript-typescript and actions languages", () => {
    // Matrix children — the `actions` language scans the workflow files.
    expect(codeql).toMatch(/^\s*-\s*javascript-typescript\s*$/m);
    expect(codeql).toMatch(/^\s*-\s*actions\s*$/m);
  });

  it("CQ5: pins codeql-action init + analyze to one commit SHA (no floating tag)", () => {
    // The repo-wide SHA-pin rule lives in scripts/action-pins.test.ts (#104);
    // here only that init and analyze come from the same release, because a
    // mismatched pair fails the analysis upload.
    const shas = [
      ...codeql.matchAll(/github\/codeql-action\/(?:init|analyze)@([0-9a-f]{40})\b/g),
    ].map((m) => m[1]);
    expect(shas).toHaveLength(2);
    expect(new Set(shas).size).toBe(1);
  });

  it("CQ6: uses the security-extended query suite", () => {
    expect(codeql).toMatch(/queries:\s*security-extended/);
  });

  it("CQ7: grants least-privilege permissions (security-events: write, no write-all)", () => {
    expect(codeql).toMatch(/security-events:\s*write/);
    expect(codeql).toMatch(/actions:\s*read/);
    expect(codeql).not.toMatch(/write-all/);
    expect(codeql).not.toMatch(/contents:\s*write/);
  });

  it("CQ8: pins actions/checkout by commit SHA", () => {
    expect(codeql).toMatch(/actions\/checkout@[0-9a-f]{40}\b/);
  });
});

describe("dependency-review.yml workflow", () => {
  it("DR1: triggers on pull_request targeting main", () => {
    expect(depReview).toMatch(/on:\s*\n\s*pull_request:\s*\n\s*branches:\s*\[main\]/);
  });

  it("DR2: pins dependency-review-action by commit SHA (no floating tag or branch)", () => {
    expect(depReview).toMatch(/actions\/dependency-review-action@[0-9a-f]{40}\b/);
  });

  it("DR3: fails on high-or-higher severity vulnerabilities", () => {
    expect(depReview).toMatch(/fail-on-severity:\s*high/);
  });

  it("DR4: gates dev dependencies too (fail-on-scopes includes development)", () => {
    const m = depReview.match(/fail-on-scopes:\s*(.+)/);
    expect(m).not.toBeNull();
    const scopes = (m?.[1] ?? "").split(",").map((s) => s.trim());
    expect(scopes).toContain("runtime");
    expect(scopes).toContain("development");
  });

  it("DR5: uses the non-deprecated allow-licenses (not deny-licenses)", () => {
    expect(depReview).toMatch(/allow-licenses:/);
    expect(depReview).not.toMatch(/deny-licenses:/);
  });

  it("DR6: grants least-privilege permissions (no write-all)", () => {
    expect(depReview).toMatch(/contents:\s*read/);
    expect(depReview).toMatch(/pull-requests:\s*write/);
    expect(depReview).not.toMatch(/write-all/);
  });

  it("DR7: posts the summary comment only on failure", () => {
    expect(depReview).toMatch(/comment-summary-in-pr:\s*on-failure/);
  });
});

describe("main.json ruleset — CodeQL required status check", () => {
  // GitHub's code-scanning results check is a single check run named after the
  // tool ("CodeQL"), distinct from the per-language `Analyze (<lang>)` Actions
  // job checks. That aggregate check is the severity-aware merge blocker AC#4
  // requires, and is the correct required-status context. Confirmed against
  // PR #103's run (a check literally named `CodeQL` was emitted and passed).
  const ruleset = JSON.parse(rulesetRaw) as {
    rules: {
      type: string;
      parameters?: { required_status_checks?: { context: string }[] };
    }[];
  };
  const requiredChecks =
    ruleset.rules.find((r) => r.type === "required_status_checks")?.parameters
      ?.required_status_checks ?? [];
  const contexts = requiredChecks.map((c) => c.context);

  it("RS1: ruleset is valid JSON", () => {
    expect(Array.isArray(ruleset.rules)).toBe(true);
  });

  it("RS2: the CodeQL context is a required status check", () => {
    expect(contexts).toContain("CodeQL");
  });

  it("RS3: pre-existing required checks are preserved", () => {
    for (const ctx of [
      "Lockfile freshness",
      "Lint, Typecheck, Migrate, Test, License",
      "build + push (admin)",
      "build + push (gateway)",
      "Admin production image — boot smoke",
    ]) {
      expect(contexts).toContain(ctx);
    }
  });
});

describe("license allow-list lockstep", () => {
  // The MPL-compatible set (CLAUDE.md §3) lives in two places: the
  // dependency-review workflow gates PR-introduced deps, and `license:check`
  // (scripts/license-check.ts) gates the installed tree. They must stay identical, or one gate quietly
  // permits what the other forbids. This test fails the moment they diverge.
  function dependencyReviewAllowList(): Set<string> {
    const m = depReview.match(/allow-licenses:\s*(.+)/);
    if (!m) throw new Error("dependency-review.yml has no allow-licenses line");
    return new Set(
      m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  it("dependency-review allow-licenses equals ALLOWED_LICENSES of scripts/license-check.ts", () => {
    expect([...dependencyReviewAllowList()].sort()).toEqual([...ALLOWED_LICENSES].sort());
  });
});

describe("issue #113 — least-privilege workflow permissions", () => {
  // Action pinning moved to scripts/action-pins.test.ts (#104), which covers
  // every workflow and composite action, first-party actions included.
  const WORKFLOWS = ["ci.yml", "release.yml", "release-images.yml", "e2e-livedit.yml"].map((f) => ({
    name: f,
    body: readFileSync(resolve(REPO_ROOT, ".github/workflows", f), "utf8"),
  }));

  it("P4: no workflow grants write-all", () => {
    for (const wf of WORKFLOWS) {
      expect(wf.body, wf.name).not.toMatch(/write-all/);
    }
  });

  it("P5: ci.yml least-privilege jobs each declare a contents:read permissions block", () => {
    const ci = WORKFLOWS.find((w) => w.name === "ci.yml")?.body ?? "";
    // lockfile + check + e2e (this PR) + the pre-existing admin-prod-image.
    const count = (ci.match(/permissions:\s*\n\s*contents:\s*read/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("P6: the e2e-livedit plan job only reads, except the budget-skip PR comment", () => {
    const wf = WORKFLOWS.find((w) => w.name === "e2e-livedit.yml")?.body ?? "";
    const plan = wf.slice(wf.indexOf("\n  plan:\n"), wf.indexOf("\n  e2e-livedit:\n"));
    expect(plan).toMatch(
      /permissions:\s*\n\s*contents: read\n(?:\s*#.*\n)*\s*actions: read\n(?:\s*#.*\n)*\s*checks: read\n(?:\s*#.*\n)*\s*pull-requests: write\n/,
    );
    expect(plan).not.toMatch(/contents: write|actions: write/);
  });
});
