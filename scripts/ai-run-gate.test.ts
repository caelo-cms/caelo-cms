// SPDX-License-Identifier: MPL-2.0
/**
 * Contract for the AI-run cost gate of the security review: once the AI job
 * has succeeded on a PR, later commits to that PR skip it; a new or reopened
 * PR always runs. (The real-AI live-edit suite replaced this gate with
 * per-scenario selection and reuse — its contract is further down, L1–L8.)
 *
 * G1: a `prior-success` job exists with only `actions: read`.
 * G2: the AI job needs it and skips when it reports `passed == 'true'`.
 * G3: the gate only ever skips on `synchronize` (new commits), never on
 *     opened / reopened / ready_for_review or non-PR events.
 * G4: the gate looks for the AI job by its exact `name:` — a rename of the
 *     AI job without updating JOB_NAME would silently disable the gate.
 * G5: the gate requires the AI JOB's success, not just a green workflow
 *     (a workflow whose AI job was itself skipped is also "success").
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface Job {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly steps?: Step[];
}

const CASES = [{ file: "security-review.yml", aiJob: "security-review" }] as const;

for (const { file, aiJob } of CASES) {
  const wf = yaml.load(readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8")) as {
    jobs: Record<string, Job>;
  };
  const gate = wf.jobs["prior-success"];
  const ai = wf.jobs[aiJob];
  const step = gate?.steps?.find((s) => s.id === "check");

  describe(`${file} — AI run cost gate`, () => {
    it("G1: prior-success job with only actions: read", () => {
      expect(gate).toBeDefined();
      expect(gate?.permissions).toEqual({ actions: "read" });
    });

    it("G2: the AI job needs the gate and skips on passed == 'true'", () => {
      const needs = Array.isArray(ai?.needs) ? ai.needs : [ai?.needs];
      expect(needs).toContain("prior-success");
      expect(ai?.if ?? "").toContain("needs.prior-success.outputs.passed != 'true'");
    });

    it("G3: only `synchronize` can skip", () => {
      expect(step?.run ?? "").toContain(
        'if [ "$EVENT" != "pull_request" ] || [ "$ACTION" != "synchronize" ]; then',
      );
    });

    it("G4: JOB_NAME matches the AI job's name", () => {
      expect(step?.env?.JOB_NAME).toBe(ai?.name);
      expect(step?.env?.WORKFLOW_FILE).toBe(file);
    });

    it("G5: requires the AI job's own success, not just a green workflow", () => {
      expect(step?.run ?? "").toContain('.conclusion == \\"success\\"');
      expect(step?.run ?? "").toContain("/jobs?");
    });
  });
}

/**
 * Main coverage for the real-AI suite (2026-10-09): once per release instead
 * of per push.
 *
 * N1: e2e-livedit.yml has no push or schedule trigger (a squash merge re-ran
 *     what its PR already ran); workflow_dispatch stays for release-cut.
 * N2: release-cut's cut job gates on the AI job's success on HEAD before the
 *     release script runs, dispatching a run when there is none.
 * N4: a green run records the tree it tested (artifact named by the tree
 *     hash, written only on success), and release-cut reuses a run whose
 *     tree equals the released commit's tree instead of running again.
 */
