// SPDX-License-Identifier: MPL-2.0

/**
 * Pure-string checks on the provider preflight in
 * `.github/workflows/e2e-livedit.yml` (style of `codeql-workflow.test.ts`):
 * the probe runs inside the suite job (so a refused key FAILS the required
 * "Real-AI live-edit scenario" check instead of skipping it), before any
 * expensive step, with the key passed through env only; and the post-run
 * steps that need a suite run are skipped when the probe failed, while the
 * PR comment posts the probe's report.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(import.meta.dir, "../.github/workflows/e2e-livedit.yml"),
  "utf8",
);

/** The text of the step whose `- name:` line equals `name`, up to the next step. */
function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`step not found: ${name}`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

/** The jobs-level block of `job` (2-space indented key) up to the next job. */
function job(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  if (start < 0) throw new Error(`job not found: ${id}`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

const PREFLIGHT = "AI provider preflight (fail fast)";

describe("e2e-livedit.yml provider preflight", () => {
  it("probes the provider inside the suite job, not in a gate job", () => {
    // A failing gate job would SKIP the suite job — and a skipped required
    // check counts as passing. The probe must fail the suite job itself.
    expect(job("e2e-livedit")).toContain(`- name: ${PREFLIGHT}`);
    expect(job("preflight")).not.toContain("ai-provider-preflight");
  });

  it("runs before install, compose, build and the scenarios", () => {
    const at = (name: string) => workflow.indexOf(`      - name: ${name}\n`);
    const probe = at(PREFLIGHT);
    expect(probe).toBeGreaterThan(at("Setup Bun"));
    for (const later of [
      "Install dependencies (frozen lockfile)",
      "Start compose (postgres + caddy-staging + caddy-production)",
      "Run e2e-livedit (Scenario 1)",
    ]) {
      expect(probe).toBeLessThan(at(later));
    }
  });

  it("runs the preflight script with the report file and the key via env only", () => {
    const s = step(PREFLIGHT);
    expect(s).toContain("id: provider-preflight");
    expect(s).toContain(
      "run: bun scripts/ai-provider-preflight.ts --report apps/admin/test-results/livedit/provider-preflight.md",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we're matching against
    expect(s).toContain("ANTHROPIC_API_KEY_E2E: ${{ secrets.ANTHROPIC_API_KEY_E2E }}");
    expect(s).not.toContain("continue-on-error");
  });

  it("skips the post-run capture/upload steps when the probe failed", () => {
    for (const name of [
      "Capture real AI cost from ai_calls",
      "Capture AI-detected bugs from ai_bug_reports",
      "Upload AI cost metric (always)",
      "Upload detected-bugs metric (always)",
      "Upload chat transcripts (always)",
    ]) {
      expect(step(name)).toContain("if: always() && steps.provider-preflight.outcome == 'success'");
    }
    for (const name of [
      "Dump diagnostic DB tables on failure",
      "Dump static-gen output dir listings on failure",
      "Upload artifacts on failure",
    ]) {
      expect(step(name)).toContain(
        "if: failure() && steps.provider-preflight.outcome == 'success'",
      );
    }
  });

  it("posts the probe's report as the PR comment when the probe failed", () => {
    const s = step("Push screenshots to side branch and post PR comment");
    expect(s).toContain("if: always() && github.event_name == 'pull_request'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we're matching against
    expect(s).toContain("PREFLIGHT_OUTCOME: ${{ steps.provider-preflight.outcome }}");
    expect(s).toContain('PREFLIGHT_REPORT="apps/admin/test-results/livedit/provider-preflight.md"');
    expect(s).toContain('cat "$PREFLIGHT_REPORT"');
  });

  it("still tears compose down unconditionally", () => {
    expect(step("Teardown compose")).toContain("if: always()\n");
  });
});
