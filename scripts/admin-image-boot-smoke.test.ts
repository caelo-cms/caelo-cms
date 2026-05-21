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
 * C7: The build step's `tags:` pins `caelo-admin:smoke`. The next
 *     step references that exact tag; a rename without updating the
 *     `docker run` reference would break boot at runtime but not at
 *     build time. Catches that drift class.
 * C8: The build step's `cache-from` reads from BOTH
 *     `type=gha,scope=admin` (release-images' admin matrix cache)
 *     AND `type=gha,scope=admin-smoke` (our own scope). A regression
 *     that drops `scope=admin` triples cold-build time when our scope
 *     is empty; dropping `scope=admin-smoke` does the same on a fresh
 *     branch where release-images hasn't yet warmed `scope=admin`.
 * C9: The boot-smoke run block starts with `set -euo pipefail`.
 *     Without it, a failing curl, docker inspect, or docker logs
 *     silently exits 0 and passes the job. The hygiene token is the
 *     load-bearing guard for AC #2 (fails closed on errors).
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
  readonly "cache-from"?: string;
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

  it("C7: build step's `tags:` pins `caelo-admin:smoke` (must match the `docker run` reference)", () => {
    const buildStep = (job.steps ?? []).find((s) =>
      s.uses?.startsWith("docker/build-push-action@"),
    );
    expect(buildStep?.with?.tags).toBe("caelo-admin:smoke");
  });

  it("C8: build step's `cache-from` reads from BOTH release-images' admin cache AND our own scope", () => {
    const buildStep = (job.steps ?? []).find((s) =>
      s.uses?.startsWith("docker/build-push-action@"),
    );
    const cacheFrom = buildStep?.with?.["cache-from"];
    expect(typeof cacheFrom).toBe("string");
    if (typeof cacheFrom !== "string") return;
    // Multi-line `|` block scalar lands as `\n`-joined; split + trim so a
    // future formatter change (extra blank line, trailing spaces) doesn't
    // false-fail the contract. Each entry must be a distinct list item —
    // `scope=admin` is a substring of `scope=admin-smoke`, so a bare
    // toContain on the raw text would let a regression that drops the
    // shorter scope go undetected.
    const lines = cacheFrom
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines).toContain("type=gha,scope=admin");
    expect(lines).toContain("type=gha,scope=admin-smoke");
  });

  it("C9: boot-smoke run block starts with `set -euo pipefail`", () => {
    const bootStep = runSteps(job).find(
      (s) => s.run.includes("docker run") && s.run.includes("--name smoke"),
    );
    expect(bootStep).toBeDefined();
    if (!bootStep || typeof bootStep.run !== "string") return;
    // Match the first non-blank line so the assertion survives a future
    // leading blank line or comment.
    const firstNonBlank = bootStep.run
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    expect(firstNonBlank).toBe("set -euo pipefail");
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
