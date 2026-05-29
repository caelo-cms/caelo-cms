// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #14 regression contract over the coverage gate in
 * `.github/workflows/ci.yml`.
 *
 * The gate script + thresholds can be perfect, but if the CI step that runs
 * `bun run coverage:check` is removed, or the artifact upload loses its
 * `if: always()`, the gate stops protecting `main`. This test parses the
 * workflow and locks the wiring, mirroring `scripts/madge-ci-step.test.ts`.
 *
 * CC1: the `check` job runs `bun run coverage:check`. Removing it disables
 *      enforcement (AC #1 "runs in CI" + AC #2 "enforced").
 * CC2: there is no bare `bun test --isolate` step left in `check` — the gate
 *      replaced it, so the suite isn't run twice (once gated, once not).
 * CC3: an `actions/upload-artifact` step uploads `coverage/` with `if: always()`
 *      so the report lands even when the gate fails (AC #3).
 * CC4: the coverage step runs AFTER `Run migrations` — the integration tier
 *      needs the real schema in place.
 * CC5: both the gate step and the upload step have human-readable names.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = join(import.meta.dir, "..");
const CI_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const RAW = readFileSync(CI_PATH, "utf8");

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs?: Record<string, { steps?: ReadonlyArray<Step> }>;
};

const workflow = yaml.load(RAW) as Workflow;
const checkSteps = workflow.jobs?.check?.steps ?? [];
const stepIndex = (predicate: (s: Step) => boolean): number => checkSteps.findIndex(predicate);

describe("coverage CI gate contract (issue #14)", () => {
  it("CC1: the check job runs `bun run coverage:check`", () => {
    const step = checkSteps.find((s) => s.run?.includes("bun run coverage:check"));
    expect(step, "no step in the `check` job runs `bun run coverage:check`").toBeDefined();
  });

  it("CC2: no bare `bun test --isolate` step remains in the check job", () => {
    const bare = checkSteps.find(
      (s) => s.run?.includes("bun test --isolate") && !s.run?.includes("coverage:check"),
    );
    expect(
      bare,
      "the gate should have replaced the bare `bun test --isolate` step",
    ).toBeUndefined();
  });

  it("CC3: a coverage artifact is uploaded with if: always()", () => {
    const upload = checkSteps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload, "no actions/upload-artifact step in the `check` job").toBeDefined();
    expect(upload?.if).toBe("always()");
    expect(String(upload?.with?.path)).toContain("coverage");
  });

  it("CC4: the coverage step runs after migrations (integration tier needs the schema)", () => {
    const migrateIdx = stepIndex((s) => Boolean(s.run?.includes("bun run db:migrate")));
    const coverageIdx = stepIndex((s) => Boolean(s.run?.includes("bun run coverage:check")));
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(coverageIdx).toBeGreaterThan(migrateIdx);
  });

  it("CC5: the gate step and the upload step both have names", () => {
    const gate = checkSteps.find((s) => s.run?.includes("bun run coverage:check"));
    const upload = checkSteps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(gate?.name).toBeTruthy();
    expect(upload?.name).toBeTruthy();
  });
});
