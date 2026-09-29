// SPDX-License-Identifier: MPL-2.0

/**
 * Pure-string checks on `.github/workflows/model-catalog-refresh.yml`, in the
 * style of `codeql-workflow.test.ts`: the weekly trigger, least-privilege
 * permissions, keys injected via env (never interpolated into `run:`), and
 * that a changed catalog only ever reaches main through a PR.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(import.meta.dir, "../.github/workflows/model-catalog-refresh.yml"),
  "utf8",
);

describe("model-catalog-refresh.yml", () => {
  it("runs weekly and on demand", () => {
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron: "0 6 \* \* 1"/);
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("asks only for contents + pull-requests write", () => {
    expect(workflow).toMatch(
      /permissions:\s*\n\s*contents: write\s*\n\s*pull-requests: write\s*\n/,
    );
  });

  it("pins setup-bun by SHA like the other workflows", () => {
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
  });

  it("injects provider keys through env, never inside run:", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we're matching against
    expect(workflow).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_E2E }}");
    // Body of every `run: |` block = the following lines indented deeper than `run:`.
    const lines = workflow.split("\n");
    const runBodies: string[] = [];
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)run: \|$/);
      if (!m) return;
      const indent = (m[1] as string).length;
      for (const next of lines.slice(i + 1)) {
        if (next.trim() !== "" && next.search(/\S/) <= indent) break;
        runBodies.push(next);
      }
    });
    expect(runBodies.length).toBeGreaterThan(5);
    expect(runBodies.join("\n")).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("changes reach main only via a PR branch", () => {
    expect(workflow).toContain('git push --force origin "$BRANCH"');
    expect(workflow).toContain("gh pr create");
    expect(workflow).not.toMatch(/git push[^\n]*\bmain\b/);
  });

  it("runs the refresh script with a summary for the PR body", () => {
    expect(workflow).toContain(
      'bun scripts/refresh-model-catalog.ts --summary "$RUNNER_TEMP/model-refresh.md"',
    );
    expect(workflow).toContain('--body-file "$RUNNER_TEMP/model-refresh.md"');
  });
});
