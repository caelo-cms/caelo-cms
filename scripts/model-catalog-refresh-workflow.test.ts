// SPDX-License-Identifier: MPL-2.0

/**
 * Pure-string checks on `.github/workflows/model-catalog-refresh.yml`, in the
 * style of `codeql-workflow.test.ts`: the weekly trigger, least-privilege
 * permissions, keys injected via env (never interpolated into `run:`), and
 * that the job never writes code itself — it hands the update to the Copilot
 * coding agent as an issue. Also checks the agent's setup workflow.
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

  it("asks only for contents read + issues write", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*issues: write\s*\n/);
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

  it("never pushes code — the change goes to an issue", () => {
    expect(workflow).not.toContain("git push");
    expect(workflow).toContain("gh issue create");
    expect(workflow).toContain('--body-file "$RUNNER_TEMP/issue.md"');
  });

  it("only acts when the check found changes, and reuses an open issue", () => {
    expect(workflow).toContain("if: steps.check.outputs.changed == 'true'");
    expect(workflow).toContain('gh issue comment "$open"');
  });

  it("assigns the issue to the Copilot coding agent via the documented GraphQL path", () => {
    expect(workflow).toContain('select(.login == "copilot-swe-agent")');
    expect(workflow).toContain("replaceActorsForAssignable");
    expect(workflow).toContain("COPILOT_ASSIGN_TOKEN");
  });
});

describe("copilot-setup-steps.yml", () => {
  const setup = readFileSync(
    resolve(import.meta.dir, "../.github/workflows/copilot-setup-steps.yml"),
    "utf8",
  );

  it("uses the job name GitHub requires and installs like CI", () => {
    expect(setup).toMatch(/jobs:\s*\n\s*copilot-setup-steps:/);
    expect(setup).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(setup).toContain("bun install --frozen-lockfile");
    expect(setup).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
  });
});
