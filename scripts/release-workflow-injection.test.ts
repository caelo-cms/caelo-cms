// SPDX-License-Identifier: MPL-2.0
/**
 * release.yml runs with `contents: write` + `id-token: write` (npm Trusted
 * Publishing, the signed release manifest). An expression interpolated into
 * a `run:` script is pasted into the shell source before bash parses it, so
 * a tag (or `workflow_dispatch` input) like `v1.0.0-$(curl…|sh)` — a valid
 * git ref name — would run as code; so would any step output derived from
 * it (the version, the npm dist-tag). PR #888: every such value reaches a
 * script through `env:`, where the shell only ever sees it as data.
 *
 * R1: no `run:` script in release.yml contains a `${{ … }}` expression other
 *     than the static `matrix.package` list.
 * R2: the jobs that run the dependency tree's code without publishing
 *     (gate, verify-published) hold a read-only token.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly name?: string;
  readonly run?: string;
}
interface Job {
  readonly permissions?: Record<string, string>;
  readonly steps?: Step[];
}
interface Workflow {
  readonly jobs: Record<string, Job>;
}

const release = yaml.load(
  readFileSync(resolve(REPO_ROOT, ".github/workflows/release.yml"), "utf8"),
) as Workflow;

/** `matrix.package` comes from the literal list in the workflow itself. */
const STATIC_EXPRESSION = /^\$\{\{\s*matrix\.package\s*\}\}$/;

describe("release.yml", () => {
  it("R1: passes every expression to run scripts through env, never inline", () => {
    const inline: string[] = [];
    for (const [jobName, job] of Object.entries(release.jobs)) {
      for (const step of job.steps ?? []) {
        for (const expr of step.run?.match(/\$\{\{[^}]*\}\}/g) ?? []) {
          if (!STATIC_EXPRESSION.test(expr)) inline.push(`${jobName} / ${step.name}: ${expr}`);
        }
      }
    }
    expect(inline).toEqual([]);
  });

  it("R2: gate and verify-published run with a read-only token", () => {
    // The gate also reads the parent's ci.yml result (its scope step).
    expect(release.jobs.gate?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(release.jobs["verify-published"]?.permissions).toEqual({ contents: "read" });
  });
});