describe("e2e-livedit.yml — main runs once per release, gated in release-cut", () => {
  const livedit = yaml.load(
    readFileSync(resolve(REPO_ROOT, ".github/workflows/e2e-livedit.yml"), "utf8"),
  ) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  const cut = yaml.load(
    readFileSync(resolve(REPO_ROOT, ".github/workflows/release-cut.yml"), "utf8"),
  ) as { jobs: Record<string, Job> };

  it("N1: PR and manual dispatch only; no push or schedule trigger", () => {
    expect(Object.keys(livedit.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
  });

  it("N2: release-cut gates on the AI job before the release script runs", () => {
    const steps = cut.jobs.cut?.steps ?? [];
    const gate = steps.findIndex((s) => (s.run ?? "").includes('gh workflow run "$WORKFLOW_FILE"'));
    // The bump itself; the earlier `--checks-only` run only validates the
    // release declaration (cheap) before the paid gate and changes nothing.
    const release = steps.findIndex(
      (s) =>
        (s.run ?? "").includes("scripts/release.ts") && !(s.run ?? "").includes("--checks-only"),
    );
    const checksOnly = steps.findIndex((s) => (s.run ?? "").includes("--checks-only"));
    expect(checksOnly).toBeLessThan(gate);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(release);
    const step = steps[gate];
    expect(step?.env?.WORKFLOW_FILE).toBe("e2e-livedit.yml");
    expect(step?.env?.JOB_NAME).toBe(livedit.jobs["e2e-livedit"]?.name);
    expect(step?.run ?? "").toContain("head_sha=$SHA");
    expect(step?.run ?? "").toContain('.conclusion == \\"success\\"');
  });

  it("N5: same-sha reuse needs the suite step's success, except on a release-gate run", () => {
    // A dispatch the weekly budget stopped inside the paid job ends with a
    // green AI job that ran nothing; it must never stand in for the gate.
    const step = (cut.jobs.cut?.steps ?? []).find((s) =>
      (s.run ?? "").includes('gh workflow run "$WORKFLOW_FILE"'),
    );
    const suite = (livedit.jobs["e2e-livedit"]?.steps ?? []).find((s) => s.id === "suite");
    expect(step?.env?.SUITE_STEP).toBe(suite?.name);
    const run = step?.run ?? "";
    expect(run).toContain('if [ "$branch" = "release-gate/$SHA" ]; then');
    expect(run).toContain(
      String.raw`select(.name == \"$SUITE_STEP\" and .conclusion == \"success\")`,
    );
  });

  it("N3: waits by polling run and AI-job status, not `gh run watch`", () => {
    // `gh run watch || true` returned on a transient HTTP 502 and the gate
    // read the still-running suite as failed (v0.10.54 cut).
    const steps = cut.jobs.cut?.steps ?? [];
    const run =
      steps.find((s) => (s.run ?? "").includes('gh workflow run "$WORKFLOW_FILE"'))?.run ?? "";
    expect(run).not.toContain("gh run watch");
    expect(run).toContain('[ "$run_state" = "completed" ] && [ "$job_state" = "completed" ]');
    expect(run).toContain('|| job_state="api-error"');
  });

  it("N4: a green run's tested tree is reused by release-cut for the same code", () => {
    const aiSteps = livedit.jobs["e2e-livedit"]?.steps ?? [];
    const record = aiSteps.find((s) => s.id === "green-tree");
    const upload = aiSteps.find(
      (s) => typeof s.with?.name === "string" && s.with.name.startsWith("e2e-livedit-green-tree-"),
    );
    // Only a run that executed EVERY CI scenario may stand in for main's
    // tree — a partial PR run proves nothing about the others, and a run the
    // budget stopped before the suite proves nothing at all.
    const fullAndRan =
      "success() && needs.plan.outputs.full == 'true' && steps.suite.outcome == 'success'";
    expect(record?.if).toBe(fullAndRan);
    expect(record?.run ?? "").toContain("git rev-parse 'HEAD^{tree}'");
    expect(upload?.if).toBe(fullAndRan);
    expect(upload?.with?.name).toBe("e2e-livedit-green-tree-${{ steps.green-tree.outputs.tree }}");
    // The marker is written after the bug gate, so a run with new detected
    // bugs never records its tree.
    const bugGate = aiSteps.findIndex((s) => (s.run ?? "").includes("bug-gate.ts"));
    expect(bugGate).toBeGreaterThanOrEqual(0);
    expect(aiSteps.indexOf(record as Step)).toBeGreaterThan(bugGate);

    const run =
      (cut.jobs.cut?.steps ?? []).find((s) =>
        (s.run ?? "").includes('gh workflow run "$WORKFLOW_FILE"'),
      )?.run ?? "";
    expect(run).toContain("TREE=$(git rev-parse 'HEAD^{tree}')");
    expect(run).toContain("actions/artifacts?name=e2e-livedit-green-tree-$TREE");
    expect(run).toContain("select(.expired == false)");
    // Only an e2e-livedit run whose AI job itself succeeded counts.
    expect(run).toContain('[ "$path" = ".github/workflows/$WORKFLOW_FILE" ] || continue');
    expect(run.indexOf("tree_job_ok)")).toBeLessThan(
      run.indexOf('gh workflow run "$WORKFLOW_FILE"'),
    );
  });
});

/**
 * The real-AI live-edit suite's cost controls (2026-10-27).
 *
 * L1: the paid job is skipped only on the plan's explicit `skip`; a failed or
 *     blocking plan RUNS it so its first step fails the required check (a
 *     skipped required check passes).
 * L2: that first step fails on a plan result other than success or a mode
 *     other than `run`.
 * L3: no workflow-level concurrency; the paid job serializes per PR without
 *     cancelling a run in flight.
 * L4: drafts do not run, ready_for_review does; adding a label starts a run;
 *     dispatch stays (release gate), with an `override_budget` input.
 * L5: the plan job waits for CI checks that exist in ci.yml under those names.
 * L6: the suite runs the planned specs, and per-scenario results are recorded
 *     only when the run-level bug gate passed.
 * L7: the weekly budget limits PR runs and manual dispatches — the release
 *     gate is decided before the budget is read, and a dispatch with
 *     `override_budget` too.
 * L8: a run whose commit is no longer the PR head cancels itself before any
 *     paid step.
 * L9: the paid job re-reads the budget right before its first paid step: the
 *     plan's reading predates the CI wait and the per-PR queue, and other
 *     PRs' runs can spend the rest of the week meanwhile. The same guard ends
 *     a release gate that carried every scenario over, green.
 * L10: PRs run Real-AI only with the label `real-ai` / `real-ai-full`; the
 *     plan reads the labels from the API and posts the opt-in comment.
 * L11: any other label keeps the commit's previous Real-AI verdict (waiting
 *     for one in flight, ignoring this run's own check): green or none →
 *     skip, anything else → blocked. A label must never turn red green.
 * L12: the release gate is a dispatch on release-gate/<its own sha>; it is
 *     planned from the main greens on the ledger branch and never waits for
 *     PR CI or the budget.
 * L13: every run that reached the provider records its spend in the ledger
 *     (no event filter); release gates and dispatches on main also record the
 *     scenarios they ran and passed, past the bug gate.
 */
describe("e2e-livedit.yml — plan, budget, CI wait, no cancelled paid runs", () => {
  const text = readFileSync(resolve(REPO_ROOT, ".github/workflows/e2e-livedit.yml"), "utf8");
  const wf = yaml.load(text) as {
    on: Record<string, { types?: string[] } | null>;
    concurrency?: unknown;
    jobs: Record<
      string,
      Job & { concurrency?: { group?: string; "cancel-in-progress"?: boolean } }
    >;
  };
  const plan = wf.jobs.plan;
  const ai = wf.jobs["e2e-livedit"];
  const aiSteps = ai?.steps ?? [];
  const planSteps = plan?.steps ?? [];
  const ci = yaml.load(readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, Job>;
  };
  const cut = yaml.load(
    readFileSync(resolve(REPO_ROOT, ".github/workflows/release-cut.yml"), "utf8"),
  ) as { jobs: Record<string, Job> };

  it("L1: skipped only on an explicit skip verdict", () => {
    expect(ai?.needs).toEqual(["plan"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(ai?.if).toBe("${{ !cancelled() && needs.plan.outputs.mode != 'skip' }}");
  });

  it("L2: the first step fails unless the plan succeeded with mode run", () => {
    const guard = aiSteps[0];
    expect(guard?.id).toBe("guard");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(guard?.env?.PLAN_RESULT).toBe("${{ needs.plan.result }}");
    expect(guard?.run ?? "").toContain('if [ "$PLAN_RESULT" != "success" ]; then');
    expect(guard?.run ?? "").toContain('if [ "$MODE" != "run" ]; then');
  });

  it("L3: a paid run in flight is never cancelled by a new push", () => {
    expect(wf.concurrency).toBeUndefined();
    expect(ai?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(ai?.concurrency?.group).toContain("github.event.pull_request.number");
  });

  it("L4: drafts wait for ready_for_review; dispatch stays", () => {
    expect(wf.on.pull_request?.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
      "labeled",
    ]);
    expect(Object.keys(wf.on)).toContain("workflow_dispatch");
    const dispatch = wf.on.workflow_dispatch as {
      inputs?: Record<string, { type?: string; default?: unknown }>;
    };
    expect(dispatch.inputs?.override_budget).toMatchObject({ type: "boolean", default: false });
    const verdict = planSteps.find((s) => s.id === "verdict")?.run ?? "";
    expect(verdict).toContain('[ "$DRAFT" = "true" ] && emit skip');
  });

  it("L5: waits for CI checks that exist under exactly those names", () => {
    const verdict = planSteps.find((s) => s.id === "verdict");
    const names = (verdict?.env?.WAIT_FOR ?? "").split("|");
    expect(names.length).toBeGreaterThanOrEqual(2);
    const ciNames = Object.values(ci.jobs).map((j) => j.name);
    for (const n of names) expect(ciNames, n).toContain(n);
    // A red CI check blocks (fails) instead of skipping.
    expect(verdict?.run ?? "").toContain('emit blocked "CI is red on this commit');
  });

  it("L6: runs the planned specs; records greens only past the bug gate", () => {
    const suite = aiSteps.find((s) => s.id === "suite");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(suite?.env?.CAELO_LIVEDIT_SCENARIOS).toBe("${{ needs.plan.outputs.scenarios }}");
    const record = aiSteps.find((s) => s.id === "greens");
    expect(record?.if).toBe(
      "always() && steps.suite.outcome != 'skipped' && steps.bug-gate.outcome == 'success'",
    );
    expect(aiSteps.findIndex((s) => s.id === "bug-gate")).toBeLessThan(
      aiSteps.findIndex((s) => s.id === "greens"),
    );
  });

  it("L7: the budget limits PR runs and manual dispatches, not the release gate", () => {
    const verdict = planSteps.find((s) => s.id === "verdict")?.run ?? "";
    const releaseRuns = verdict.indexOf('if [ "$KIND" = "release" ]; then');
    const overrideRuns = verdict.indexOf(
      'if [ "$KIND" = "dispatch" ] && [ "$OVERRIDE_BUDGET" = "true" ]; then',
    );
    const budgetRead = verdict.indexOf('jq -r .over "$OUT/budget.json"');
    const dispatchRuns = verdict.indexOf('if [ "$KIND" = "dispatch" ]; then emit run');
    expect(releaseRuns).toBeGreaterThan(0);
    expect(overrideRuns).toBeGreaterThan(releaseRuns);
    expect(budgetRead).toBeGreaterThan(overrideRuns);
    // A dispatch without the override runs only past the budget check.
    expect(dispatchRuns).toBeGreaterThan(budgetRead);
    const budget = planSteps.find((s) => s.id === "budget");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(budget?.env?.BUDGET_USD).toBe("${{ vars.E2E_LIVEDIT_WEEKLY_BUDGET_USD }}");
    expect(budget?.if ?? "").toContain("steps.kind.outputs.kind != 'release'");
    expect(budget?.if ?? "").not.toContain("pull_request");
  });

  it("L8: a superseded commit cancels its own run before the provider preflight", () => {
    const stale = aiSteps.findIndex((s) => s.id === "stale");
    const preflight = aiSteps.findIndex((s) => s.id === "provider-preflight");
    expect(stale).toBeGreaterThan(0);
    expect(stale).toBeLessThan(preflight);
    expect(aiSteps[stale]?.run ?? "").toContain('gh run cancel "$RUN_ID"');
  });

  it("L9: the paid job re-reads the budget right before its first paid step", () => {
    const guard = aiSteps.findIndex((s) => s.id === "paid");
    const preflight = aiSteps.findIndex((s) => s.id === "provider-preflight");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(preflight);
    const step = aiSteps[guard];
    expect(step?.if).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(step?.env?.BUDGET_USD).toBe("${{ vars.E2E_LIVEDIT_WEEKLY_BUDGET_USD }}");
    const run = step?.run ?? "";
    // Order: nothing to run → stop; release / override → exempt; else re-read.
    const carried = run.indexOf('if [ "$PAID" = "false" ]; then');
    const release = run.indexOf('if [ "$KIND" = "release" ]; then exit 0; fi');
    const override = run.indexOf(
      'if [ "$KIND" = "dispatch" ] && [ "$OVERRIDE_BUDGET" = "true" ]; then exit 0; fi',
    );
    const reread = run.indexOf("budget.ts spend");
    expect(carried).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(carried);
    expect(override).toBeGreaterThan(release);
    expect(reread).toBeGreaterThan(override);
    // Every step from the preflight to the suite stops on the guard; the
    // steps after it hang off the preflight's or the suite's outcome, so a
    // stopped run ends as a passing, annotated check.
    const suite = aiSteps.findIndex((s) => s.id === "suite");
    for (const s of aiSteps.slice(preflight, suite + 1)) {
      expect(s.if, s.name).toContain("steps.paid.outputs.stop != 'true'");
    }
    const tree = aiSteps.filter((s) => (s.name ?? "").includes("tested tree"));
    expect(tree.length).toBe(2);
    for (const s of tree) expect(s.if).toContain("steps.suite.outcome == 'success'");
  });

  it("L10: PRs run only with an opt-in label; the plan posts the opt-in comment", () => {
    const select = planSteps.find((s) => s.id === "select")?.run ?? "";
    expect(select).toContain('labels=$(jq -r \'[.labels[].name] | join(",")\' <<<"$pr")');
    expect(select).toContain('--labels "$labels"');
    expect(select).toContain('--comment "$OUT/opt-in-comment.md"');
    const verdict = planSteps.find((s) => s.id === "verdict")?.run ?? "";
    expect(verdict).toContain('sticky-comment.sh "$PR_NUMBER" "$OUT/opt-in-comment.md"');
    // The opt-in skip comes before the budget and the CI wait.
    expect(verdict.indexOf('if [ "$mode" = "skip" ]; then')).toBeLessThan(
      verdict.indexOf('jq -r .over "$OUT/budget.json"'),
    );
  });

  it("L11: an unrelated label keeps the commit's previous verdict", () => {
    const carry = planSteps.find((s) => s.id === "carry");
    expect(carry?.if ?? "").toContain("github.event.action == 'labeled'");
    expect(carry?.if ?? "").toContain("github.event.label.name != 'real-ai'");
    expect(carry?.if ?? "").toContain("github.event.label.name != 'real-ai-full'");
    expect(carry?.env?.JOB_NAME).toBe(ai?.name);
    const run = carry?.run ?? "";
    // This run's own check is not "the previous verdict".
    expect(run).toContain(String.raw`contains(\"/runs/$RUN_ID/\") | not`);
    // A check still in flight is waited for, not ignored.
    expect(run).toContain("'$2 != \"completed\"'");
    expect(run).toContain("success|skipped|neutral) verdict=skip");
    expect(run).toContain("*) verdict=blocked");
    // The carry decides before draft / selection, and blocked fails the check.
    const verdict = planSteps.find((s) => s.id === "verdict")?.run ?? "";
    expect(verdict.indexOf('[ -n "$CARRY" ] && emit "$CARRY"')).toBeLessThan(
      verdict.indexOf('[ "$DRAFT" = "true" ]'),
    );
    // The red run's comment (screenshots, errors) is not overwritten.
    const comment = aiSteps.find((s) => (s.name ?? "").startsWith("Push screenshots"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(comment?.env?.CARRY).toBe("${{ needs.plan.outputs.carry }}");
    expect(comment?.run ?? "").toContain('if [ -n "$CARRY" ]; then exit 0; fi');
    for (const id of ["select", "budget"]) {
      expect(planSteps.find((s) => s.id === id)?.if ?? "", id).toContain(
        "steps.carry.outputs.verdict == ''",
      );
    }
  });

  it("L12: the release gate is a dispatch on release-gate/<own sha>, planned from main greens", () => {
    const kind = planSteps.find((s) => s.id === "kind");
    expect(kind?.if).toBeUndefined();
    expect(kind?.run ?? "").toContain(
      'elif [ "$REF" = "refs/heads/release-gate/$SHA" ]; then kind="release"',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression we match against
    expect(kind?.env?.SHA).toBe("${{ github.sha }}");
    const select = planSteps.find((s) => s.id === "select")?.run ?? "";
    expect(select).toContain("contents/greens?ref=e2e-livedit-ledger");
    expect(select).toContain("main-greens.ts plan");
    // The release verdict is emitted before the budget and the PR CI wait.
    const verdict = planSteps.find((s) => s.id === "verdict")?.run ?? "";
    const release = verdict.indexOf('if [ "$KIND" = "release" ]; then');
    expect(release).toBeLessThan(verdict.indexOf("BUDGET_OUTCOME"));
    expect(release).toBeLessThan(verdict.indexOf("deadline="));
    expect(verdict.slice(release, release + 400)).toContain(
      'emit run "$reason" "$scenarios" "$full" "$paid"',
    );
    // release-cut dispatches on exactly that branch.
    const gate =
      (cut.jobs.cut?.steps ?? []).find((s) =>
        (s.run ?? "").includes('gh workflow run "$WORKFLOW_FILE"'),
      )?.run ?? "";
    expect(gate).toContain('gh workflow run "$WORKFLOW_FILE" --ref "release-gate/$SHA"');
  });

  it("L13: all spend reaches the ledger; main greens are recorded past the bug gate", () => {
    const cost = aiSteps.find((s) => s.name === "Record the run's cost in the budget ledger");
    expect(cost?.if).toBe("always() && steps.provider-preflight.outcome == 'success'");
    expect(cost?.run ?? "").toContain("ledger-commit.sh");
    const main = aiSteps.find((s) => s.id === "main-greens");
    expect(main?.if).toBe(
      "always() && steps.greens.outcome == 'success' && needs.plan.outputs.record_main == 'true'",
    );
    expect(main?.run ?? "").toContain("main-greens.ts record");
    expect(main?.run ?? "").toContain('--sha "$GITHUB_SHA"');
    expect(aiSteps.findIndex((s) => s.id === "greens")).toBeLessThan(aiSteps.indexOf(main as Step));
    const kind = planSteps.find((s) => s.id === "kind")?.run ?? "";
    expect(kind).toContain(
      'if [ "$kind" = "release" ] || { [ "$kind" = "dispatch" ] && [ "$REF" = "refs/heads/main" ]; }; then record_main=true; fi',
    );
  });
});
