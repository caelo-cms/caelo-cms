// SPDX-License-Identifier: MPL-2.0
/**
 * Contract for the AI-run cost gate in the two AI workflows: once the AI
 * job has succeeded on a PR, later commits to that PR skip it; a new or
 * reopened PR always runs.
 *
 * G1: a `prior-success` job exists with only `actions: read`.
 * G2: the AI job needs it and skips when it reports `passed == 'true'`.
 * G3: the gate only ever skips on `synchronize` (new commits), never on
 *     opened / reopened / ready_for_review or non-PR events.
 * G4: the gate looks for the AI job by its exact `name:` — a rename of the
 *     AI job without updating JOB_NAME would silently disable the gate.
 * G5: the gate requires the AI JOB's success, not just a green workflow
 *     (a workflow whose AI job was itself skipped is also "success").
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly id?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface Job {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly steps?: Step[];
}

const CASES = [
  { file: "security-review.yml", aiJob: "security-review" },
  { file: "e2e-livedit.yml", aiJob: "e2e-livedit" },
] as const;

for (const { file, aiJob } of CASES) {
  const wf = yaml.load(readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8")) as {
    jobs: Record<string, Job>;
  };
  const gate = wf.jobs["prior-success"];
  const ai = wf.jobs[aiJob];
  const step = gate?.steps?.find((s) => s.id === "check");

  describe(`${file} — AI run cost gate`, () => {
    it("G1: prior-success job with only actions: read", () => {
      expect(gate).toBeDefined();
      expect(gate?.permissions).toEqual({ actions: "read" });
    });

    it("G2: the AI job needs the gate and skips on passed == 'true'", () => {
      const needs = Array.isArray(ai?.needs) ? ai.needs : [ai?.needs];
      expect(needs).toContain("prior-success");
      expect(ai?.if ?? "").toContain("needs.prior-success.outputs.passed != 'true'");
    });

    it("G3: only `synchronize` can skip", () => {
      expect(step?.run ?? "").toContain(
        'if [ "$EVENT" != "pull_request" ] || [ "$ACTION" != "synchronize" ]; then',
      );
    });

    it("G4: JOB_NAME matches the AI job's name", () => {
      expect(step?.env?.JOB_NAME).toBe(ai?.name);
      expect(step?.env?.WORKFLOW_FILE).toBe(file);
    });

    it("G5: requires the AI job's own success, not just a green workflow", () => {
      expect(step?.run ?? "").toContain('.conclusion == \\"success\\"');
      expect(step?.run ?? "").toContain("/jobs?");
    });
  });
}

/**
 * Main coverage for the real-AI suite (2026-10-09): once per release instead
 * of per push.
 *
 * N1: e2e-livedit.yml has no push or schedule trigger (a squash merge re-ran
 *     what its PR already ran); workflow_dispatch stays for release-cut.
 * N2: release-cut's cut job gates on the AI job's success on HEAD before the
 *     release script runs, dispatching a run when there is none.
 */
describe("e2e-livedit.yml — main runs once per release, gated in release-cut", () => {
  const livedit = yaml.load(
    readFileSync(resolve(REPO_ROOT, ".github/workflows/e2e-livedit.yml"), "utf8"),
  ) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  const cut = yaml.load(
    readFileSync(resolve(REPO_ROOT, ".github/workflows/release-cut.yml"), "utf8"),
  ) as { jobs: Record<string, Job> };

  it("N1: PR and manual dispatch only; no push or schedule trigger", () => {
    expect(Object.keys(livedit.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
  });

  it("N2: release-cut gates on the AI job before the release script runs", () => {
    const steps = cut.jobs.cut?.steps ?? [];
    const gate = steps.findIndex((s) => (s.run ?? "").includes('gh workflow run "$WORKFLOW_FILE"'));
    const release = steps.findIndex((s) => (s.run ?? "").includes("scripts/release.ts"));
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(release);
    const step = steps[gate];
    expect(step?.env?.WORKFLOW_FILE).toBe("e2e-livedit.yml");
    expect(step?.env?.JOB_NAME).toBe(livedit.jobs["e2e-livedit"]?.name);
    expect(step?.run ?? "").toContain("head_sha=$SHA");
    expect(step?.run ?? "").toContain('.conclusion == \\"success\\"');
  });
});
