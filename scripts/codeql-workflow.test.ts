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

const REPO_ROOT = resolve(import.meta.dir, "..");
const CODEQL_PATH = resolve(REPO_ROOT, ".github/workflows/codeql.yml");
const DEP_REVIEW_PATH = resolve(REPO_ROOT, ".github/workflows/dependency-review.yml");
const RULESET_PATH = resolve(REPO_ROOT, ".github/rulesets/main.json");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

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

  it("CQ5: pins codeql-action init + analyze by major tag, no floating ref", () => {
    expect(codeql).toMatch(/github\/codeql-action\/init@v4/);
    expect(codeql).toMatch(/github\/codeql-action\/analyze@v4/);
    // No floating @main / branch refs on the codeql action.
    expect(codeql).not.toMatch(/github\/codeql-action\/\w+@main/);
    for (const ref of codeql.match(/github\/codeql-action\/\w+@\S+/g) ?? []) {
      expect(ref).toMatch(/@v\d+$/);
    }
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

  it("CQ8: pins actions/checkout by major tag", () => {
    expect(codeql).toMatch(/actions\/checkout@v\d+/);
  });
});

describe("dependency-review.yml workflow", () => {
  it("DR1: triggers on pull_request targeting main", () => {
    expect(depReview).toMatch(/on:\s*\n\s*pull_request:\s*\n\s*branches:\s*\[main\]/);
  });

  it("DR2: pins dependency-review-action by major tag, no floating ref", () => {
    expect(depReview).toMatch(/actions\/dependency-review-action@v\d+/);
    expect(depReview).not.toMatch(/actions\/dependency-review-action@main/);
    for (const ref of depReview.match(/actions\/dependency-review-action@\S+/g) ?? []) {
      expect(ref).toMatch(/@v\d+$/);
    }
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
  // gates the installed tree. They must stay identical, or one gate quietly
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

  function licenseCheckAllowList(): Set<string> {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts["license:check"];
    if (!script) throw new Error("package.json has no license:check script");
    const m = script.match(/--onlyAllow\s+'([^']+)'/);
    if (!m) throw new Error("license:check has no --onlyAllow '...' argument");
    return new Set(
      m[1]!
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  it("dependency-review allow-licenses equals package.json license:check --onlyAllow", () => {
    expect([...dependencyReviewAllowList()].sort()).toEqual([...licenseCheckAllowList()].sort());
  });
});

describe("issue #113 — workflow action pinning + least-privilege permissions", () => {
  // The four workflows that carried actions/unpinned-tag +
  // actions/missing-workflow-permissions alerts. Third-party actions must be
  // SHA-pinned; first-party actions/* + github/* stay on major tags (GitHub's
  // trust model — and codeql.yml/dependency-review.yml above keep them on @vN).
  const WORKFLOWS = ["ci.yml", "release.yml", "release-images.yml", "e2e-livedit.yml"].map((f) => ({
    name: f,
    body: readFileSync(resolve(REPO_ROOT, ".github/workflows", f), "utf8"),
  }));

  const FIRST_PARTY = new Set(["actions", "github"]);

  /**
   * Every `uses:` ref in `body` whose owner is not GitHub-first-party.
   * Matches only `uses:` in YAML step-key position (line start, optional
   * `- `), so prose/comments that mention `uses:` are not treated as actions.
   * Local (`./…`) reusable-workflow calls are skipped.
   */
  function thirdPartyUses(body: string): string[] {
    const refs: string[] = [];
    for (const m of body.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const ref = m[1] ?? "";
      if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
      const owner = ref.split("/")[0] ?? "";
      if (!FIRST_PARTY.has(owner)) refs.push(ref);
    }
    return refs;
  }

  it("P1: extraction finds the expected third-party action uses (guards a silent zero-match)", () => {
    const total = WORKFLOWS.reduce((n, wf) => n + thirdPartyUses(wf.body).length, 0);
    expect(total).toBeGreaterThanOrEqual(16);
  });

  it("P2: every third-party action is pinned to a full 40-char commit SHA (no floating tag)", () => {
    for (const wf of WORKFLOWS) {
      for (const ref of thirdPartyUses(wf.body)) {
        expect(ref, `${wf.name}: ${ref} is not SHA-pinned`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("P3: each SHA-pinned third-party action carries a # vN comment for Dependabot", () => {
    for (const wf of WORKFLOWS) {
      const pinned = wf.body.split("\n").filter((l) => /uses:\s*[^\s#]+@[0-9a-f]{40}/.test(l));
      for (const line of pinned) {
        expect(line, `${wf.name}: ${line.trim()} missing version comment`).toMatch(
          /@[0-9a-f]{40}\s+#\s*v?\d/,
        );
      }
    }
  });

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

  it("P6: e2e-livedit preflight declares an empty permissions block", () => {
    const wf = WORKFLOWS.find((w) => w.name === "e2e-livedit.yml")?.body ?? "";
    expect(wf).toMatch(/permissions:\s*\{\}/);
  });
});
