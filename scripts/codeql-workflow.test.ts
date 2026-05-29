// SPDX-License-Identifier: MPL-2.0

/**
 * Asserts on the issue-#26 security-gate config: `.github/workflows/codeql.yml`,
 * `.github/workflows/dependency-review.yml`, and the CodeQL required-status
 * context in `.github/rulesets/main.json`. These workflows are CI-only and have
 * no runtime code to integration-test; pure-string / parsed-config checks are
 * the test surface, mirroring `scripts/security-review-workflow.test.ts`.
 *
 * This file currently holds the license-allow-list lockstep guard (step 11
 * optimization #4). The broader CQ/DR/RS workflow assertions enumerated in
 * `.workflow-plan.md` §8 are added by the test-expansion step.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEP_REVIEW_PATH = resolve(REPO_ROOT, ".github/workflows/dependency-review.yml");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

/** Licenses listed on the `allow-licenses:` line of dependency-review.yml. */
function dependencyReviewAllowList(): Set<string> {
  const yaml = readFileSync(DEP_REVIEW_PATH, "utf8");
  const m = yaml.match(/allow-licenses:\s*(.+)/);
  if (!m) throw new Error("dependency-review.yml has no allow-licenses line");
  return new Set(
    m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Licenses passed to license-checker via `--onlyAllow '...'` in license:check. */
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

describe("license allow-list lockstep", () => {
  // The MPL-compatible set (CLAUDE.md §3) lives in two places: the
  // dependency-review workflow gates PR-introduced deps, and `license:check`
  // gates the installed tree. They must stay identical, or one gate quietly
  // permits what the other forbids. This test fails the moment they diverge.
  it("dependency-review allow-licenses equals package.json license:check --onlyAllow", () => {
    const fromWorkflow = dependencyReviewAllowList();
    const fromPackage = licenseCheckAllowList();
    expect([...fromWorkflow].sort()).toEqual([...fromPackage].sort());
  });
});
