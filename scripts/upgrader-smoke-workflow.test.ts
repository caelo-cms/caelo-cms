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
 * S6: `off` lets a release through (warning) but refuses a manual run. The
 *     decision reads the `invoked_by` input, never github.event_name: a
 *     called workflow sees the caller's event, and release.yml runs on
 *     workflow_dispatch, so the event name failed v0.10.56's release.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly id?: string;
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

  it("S6: `off` passes a release, refuses a manual run, and never reads the event name", () => {
    const step = smoke.jobs.decide?.steps?.find((st) => st.id === "mode");
    const script = step?.run ?? "";
    expect(script).not.toContain("EVENT");
    const decide = (env: Record<string, string>) => {
      const dir = mkdtempSync(resolve(tmpdir(), "smoke-decide-"));
      const out = resolve(dir, "out");
      try {
        const r = spawnSync("bash", ["-c", script], {
          env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, CANDIDATE: "0.10.57", ...env },
          encoding: "utf8",
        });
        const output = r.status === 0 ? readFileSync(out, "utf8") : "";
        return { status: r.status, output };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(decide({ MODE: "off", INVOKED_BY: "release" })).toEqual({
      status: 0,
      output: "run=false\n",
    });
    expect(decide({ MODE: "off", INVOKED_BY: "dispatch" }).status).toBe(1);
    expect(decide({ MODE: "required", INVOKED_BY: "release" })).toEqual({
      status: 0,
      output: "run=true\n",
    });
    expect(decide({ MODE: "", INVOKED_BY: "release" }).status).toBe(1);
    // release.yml relies on the default: it must not pass a different value.
    const call = release.jobs["upgrader-smoke"] as Job & { with?: Record<string, unknown> };
    expect(call.with?.invoked_by ?? "release").toBe("release");
  });
});
