// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #12 regression contract over the knip step in
 * `.github/workflows/ci.yml`.
 *
 * The knip config can be perfect, but if the CI step that runs it is
 * removed or reordered, the gate is a no-op — dead code merges silently.
 * This test parses the workflow and locks the step's presence, command,
 * and position, mirroring the YAML-shape approach in
 * `scripts/dependabot-config.test.ts`.
 *
 * CI1: the `check` job contains a step whose `run` invokes
 *      `bun run knip:strict`. Removing the step disables the gate.
 * CI2: the knip step sits AFTER `Lint` and BEFORE `Lockstep version
 *      check`. Ordering matters: knip needs the earlier
 *      `bun install` to have run, and a simpler lint error should
 *      surface before a knip finding (see Scope §6 in the plan).
 * CI3: the knip step has a human-readable `name` so its annotations are
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

describe("knip CI gate contract (issue #12)", () => {
  it("CI1: the check job runs `bun run knip:strict`", () => {
    const knipStep = checkSteps.find((s) => s.run?.includes("bun run knip:strict"));
    expect(knipStep, "no step in the `check` job runs `bun run knip:strict`").toBeDefined();
  });

  it("CI2: the knip step sits between Lint and Lockstep version check", () => {
    const lintIdx = stepIndex((s) => s.name === "Lint");
    const knipIdx = stepIndex((s) => Boolean(s.run?.includes("bun run knip:strict")));
    const lockstepIdx = stepIndex((s) => s.name === "Lockstep version check");

    expect(lintIdx).toBeGreaterThanOrEqual(0);
    expect(knipIdx).toBeGreaterThanOrEqual(0);
    expect(lockstepIdx).toBeGreaterThanOrEqual(0);
    expect(knipIdx).toBeGreaterThan(lintIdx);
    expect(knipIdx).toBeLessThan(lockstepIdx);
  });

  it("CI3: the knip step has a name", () => {
    const knipStep = checkSteps.find((s) => s.run?.includes("bun run knip:strict"));
    expect(knipStep?.name).toBeTruthy();
  });
});
