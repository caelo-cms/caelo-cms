// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #54 regression contract over `.github/workflows/release-images.yml`
 * and `.github/rulesets/main.json`.
 *
 * #54 closes the gap that #53 exposed: a PR whose change breaks the
 * production admin Docker image used to pass CI because the only
 * workflow that exercises the lean production image runs on push to
 * `main` — i.e. after merge. The fix runs the workflow on PRs too,
 * gates the credential-touching steps so fork PRs (which carry no
 * secrets) skip the upload cleanly, and lists the two matrix jobs as
 * required status checks on `main-protection`.
 *
 * Each assertion below is the load-bearing string contract that would
 * fire if one of those pieces were silently removed. W-numbers cover
 * the workflow YAML; R-numbers cover the ruleset JSON. The numbering
 * tracks `.workflow-plan.md` § "Test strategy" Tier 1.
 *
 * W1: triggers include both `pull_request:` AND `merge_group:`. Drop
 *     `pull_request` and #53's bug class rides into main; drop
 *     `merge_group` and the gate silently skips the merge queue once
 *     #34 enables it.
 * W2: every credential-touching step name carries
 *     `github.event_name != 'pull_request'` in an `if:` clause. Drop
 *     the gate from any step and that step tries to use secrets the
 *     fork-PR runner doesn't carry — the whole job goes red even
 *     though the build succeeded.
 * W3: the `Build + push` step's `push:` parameter is the conditional
 *     expression. Flipping it to `true` makes fork PRs fail; flipping
 *     it to `false` stops post-merge publishing.
 * W4: top-level `concurrency:` block uses
 *     `github.event.pull_request.number || github.ref` for grouping
 *     and `github.event_name == 'pull_request'` for cancellation. A
 *     bare `true` on cancel-in-progress would let a follow-up commit
 *     to main cancel a release-bound build mid-flight.
 * W5: top-of-file comment block records that the workflow runs on
 *     PRs. Defense in depth — without the explanation the next
 *     maintainer may delete the trigger thinking it's accidental.
 * R1: ruleset's required-status-checks list includes both
 *     `build + push (admin)` and `build + push (gateway)`. Drop
 *     either and a broken Docker build no longer blocks merge.
 * R2: ruleset's required-status-checks list still includes
 *     `Lockfile freshness` and `Lint, Typecheck, Migrate, Test,
 *     License`. Defense in depth — a hand-edit that adds ours but
 *     drops one of the existing checks weakens the gate as a whole.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/release-images.yml");
const RULESET_PATH = resolve(REPO_ROOT, ".github/rulesets/main.json");

const workflow = readFileSync(WORKFLOW_PATH, "utf8");

const PR_GATE_TOKEN = "github.event_name != 'pull_request'";

/**
 * Names of every step that must NOT run on `pull_request` events. A
 * step rename forces a single-line edit here AND fails this test with
 * a pointer at the rename — much clearer than the rename quietly
 * dropping coverage. Order matches the workflow file top-to-bottom.
 */
const GATED_STEP_NAMES = [
  "Log in to GHCR",
  "Install cosign",
  "Sign image with cosign (keyless / OIDC)",
  "Verify the signed image (sanity check)",
  "Authenticate to GCP via Workload Identity Federation",
  "Configure docker for GCP AR push",
  "Mirror image (+ signatures) to GCP public AR",
] as const;

/**
 * Slice the body of a workflow step by its `name:` so per-step
 * assertions don't false-positive on unrelated text elsewhere. The
 * window runs from `- name: <name>` to the next `- name:` (or
 * end-of-file). Step bodies are short enough that this is unambiguous.
 */
function extractStepBody(src: string, name: string): string {
  const marker = `- name: ${name}`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`step \`${name}\` not found in workflow`);
  const next = src.indexOf("\n      - name:", start + marker.length);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

/**
 * Slice the top-level `on:` block (from `\non:\n` to the next
 * top-level key). The block is short and lives high in the file, so
 * a column-anchored start marker is enough.
 */
function extractOnBlock(src: string): string {
  const start = src.indexOf("\non:\n");
  if (start === -1) throw new Error("no top-level `on:` block in workflow");
  // The next top-level key starts at column 0 after a blank line. The
  // file's structure puts `permissions:` next, but key on the
  // `\n<word>:\n` shape so reordering doesn't break the test.
  const rest = src.slice(start + 1);
  const nextKey = rest.search(/\n[a-z_]+:\s*\n/);
  return nextKey === -1 ? rest : rest.slice(0, nextKey + 1);
}

