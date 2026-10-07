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
