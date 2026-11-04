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
 * Since the suite is sharded (four `test` jobs, each with its own database,
 * each running `coverage:check --shard <i>/4`; `check` unites them with
 * `coverage:check --merge`):
 *
 * CC1: every test shard runs `bun run coverage:check --shard`, one per matrix
 *      entry, and `check` runs `bun run coverage:check --merge`. Removing
 *      either disables enforcement (AC #1 "runs in CI" + AC #2 "enforced").
 * CC2: no bare `bun test --isolate` step remains in either job — the gate
 *      replaced it, so the suite isn't run twice (once gated, once not).
 * CC3: the shards upload their data and `check` uploads `coverage/`, each
 *      with `if: always()`, so the report lands even when the gate fails
 *      (AC #3).
 * CC4: a shard's tests run AFTER `Run migrations` — the integration tier
 *      needs the real schema in place.
 * CC5: the gate steps and the upload steps have human-readable names.
 * CC6: `check` needs every shard and the static gates, runs even when one
 *      failed (`if: always()`), and fails unless all of them succeeded — a
 *      skipped required check would read as passing.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

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
type Job = {
  needs?: string | string[];
  if?: string;
  strategy?: { matrix?: { shard?: unknown[] } };
  steps?: ReadonlyArray<Step>;
};
const jobs = (workflow as { jobs?: Record<string, Job> }).jobs ?? {};
const testSteps = jobs.test?.steps ?? [];
const checkSteps = jobs.check?.steps ?? [];
const indexIn = (steps: ReadonlyArray<Step>, predicate: (s: Step) => boolean): number =>
  steps.findIndex(predicate);

describe("coverage CI gate contract (issue #14)", () => {
  it("CC1: each test shard runs `coverage:check --shard`; check runs `--merge`", () => {
    const shards = jobs.test?.strategy?.matrix?.shard ?? [];
    expect(shards.length).toBeGreaterThan(1);
    const shardStep = testSteps.find((s) => s.run?.includes("bun run coverage:check --shard"));
    expect(shardStep?.run).toContain(`/${shards.length}`);
    expect(checkSteps.find((s) => s.run?.includes("bun run coverage:check --merge"))).toBeDefined();
  });

  it("CC2: no bare `bun test --isolate` step remains", () => {
    for (const steps of [testSteps, checkSteps]) {
      const bare = steps.find(
        (s) => s.run?.includes("bun test --isolate") && !s.run?.includes("coverage:check"),
      );
      expect(
        bare,
        "the gate should have replaced the bare `bun test --isolate` step",
      ).toBeUndefined();
    }
  });

  it("CC3: shard data and the coverage report are uploaded with if: always()", () => {
    for (const steps of [testSteps, checkSteps]) {
      const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
      expect(upload, "no actions/upload-artifact step").toBeDefined();
      expect(upload?.if).toBe("always()");
      expect(String(upload?.with?.path)).toContain("coverage");
    }
  });

  it("CC4: a shard's tests run after migrations (integration tier needs the schema)", () => {
    const migrateIdx = indexIn(testSteps, (s) => Boolean(s.run?.includes("bun run db:migrate")));
    const coverageIdx = indexIn(testSteps, (s) =>
      Boolean(s.run?.includes("bun run coverage:check")),
    );
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(coverageIdx).toBeGreaterThan(migrateIdx);
  });

  it("CC5: the gate steps and the upload steps have names", () => {
    for (const steps of [testSteps, checkSteps]) {
      expect(steps.find((s) => s.run?.includes("bun run coverage:check"))?.name).toBeTruthy();
      expect(steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))?.name).toBeTruthy();
    }
  });

  it("CC6: check needs lint and every shard, always runs, and fails unless both succeeded", () => {
    const needs = jobs.check?.needs;
    expect(Array.isArray(needs) ? [...needs].sort() : needs).toEqual(["lint", "test"]);
    expect(jobs.check?.if).toBe("always()");
    const first = checkSteps[0];
    expect(first?.run).toContain('test "$LINT" = success');
    expect(first?.run).toContain('test "$TEST" = success');
  });
});