/**
 * Slice the top-level `concurrency:` block. Same shape as
 * `extractOnBlock`. The workflow places `concurrency:` after
 * `permissions:` and before `env:`.
 */
function extractConcurrencyBlock(src: string): string {
  const start = src.indexOf("\nconcurrency:\n");
  if (start === -1) throw new Error("no top-level `concurrency:` block in workflow");
  const rest = src.slice(start + 1);
  const nextKey = rest.search(/\n[a-z_]+:\s*\n/);
  return nextKey === -1 ? rest : rest.slice(0, nextKey + 1);
}

/**
 * Slice the leading `#`-prefixed header comment (every line from the
 * top of the file up to the first non-comment, non-blank line).
 */
function extractHeaderComment(src: string): string {
  const lines = src.split("\n");
  const headerLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") {
      headerLines.push(line);
      continue;
    }
    break;
  }
  return headerLines.join("\n");
}

const onBlock = extractOnBlock(workflow);
const concurrencyBlock = extractConcurrencyBlock(workflow);
const headerComment = extractHeaderComment(workflow);

// ---------------------------------------------------------------------------
// Parsed-shape view (used by W0 + W6).
//
// `yaml.load` returns `unknown`; we cast to a minimal shape that names
// only the fields we actually read. A malformed file fails W0 at parse;
// a parseable-but-shape-broken file fails W6 with a clear TypeError
// pointing at the missing `jobs.build.steps` walk.
// ---------------------------------------------------------------------------

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
}

interface WorkflowDoc {
  readonly jobs: {
    readonly build: {
      readonly steps: readonly WorkflowStep[];
    };
  };
}

/**
 * Actions whose presence indicates the step needs registry / secret
 * credentials. A new entry here forces W6 to assert the gate on every
 * step that uses it — the right place to extend when AWS/Azure mirror
 * steps land (P15).
 */
const CREDENTIAL_ACTION_PREFIXES = [
  "docker/login-action",
  "sigstore/cosign-installer",
  "google-github-actions/auth",
] as const;

/**
 * A step "needs the gate" if it uses a known credential-providing
 * action, OR references `secrets.<NAME>` anywhere in its body. The
 * second case catches a future contributor adding an inline
 * `password: ${{ secrets.NEW_TOKEN }}` without using a known action.
 */
function stepNeedsGate(step: WorkflowStep): boolean {
  if (step.uses) {
    for (const prefix of CREDENTIAL_ACTION_PREFIXES) {
      if (step.uses.startsWith(prefix)) return true;
    }
  }
  // Re-serialize the step and scan for `secrets.<NAME>` refs anywhere
  // in its fields (with:, env:, run:, …). JSON.stringify is sufficient
  // — we don't need to introspect the structure, just text-search the
  // serialized body for the literal token.
  if (/secrets\.[A-Z_]+/.test(JSON.stringify(step))) return true;
  return false;
}

function collectCredentialSteps(doc: WorkflowDoc): readonly WorkflowStep[] {
  return doc.jobs.build.steps.filter(stepNeedsGate);
}

const workflowDoc = yaml.load(workflow) as WorkflowDoc;

