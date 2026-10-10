// SPDX-License-Identifier: MPL-2.0
/**
 * The release workflow re-runs the quality gate on the tagged commit, with
 * its own Postgres and env. When #613 added `gateway_role`, ci.yml got the
 * new role password and URL but release.yml did not, so v0.10.36's publish
 * failed in "Bootstrap databases" after the release PR had already merged.
 *
 * R1: every variable bootstrap.sh requires (`${VAR:?…}`) is set for the
 *     release gate's bootstrap step (job env or step env).
 * R2: every database role/URL variable ci.yml's `check` job sets is also
 *     set on the release gate job, so a suite added to CI can't find it
 *     missing at release time.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly name?: string;
  readonly env?: Record<string, unknown>;
}
interface Job {
  readonly env?: Record<string, unknown>;
  readonly steps?: Step[];
}
interface Workflow {
  readonly jobs: Record<string, Job>;
}

function workflow(file: string): Workflow {
  return yaml.load(readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8")) as Workflow;
}

const ROLE_VAR = /^(POSTGRES_(USER|PORT)|[A-Z]+_ROLE_PASSWORD|[A-Z_]+_DATABASE_URL)$/;

const gate = workflow("release.yml").jobs.gate;

describe("release gate env", () => {
  it("R1: sets every variable bootstrap.sh requires for its bootstrap step", () => {
    const script = readFileSync(resolve(REPO_ROOT, "packages/migrations/src/bootstrap.sh"), "utf8");
    const required = [...script.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    const step = gate?.steps?.find((s) => s.name === "Bootstrap databases");
    expect(step).toBeDefined();
    const available = new Set([...Object.keys(gate?.env ?? {}), ...Object.keys(step?.env ?? {})]);
    expect(required.filter((v) => !available.has(v as string))).toEqual([]);
  });

  it("R2: carries every database role variable ci.yml's check job sets", () => {
    const ciVars = Object.keys(workflow("ci.yml").jobs.check?.env ?? {}).filter((k) =>
      ROLE_VAR.test(k),
    );
    expect(ciVars.length).toBeGreaterThan(0);
    const gateVars = new Set(Object.keys(gate?.env ?? {}));
    expect(ciVars.filter((v) => !gateVars.has(v))).toEqual([]);
  });
});
