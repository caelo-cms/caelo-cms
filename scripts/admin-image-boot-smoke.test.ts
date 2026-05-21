// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #55 regression contract over `.github/workflows/ci.yml` and
 * `.github/rulesets/main.json`.
 *
 * #55 adds the `admin-prod-image` job — a complementary, cheaper gate
 * to release-images.yml (#54). release-images builds + publishes the
 * admin image; admin-prod-image builds it and `docker run`s it to
 * verify the SvelteKit + adapter-bun server actually boots. The bug
 * class #53 fixed (`Cannot find module "oxc-parser"`) succeeds at
 * Docker build time and only crashes on `docker run` — release-images
 * alone cannot catch it.
 *
 * Each assertion below is the load-bearing string contract that would
 * fire if one of those pieces were silently removed. C-numbers cover
 * the ci.yml job; R-numbers cover the ruleset JSON.
 *
 * C1: ci.yml parses cleanly as YAML. Defense in depth so a structurally
 *     broken workflow fails here, not at GitHub Actions upload time.
 * C2: A job keyed `admin-prod-image` exists; its `name:` is exactly
 *     `Admin production image — boot smoke`. The rendered name is the
 *     GitHub check context, so a rename silently drops the required-
 *     check binding in main.json.
 * C3: The job's `needs:` includes `lockfile`. Skipping the lockfile
 *     gate would mask a stale-bun.lock issue as a Docker boot issue.
 * C4: The job contains a `docker/build-push-action@v*` step with
 *     `file: apps/admin/Dockerfile`, `push: false`, `load: true`.
 *     Flipping `push:` to true would break fork PRs; dropping `load:`
 *     hides the image from `docker run`; building the wrong Dockerfile
 *     (e.g. gateway) would silently no-op.
 * C5: A step's `run:` body contains `docker run`, `--name smoke`, AND
 *     a curl-based polling loop (`while` + `curl`). A regression that
 *     drops the boot wait races the container start; replacing the
 *     curl poll with a bare `sleep` false-positives on slow boots.
 * C6: A step's `run:` body contains `docker logs smoke`. Removing
 *     the log dump makes future flakes opaque.
 * R1: The ruleset's required-status-checks list contains
 *     `Admin production image — boot smoke`. Removing it means a
 *     broken boot no longer blocks merge — AC #5 fails.
 * R2: The same list still contains the four pre-existing required
 *     contexts (`Lockfile freshness`, `Lint, Typecheck, Migrate,
 *     Test, License`, `build + push (admin)`, `build + push
 *     (gateway)`). Defense in depth against a hand-edit that adds
 *     ours but drops one of the existing checks.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/ci.yml");
const RULESET_PATH = resolve(REPO_ROOT, ".github/rulesets/main.json");

const JOB_KEY = "admin-prod-image";
const JOB_NAME = "Admin production image — boot smoke";

const workflowText = readFileSync(WORKFLOW_PATH, "utf8");

// ---------------------------------------------------------------------------
// Parsed-shape view of ci.yml.
//
// yaml.load returns `unknown`; cast to a minimal shape that names only
// the fields we read. A malformed file fails C1 at parse; a parseable-
// but-shape-broken file fails the per-field walk with a clear pointer.
// ---------------------------------------------------------------------------

interface WithBlock {
  readonly file?: string;
  readonly push?: boolean | string;
  readonly load?: boolean | string;
  readonly tags?: string;
}

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: WithBlock;
  readonly run?: string;
}

interface WorkflowJob {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDoc {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const workflowDoc = yaml.load(workflowText) as WorkflowDoc;
const job = workflowDoc.jobs[JOB_KEY];

function jobNeeds(j: WorkflowJob): readonly string[] {
  if (!j.needs) return [];
  return typeof j.needs === "string" ? [j.needs] : j.needs;
}

function runSteps(j: WorkflowJob): readonly WorkflowStep[] {
  return (j.steps ?? []).filter(
    (s): s is WorkflowStep & { run: string } => typeof s.run === "string",
  );
}

describe("ci.yml — issue #55 admin-prod-image boot-smoke contract", () => {
  it("C1: ci.yml parses cleanly as YAML", () => {
    // The cast above already invoked yaml.load; this assertion makes
    // the parse step explicit so a future reader sees the structural
    // check is intentional, not incidental.
    expect(() => yaml.load(workflowText)).not.toThrow();
    expect(workflowDoc.jobs).toBeDefined();
  });

  it(`C2: job \`${JOB_KEY}\` exists and its \`name:\` matches the required-check context`, () => {
    expect(job).toBeDefined();
    expect(job.name).toBe(JOB_NAME);
  });

  it("C3: job's `needs:` includes `lockfile`", () => {
    expect(jobNeeds(job)).toContain("lockfile");
  });

  it("C4: build step uses docker/build-push-action with file=admin Dockerfile, push=false, load=true", () => {
    const buildStep = (job.steps ?? []).find((s) =>
      s.uses?.startsWith("docker/build-push-action@"),
    );
    expect(buildStep).toBeDefined();
    if (!buildStep) return;
    expect(buildStep.with?.file).toBe("apps/admin/Dockerfile");
    // YAML literal `false` / `true` parse to booleans; an expression
    // like `${{ … }}` would land as a string. Pin the boolean shape
    // because that's the load-bearing semantics for this job.
    expect(buildStep.with?.push).toBe(false);
    expect(buildStep.with?.load).toBe(true);
  });

  it("C5: a `run:` step performs `docker run --name smoke` AND polls with `while` + `curl`", () => {
    const matching = runSteps(job).find(
      (s) =>
        s.run.includes("docker run") &&
        s.run.includes("--name smoke") &&
        /\bwhile\b/.test(s.run) &&
        /\bcurl\b/.test(s.run),
    );
    expect(
      matching,
      "expected a step that runs `docker run --name smoke` AND a while/curl polling loop",
    ).toBeDefined();
  });

  it("C6: failure-path log dump (`docker logs smoke`) is present in some `run:` body", () => {
    const matching = runSteps(job).find((s) => s.run.includes("docker logs smoke"));
    expect(
      matching,
      "expected `docker logs smoke` somewhere in the job's run blocks for failure-path debuggability",
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Ruleset contract — `.github/rulesets/main.json`.
// ---------------------------------------------------------------------------

interface RequiredStatusCheck {
  readonly context: string;
}

interface RulesetRule {
  readonly type: string;
  readonly parameters?: {
    readonly required_status_checks?: readonly RequiredStatusCheck[];
  };
}

interface Ruleset {
  readonly rules: readonly RulesetRule[];
}

function readRequiredCheckContexts(): ReadonlySet<string> {
  const r = JSON.parse(readFileSync(RULESET_PATH, "utf8")) as Ruleset;
  const rule = r.rules.find((x) => x.type === "required_status_checks");
  if (!rule) throw new Error("no `required_status_checks` rule in main-protection ruleset");
  const list = rule.parameters?.required_status_checks ?? [];
  return new Set(list.map((c) => c.context));
}

const contexts = readRequiredCheckContexts();

describe("main.json — required-status-checks contract (issue #55)", () => {
  it("R1: includes `Admin production image — boot smoke`", () => {
    expect(contexts.has(JOB_NAME)).toBe(true);
  });

  it("R2: retains the four pre-existing required contexts", () => {
    expect(contexts.has("Lockfile freshness")).toBe(true);
    expect(contexts.has("Lint, Typecheck, Migrate, Test, License")).toBe(true);
    expect(contexts.has("build + push (admin)")).toBe(true);
    expect(contexts.has("build + push (gateway)")).toBe(true);
  });
});
