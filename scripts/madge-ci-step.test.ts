// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #13 regression contract over the madge step in
 * `.github/workflows/ci.yml`.
 *
 * The `.madgerc` config can be perfect, but if the CI step that runs
 * `bun run circular` is removed or reordered, the gate is a no-op —
 * a new circular dependency merges silently. This test parses the
 * workflow and locks the step's presence, command, and position,
 * mirroring `scripts/knip-ci-step.test.ts`.
 *
 * CC1: the `check` job contains a step whose `run` invokes
 *      `bun run circular`. Removing the step disables the gate.
 * CC2: the madge step sits AFTER `Knip (dead-code gate)` and BEFORE
 *      `Lockstep version check`. Both are fast static gates that need
 *      only the earlier `bun install`; keeping them adjacent groups
 *      the dead-code and cycle gates. Co-exists with the knip step's
 *      own ordering contract (Lint < knip < Lockstep).
 * CC3: the madge step has a human-readable `name` so its output is
 *      findable in the Actions log.
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
};

type Workflow = {
  jobs?: Record<string, { steps?: ReadonlyArray<Step> }>;
};

const workflow = yaml.load(RAW) as Workflow;
const checkSteps = workflow.jobs?.check?.steps ?? [];
const stepIndex = (predicate: (s: Step) => boolean): number => checkSteps.findIndex(predicate);

const MADGE_STEP_NAME = "Circular dependencies (madge)";

describe("madge CI gate contract (issue #13)", () => {
  it("CC1: the check job runs `bun run circular`", () => {
    const madgeStep = checkSteps.find((s) => s.run?.includes("bun run circular"));
    expect(madgeStep, "no step in the `check` job runs `bun run circular`").toBeDefined();
  });

  it("CC2: the madge step sits between Knip and Lockstep version check", () => {
    const knipIdx = stepIndex((s) => Boolean(s.run?.includes("bun run knip:strict")));
    const madgeIdx = stepIndex((s) => Boolean(s.run?.includes("bun run circular")));
    const lockstepIdx = stepIndex((s) => s.name === "Lockstep version check");

    expect(knipIdx).toBeGreaterThanOrEqual(0);
    expect(madgeIdx).toBeGreaterThanOrEqual(0);
    expect(lockstepIdx).toBeGreaterThanOrEqual(0);
    expect(madgeIdx).toBeGreaterThan(knipIdx);
    expect(madgeIdx).toBeLessThan(lockstepIdx);
  });

  it("CC3: the madge step has the expected name", () => {
    const madgeStep = checkSteps.find((s) => s.run?.includes("bun run circular"));
    expect(madgeStep?.name).toBe(MADGE_STEP_NAME);
  });
});
