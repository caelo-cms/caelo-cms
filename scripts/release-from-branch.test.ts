// SPDX-License-Identifier: MPL-2.0
/**
 * Contract for releasing from a release branch. Before it, the
 * release commit had to be squash-merged onto exactly the main commit it
 * was cut from, so every merge during a cut (~25 min real-AI gate + the PR
 * click) cost the release (v0.10.63 never shipped), and a broken stamp
 * only surfaced in release.yml after main already had the release commit
 * (v0.10.65). Now the cut tags its own commit on release/vX.Y.Z and main
 * stays open; release.yml brings the release back to main at the end.
 *
 * B1: release-cut has no push trigger — merging the release PR into main
 *     publishes nothing.
 * B2: the real-AI gate runs on a branch pinned to the cut commit, never on
 *     main (which may move during the cut).
 * B2a: once the dispatched run finished, the verdict reads that run by id.
 * B3: the release commit is verified (release-script files only, lint,
 *     lockstep, catalogue) before the branch + tag push, and that push is
 *     atomic.
 * B4: release.yml's gate runs the test suite unless the scope step proves
 *     the tag is a pure release commit on a parent ci.yml passed; the
 *     checks that cover the release commit itself always run.
 * B5: release.yml opens the release PR only after the GitHub Release.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly if?: string;
  readonly uses?: string;
}
interface Job {
  readonly needs?: string | string[];
  readonly permissions?: Record<string, string>;
  readonly steps?: Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

function workflow(file: string): Workflow {
  const parsed = yaml.load(
    readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8"),
  ) as Record<string, unknown>;
  // js-yaml (YAML 1.1) reads the bare `on:` key as boolean true.
  return {
    ...(parsed as object),
    on: (parsed.on ?? parsed.true) as Record<string, unknown>,
  } as Workflow;
}

const cut = workflow("release-cut.yml");
const cutSteps = cut.jobs.cut?.steps ?? [];
const stepIndex = (steps: readonly Step[], prefix: string) =>
  steps.findIndex((s) => (s.name ?? "").startsWith(prefix));

const release = workflow("release.yml");
const gateSteps = release.jobs.gate?.steps ?? [];

describe("release-cut — tag on the release branch, keep main open", () => {
  it("B1: is dispatch-only", () => {
    expect(Object.keys(cut.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(cut.jobs)).toEqual(["cut"]);
  });

  it("B2: dispatches the real-AI suite on a branch pinned to the cut commit", () => {
    const gate = cutSteps[stepIndex(cutSteps, "Gate — real-AI suite")]?.run ?? "";
    expect(gate).toContain('git push origin "$SHA:refs/heads/release-gate/$SHA"');
    expect(gate).toContain('gh workflow run "$WORKFLOW_FILE" --ref "release-gate/$SHA"');
    expect(gate).not.toContain("--ref main");
  });

  it("B2a: judges the awaited run by its id, not by the lagging success listing", () => {
    const gate = cutSteps[stepIndex(cutSteps, "Gate — real-AI suite")]?.run ?? "";
    const verdict = gate.slice(gate.indexOf("waiting for run $run"));
    // v0.10.66: the `status=success` listing missed a run finished 2 s earlier.
    expect(verdict).not.toContain("ai_job_ok");
    expect(verdict).toContain('gh api "repos/$REPO/actions/runs/$run" --jq \'.conclusion // ""\'');
    expect(verdict).toContain('if [ "$verdict" != "success/success" ]; then');
  });

  it("B3: verifies the release commit before an atomic branch + tag push", () => {
    const check = stepIndex(cutSteps, "Check the release commit");
    const push = stepIndex(cutSteps, "Push the release branch + tag");
    const script = stepIndex(cutSteps, "Run the release script");
    expect(script).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(script);
    expect(push).toBeGreaterThan(check);
    const run = cutSteps[check]?.run ?? "";
    for (const cmd of [
      "bun scripts/release-commit.ts verify",
      "bun run lint",
      "bun scripts/release.ts --check",
      "bun scripts/power-catalogue.ts --check",
    ]) {
      expect(run).toContain(cmd);
    }
    const pushRun = cutSteps[push]?.run ?? "";
    expect(pushRun).toContain("git push --atomic");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable
    expect(pushRun).toContain('"refs/tags/v${V}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable
    expect(pushRun).toContain('gh workflow run release.yml --ref "v${V}"');
    // The tag the release script made is what ships; nothing drops it.
    expect(cutSteps.some((s) => (s.run ?? "").includes("git tag -d"))).toBe(false);
  });
});

describe("release.yml — gate scope and merge-back", () => {
  const conditional = ["Bootstrap databases", "Run migrations", "Test"];
  const always = [
    "Lint",
    "Typecheck",
    "Lockstep version check",
    "Power-MCP catalogue snapshot is this release's (#841)",
  ];

  it("B4: skips only the suite, and only behind the scope step", () => {
    const scope = stepIndex(gateSteps, "Decide the gate scope");
    expect(scope).toBeGreaterThan(0);
    const run = gateSteps[scope]?.run ?? "";
    expect(run).toContain("bun scripts/release-commit.ts verify || full");
    expect(run).toContain("actions/workflows/ci.yml/runs?head_sha=$base&event=push&branch=main");
    expect(run).toMatch(/completed:failure[\s\S]*exit 1/);
    for (const name of conditional) {
      const i = gateSteps.findIndex((s) => s.name === name);
      expect(i).toBeGreaterThan(scope);
      expect(gateSteps[i]?.if).toBe("steps.scope.outputs.full == 'true'");
    }
    for (const name of always) {
      const step = gateSteps.find((s) => s.name === name);
      expect(step).toBeDefined();
      expect(step?.if).toBeUndefined();
    }
  });

  it("B5: opens the release PR only after the GitHub Release", () => {
    const job = release.jobs["merge-back"];
    expect(job?.needs).toBe("github-release");
    expect(job?.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(job?.steps?.[0]?.run ?? "").toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variables
      'gh pr create -R "${REPO}" --base main --head "${branch}"',
    );
  });
});
