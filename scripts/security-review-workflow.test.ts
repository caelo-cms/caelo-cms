// SPDX-License-Identifier: MPL-2.0

/**
 * Asserts on `.github/workflows/security-review.yml` and
 * `.github/ai-review/caelo-security-categories.md`. The workflow itself is
 * CI-only and has no runtime code to integration-test; these pure-string
 * checks are the test surface for issue #24's contract.
 *
 * Failures here are regressions in: trigger types, secret reference, permissions
 * block, supply-chain SHA-pin, model id, cost-cap layers (timeout / concurrency /
 * diff-size guard), skip rules, exclude-directories list, or the citation
 * anchors in the custom-prompt categories file.
 *
 * Numbered to match `.workflow-plan.md` §8.1 (U1–U16) so a failure cites the
 * row that fired. No YAML parser dependency by design — plan §8.1 commits to
 * pure-string assertions so this stays in `bun test` without dragging in
 * `js-yaml` or `actionlint`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/security-review.yml");
const CATEGORIES_PATH = resolve(REPO_ROOT, ".github/ai-review/caelo-security-categories.md");

const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const categories = readFileSync(CATEGORIES_PATH, "utf8");

describe("AI security review workflow YAML", () => {
  it("U1: triggers on PR opened / synchronize / reopened / ready_for_review", () => {
    expect(workflow).toMatch(/on:\s*\n\s*pull_request:/);
    const typesLine = workflow.match(/types:\s*\[([^\]]+)\]/);
    expect(typesLine).not.toBeNull();
    const types = (typesLine?.[1] ?? "")
      .split(",")
      .map((t) => t.trim())
      .sort();
    expect(types).toEqual(["opened", "ready_for_review", "reopened", "synchronize"].sort());
  });

  it("U2: top-level permissions block is exactly pull-requests + contents", () => {
    // Bound the match at the next top-level key (a line starting in column 0,
    // not whitespace, not a comment) so we don't gobble `concurrency:` etc.
    const block = workflow.match(/\npermissions:\s*\n((?:[ \t]+\S.*\n)+)/);
    expect(block).not.toBeNull();
    const lines = (block?.[1] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.sort()).toEqual(["contents: read", "pull-requests: write"].sort());
  });

  it("U3: concurrency block exists, keys on PR number, cancel-in-progress", () => {
    expect(workflow).toMatch(/^concurrency:/m);
    expect(workflow).toContain("github.event.pull_request.number");
    expect(workflow).toMatch(/cancel-in-progress:\s*true/);
  });

  it("U4: anthropics action is pinned by a 40-char SHA (no @main / @v1)", () => {
    expect(workflow).toMatch(/uses:\s*anthropics\/claude-code-security-review@[0-9a-f]{40}\b/);
  });

  it("U5: a `# pinned <YYYY-MM-DD>` comment is on or above the action ref", () => {
    const lines = workflow.split("\n");
    const refIndex = lines.findIndex((l) =>
      /uses:\s*anthropics\/claude-code-security-review@/.test(l),
    );
    expect(refIndex).toBeGreaterThan(0);
    const window = lines.slice(Math.max(0, refIndex - 3), refIndex + 1);
    // Comment line carries the date with a `pinned` marker anywhere on it
    // — gives some prose-flexibility in the surrounding comment.
    const hasDateComment = window.some((l) => /#.*\bpinned\b.*\d{4}-\d{2}-\d{2}/i.test(l));
    expect(hasDateComment).toBe(true);
  });

  it("U6: claude-model is set to claude-sonnet-4-6 (not action default)", () => {
    expect(workflow).toMatch(/claude-model:\s*claude-sonnet-4-6\b/);
  });

  it("U7: claudecode-timeout is 15 minutes", () => {
    expect(workflow).toMatch(/claudecode-timeout:\s*15\b/);
  });

  it("U8: job-level timeout-minutes is 20", () => {
    expect(workflow).toMatch(/timeout-minutes:\s*20\b/);
  });

  it("U9: job-level `if:` carries all four early-exit conditions", () => {
    const ifMatch = workflow.match(/^\s{4}if:\s*>-?\s*\n([\s\S]+?)\n\s{4}\S/m);
    expect(ifMatch).not.toBeNull();
    const expression = ifMatch?.[1] ?? "";
    expect(expression).toContain("github.event.pull_request.user.type != 'Bot'");
    expect(expression).toContain("github.event.pull_request.draft == false");
    expect(expression).toContain(
      "!contains(github.event.pull_request.labels.*.name, 'skip-ai-review')",
    );
    expect(expression).toContain("github.event.pull_request.changed_files <= 200");
  });

  it("U10: API key references secrets.CLAUDE_SECURITY_REVIEW only — no literal", () => {
    expect(workflow).toMatch(/claude-api-key:\s*\$\{\{\s*secrets\.CLAUDE_SECURITY_REVIEW\s*\}\}/);
    expect(workflow).not.toMatch(/claude-api-key:\s*['"][A-Za-z0-9_-]{20,}/);
  });

  it("U11: exclude-directories carries every documented path", () => {
    const line = workflow.match(/exclude-directories:\s*([^\n]+)/);
    expect(line).not.toBeNull();
    const entries = (line?.[1] ?? "").split(",").map((s) => s.trim());
    for (const required of [
      "node_modules",
      "dist",
      ".svelte-kit",
      "build",
      "docs-site/.astro",
      "packages/migrations/sql",
      "coverage",
      ".turbo",
      "test-results",
      "playwright-report",
    ]) {
      expect(entries).toContain(required);
    }
  });

  it("U12: custom-security-scan-instructions points at the categories file", () => {
    expect(workflow).toContain(
      "custom-security-scan-instructions: .github/ai-review/caelo-security-categories.md",
    );
  });
});

describe("Caelo security categories file", () => {
  it("U13: exists and is at least 500 bytes (non-empty teaching content)", () => {
    expect(categories.length).toBeGreaterThanOrEqual(500);
  });

  it("U14: cites all four CLAUDE.md sections the reviewer will surface", () => {
    expect(categories).toContain("CLAUDE.md §2");
    expect(categories).toContain("CLAUDE.md §4");
    expect(categories).toContain("CLAUDE.md §7");
    expect(categories).toContain("CLAUDE.md §11.A");
  });

  it("U15: at least four `**Header:**` markdown-bold headers (action format spec)", () => {
    const headers = categories.match(/^\*\*[^*]+:\*\*/gm) ?? [];
    expect(headers.length).toBeGreaterThanOrEqual(4);
  });

  it("U16: carries the canonical Caelo guardrail phrases", () => {
    for (const phrase of ["no raw SQL", "Query API", "RLS", "propose_", "Tier 2"]) {
      expect(categories).toContain(phrase);
    }
  });
});
