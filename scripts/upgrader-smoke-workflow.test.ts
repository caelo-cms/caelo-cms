// SPDX-License-Identifier: MPL-2.0
/**
 * upgrader-smoke.yml (#818) exchanges a GitHub OIDC token for a Google
 * Cloud identity on the smoke project. These rules keep that exchange
 * narrow, the same way release-workflow-injection.test.ts does for
 * release.yml:
 *
 * S1: no `run:` script interpolates a `${{ … }}` expression; every value
 *     reaches the shell through `env:` (a candidate like `1.0.0-$(…)`
 *     would otherwise run as code).
 * S2: it cannot be started by a pull request (a fork's code must never
 *     reach the OIDC token): only `workflow_dispatch` and `workflow_call`.
 * S3: nothing holds a token by default; only the smoke job, inside the
 *     protected `upgrader-smoke` environment the WIF condition requires,
 *     may mint an OIDC token, and it can only read the repository.
 * S4: the job that decides `off` / `required` runs outside that
 *     environment with no token, so an `off` release never waits for an
 *     environment reviewer or touches GCP.
 * S5: release.yml calls it without passing secrets, with only the
 *     permissions it needs, and npm + the GitHub Release wait for it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly permissions?: Record<string, string>;
  readonly environment?: string;
  readonly needs?: readonly string[];
  readonly uses?: string;
  readonly secrets?: unknown;
  readonly steps?: Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

const load = (file: string) =>
  yaml.load(readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8")) as Workflow;

const smoke = load("upgrader-smoke.yml");
const release = load("release.yml");

describe("upgrader-smoke.yml", () => {
  it("S1: passes every expression to run scripts through env, never inline", () => {
    const inline: string[] = [];
    for (const [jobName, job] of Object.entries(smoke.jobs)) {
      for (const step of job.steps ?? []) {
        for (const expr of step.run?.match(/\$\{\{[^}]*\}\}/g) ?? []) {
          inline.push(`${jobName} / ${step.name}: ${expr}`);
        }
      }
    }
    expect(inline).toEqual([]);
  });

  it("S2: only a dispatch or release.yml can start it, never a pull request", () => {
    expect(Object.keys(smoke.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  });

  it("S3: only the smoke job, in the protected environment, may mint an OIDC token", () => {
    expect(smoke.permissions).toEqual({});
    for (const [jobName, job] of Object.entries(smoke.jobs)) {
      if (job.permissions?.["id-token"] === undefined) continue;
      expect({ jobName, environment: job.environment }).toEqual({
        jobName: "smoke",
        environment: "upgrader-smoke",
      });
    }
    expect(smoke.jobs.smoke?.permissions).toEqual({ contents: "read", "id-token": "write" });
    const checkout = smoke.jobs.smoke?.steps?.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("S4: the off/required decision runs without a token, outside the environment", () => {
    expect(smoke.jobs.decide?.permissions).toEqual({});
    expect(smoke.jobs.decide?.environment).toBeUndefined();
    expect(smoke.jobs.smoke?.needs).toEqual(["decide"]);
  });

  it("S5: release.yml calls it without secrets, and npm waits for it", () => {
    const call = release.jobs["upgrader-smoke"];
    expect(call?.uses).toBe("./.github/workflows/upgrader-smoke.yml");
    expect(call?.secrets).toBeUndefined();
    expect(call?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(release.jobs["publish-npm"]?.needs).toContain("upgrader-smoke");
  });
});