describe("release-images.yml — issue #54 PR-gate contract", () => {
  it("W0: workflow YAML parses cleanly", () => {
    // Defense-in-depth: every other W-assertion is substring matching,
    // which can pass against a malformed YAML file whose corruption
    // doesn't touch the substrings we check. A YAML parse failure is
    // catastrophic at GitHub Actions load time, but we want it to fail
    // here too so a contributor sees the structural error before the
    // workflow ever uploads.
    expect(() => yaml.load(workflow)).not.toThrow();
  });

  it("W1: triggers include both `pull_request:` and `merge_group:`", () => {
    expect(onBlock).toMatch(/\n\s+pull_request:\s*\n/);
    expect(onBlock).toMatch(/\n\s+merge_group:\s*(\n|$)/);
  });

  it.each(
    GATED_STEP_NAMES.map((name) => [name]),
  )("W2: step `%s` carries `github.event_name != 'pull_request'` in an `if:`", (name) => {
    const body = extractStepBody(workflow, name);
    // The gate must appear inside an `if:` line specifically, not in
    // a comment or env-var. A literal `if:` substring followed (on
    // the same line) by the token is enough.
    const ifLineRegex = new RegExp(
      `\\bif:\\s.*${PR_GATE_TOKEN.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`,
    );
    expect(body).toMatch(ifLineRegex);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${{ ... }} is GitHub Actions expression syntax, not a JS template placeholder
  it("W3: `Build + push` step uses `push: ${{ github.event_name != 'pull_request' }}`", () => {
    const body = extractStepBody(workflow, "Build + push");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we're matching against
    expect(body).toContain("push: ${{ github.event_name != 'pull_request' }}");
    // And specifically does NOT carry the old unconditional `push: true`
    // or a regression to `push: false`.
    expect(body).not.toMatch(/\bpush:\s*true\b/);
    expect(body).not.toMatch(/\bpush:\s*false\b/);
  });

  it("W4: top-level `concurrency:` block groups by PR number / ref and cancels on PR events only", () => {
    // `group:` must reference both `github.event.pull_request.number`
    // and `github.ref` so PRs cluster by PR number and other events
    // (push to main, workflow_call, etc.) cluster by ref.
    expect(concurrencyBlock).toContain("github.event.pull_request.number");
    expect(concurrencyBlock).toContain("github.ref");
    // `cancel-in-progress:` must be the conditional expression — a
    // bare `true` would let a follow-up commit to main cancel a
    // release-bound build.
    expect(concurrencyBlock).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we're matching against
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(concurrencyBlock).not.toMatch(/cancel-in-progress:\s*true\s*$/m);
  });

  it("W5: header comment records the PR-trigger behaviour", () => {
    // Either the literal phrase "runs on PRs" or a mention of
    // `pull_request` in the header comment satisfies the assertion —
    // both phrasings convey the same intent to a future reader.
    const lowered = headerComment.toLowerCase();
    const mentionsPrs = lowered.includes("runs on prs") || lowered.includes("pull_request");
    expect(mentionsPrs).toBe(true);
  });

  // W6 — defense in depth against future credential-touching steps that
  // a contributor might add without the gate. W2 enumerates today's
  // steps by name; W6 parses the YAML and auto-flags any step that uses
  // a known credential-providing action OR references `secrets.<name>`
  // in any field, asserting the gate token is present in its `if:`.
  it("W6 (defense in depth): every credential-bearing step carries the PR gate", () => {
    const credentialSteps = collectCredentialSteps(workflowDoc);
    // Guard against a refactor that hides every step behind some
    // indirection and silently makes the assertion vacuously pass.
    expect(credentialSteps.length).toBeGreaterThan(0);
    for (const step of credentialSteps) {
      const label = step.name ?? step.uses ?? "(unnamed step)";
      const ifClause = step.if ?? "";
      expect(
        ifClause,
        `step \`${label}\` is credential-bearing but its \`if:\` does not contain the PR gate`,
      ).toContain(PR_GATE_TOKEN);
    }
  });
});

// ---------------------------------------------------------------------------
// Ruleset contract — `.github/rulesets/main.json`.
//
// The ruleset is JSON; parse it and walk to the
// required-status-checks list. Parsing once + asserting set membership
// is cleaner than substring matching the file text and immune to
// formatting changes (key ordering, whitespace).
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

function loadRuleset(): Ruleset {
  return JSON.parse(readFileSync(RULESET_PATH, "utf8")) as Ruleset;
}

function readRequiredCheckContexts(ruleset: Ruleset): ReadonlySet<string> {
  const rule = ruleset.rules.find((r) => r.type === "required_status_checks");
  if (!rule) throw new Error("no `required_status_checks` rule in main-protection ruleset");
  const list = rule.parameters?.required_status_checks ?? [];
  return new Set(list.map((c) => c.context));
}

const ruleset = loadRuleset();
const contexts = readRequiredCheckContexts(ruleset);

describe("main.json — required-status-checks contract (issue #54)", () => {
  it("R1: includes both `build + push (admin)` and `build + push (gateway)`", () => {
    expect(contexts.has("build + push (admin)")).toBe(true);
    expect(contexts.has("build + push (gateway)")).toBe(true);
  });

  it("R2: retains `Lockfile freshness` and `Lint, Typecheck, Migrate, Test, License`", () => {
    expect(contexts.has("Lockfile freshness")).toBe(true);
    expect(contexts.has("Lint, Typecheck, Migrate, Test, License")).toBe(true);
  });
});
