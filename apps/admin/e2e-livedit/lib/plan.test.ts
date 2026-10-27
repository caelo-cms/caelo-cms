// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AI_RELEVANT_PATHS,
  HARNESS_PATHS,
  NO_REAL_AI_COVERAGE,
  SCENARIOS,
} from "../scenario-paths.js";
import {
  ciScenarios,
  coversFile,
  FULL_SUITE_LABEL,
  greensAfterRun,
  isAiRelevant,
  isHarness,
  MAX_CLASSIFIABLE_FILES,
  OPT_IN_LABELS,
  optInComment,
  parseJobsTsv,
  passedSpecFiles,
  planRun,
  planSummary,
  type RunPlan,
  replanAfterWait,
  SELECTED_LABEL,
  SPEC_DIR,
  scenarioFiles,
  scenarioKeys,
  selectScenarios,
} from "./plan.js";

const ROOT = resolve(import.meta.dir, "../../../..");
const TRACKED = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const ids = (sel: { ids: readonly string[] }) => [...sel.ids].sort();

describe("scenario manifest", () => {
  it("lists every spec file exactly once, and nothing else", () => {
    const specs = readdirSync(join(ROOT, SPEC_DIR))
      .filter((f) => f.endsWith(".browser.ts"))
      .sort();
    expect(SCENARIOS.map((s) => s.file).sort()).toEqual(specs);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("has exactly one core scenario, and it runs in CI", () => {
    const core = SCENARIOS.filter((s) => s.core === true);
    expect(core.map((s) => s.id)).toEqual(["homepage"]);
    expect(core[0]?.optIn).toBeUndefined();
  });

  it("declares the opt-in flag each opt-in spec actually checks — and no CI spec skips on one", () => {
    for (const s of SCENARIOS) {
      const src = readFileSync(join(ROOT, SPEC_DIR, s.file), "utf8");
      if (s.optIn !== undefined) expect(src, s.file).toContain(`process.env.${s.optIn}`);
      else expect(src, s.file).not.toMatch(/process\.env\.CAELO_LIVE(DIT)?_[A-Z_]+ !== "1"/);
    }
  });

  it("maps every AI-relevant file to a scenario CI runs (or declares it uncovered)", () => {
    // A new AI area must be mapped to the scenario that exercises it in
    // scenario-paths.ts, or listed in NO_REAL_AI_COVERAGE on purpose — it
    // can never be skipped silently.
    const ci = ciScenarios();
    const uncovered = TRACKED.filter(isAiRelevant).filter((f) => !ci.some((s) => coversFile(s, f)));
    expect(uncovered).toEqual([]);
  });

  it("has no dead globs (each pattern matches a tracked file)", () => {
    const patterns = [
      ...AI_RELEVANT_PATHS,
      ...NO_REAL_AI_COVERAGE,
      ...HARNESS_PATHS,
      ...SCENARIOS.flatMap((s) => s.paths),
    ];
    const dead = [...new Set(patterns)].filter(
      (g) => !TRACKED.some((f) => new Bun.Glob(g).match(f)),
    );
    expect(dead).toEqual([]);
  });

  it("covers the areas the cost-cut brief names as AI-relevant", () => {
    for (const f of [
      "packages/admin-core/src/ai/system-prompt.ts",
      "packages/admin-core/src/ai/chat-runner/loop.ts",
      "packages/admin-core/src/ai/tools/build-page.ts",
      "packages/shared/src/ai-tools.ts",
      "packages/plugins/consent-manager/package.json",
      "packages/migrations/migrations/cms_admin/0356_lists_skill_guidance.sql",
    ]) {
      expect(TRACKED, f).toContain(f);
      expect(isAiRelevant(f), f).toBe(true);
    }
    expect(isHarness("apps/admin/e2e-livedit/lib/build-stats.ts")).toBe(true);
    expect(isHarness(".github/workflows/e2e-livedit.yml")).toBe(true);
  });
});

describe("selectScenarios", () => {
  it("runs nothing for docs, UI-only, CI, provisioning and test-only changes", () => {
    for (const changed of [
      ["docs/internal/e2e-livedit.md", "README.md"],
      ["apps/admin/src/routes/(authed)/settings/updates/+page.svelte"],
      [".github/workflows/ci.yml"],
      ["packages/provisioning/src/wizard.ts"],
      ["packages/admin-core/src/ai/chat-runner/loop-budget-gate.test.ts"],
      ["packages/admin-core/src/ops/users.ts"],
      ["apps/admin/e2e-livedit/scenario-paths.ts"],
    ]) {
      const sel = selectScenarios(changed);
      expect(sel.kind, changed.join(",")).toBe("skip");
      expect(sel.ids).toEqual([]);
    }
  });

  it("runs the core alone for an AI change no specific scenario covers", () => {
    const sel = selectScenarios(["packages/admin-core/src/ai/system-prompt.ts"]);
    expect(sel.kind).toBe("some");
    expect(ids(sel)).toEqual(["homepage"]);
  });

  it("adds the scenarios whose paths match", () => {
    expect(ids(selectScenarios(["packages/plugins/consent-manager/src/index.ts"]))).toEqual([
      "consent",
      "homepage",
    ]);
    expect(ids(selectScenarios(["packages/admin-core/src/ops/lists/lists.ts"]))).toEqual([
      "ai-layout-footer",
      "homepage",
      "lists-blog-categories",
      "lists-mega-menu",
    ]);
    expect(ids(selectScenarios(["packages/admin-core/src/ai/image-service.ts"]))).toEqual([
      "homepage",
      "image-gen",
    ]);
  });

  it("runs only the edited scenario when just its spec changed", () => {
    expect(ids(selectScenarios(["apps/admin/e2e-livedit/scenario-consent.browser.ts"]))).toEqual([
      "consent",
    ]);
  });

  it("runs the full suite for a harness change, the label, or an unclassifiable PR", () => {
    const all = ciScenarios()
      .map((s) => s.id)
      .sort();
    expect(ids(selectScenarios(["apps/admin/e2e-livedit/helpers.ts"]))).toEqual(all);
    expect(selectScenarios([".github/workflows/e2e-livedit.yml"]).kind).toBe("full");
    expect(selectScenarios(["README.md"], [FULL_SUITE_LABEL]).kind).toBe("full");
    const many = Array.from({ length: MAX_CLASSIFIABLE_FILES }, (_, i) => `docs/x${i}.md`);
    expect(selectScenarios(many).kind).toBe("full");
  });

  it("never selects an opt-in scenario", () => {
    const sel = selectScenarios(["packages/admin-core/src/ai/theme-guidance.ts"]);
    expect(sel.ids).not.toContain("consistency");
  });
});

describe("scenarioKeys", () => {
  const tree = new Map<string, string>([
    ["packages/admin-core/src/ai/system-prompt.ts", "a1"],
    ["packages/plugins/consent-manager/src/index.ts", "b1"],
    ["packages/admin-core/src/ai/image-service.ts", "c1"],
    ["apps/admin/e2e-livedit/helpers.ts", "h1"],
    ["apps/admin/e2e-livedit/scenario-consent.browser.ts", "s1"],
    ["docs/README.md", "d1"],
  ]);
  const consentChange = ["packages/plugins/consent-manager/src/index.ts"];
  const keys = scenarioKeys(tree, consentChange);
  const withBlob = (path: string, blob: string) => new Map([...tree, [path, blob]]);

  it("moves only the keys of scenarios that cover the re-edited file (and the core)", () => {
    const k = scenarioKeys(
      withBlob("packages/plugins/consent-manager/src/index.ts", "b2"),
      consentChange,
    );
    expect(k.get("consent")).not.toBe(keys.get("consent"));
    expect(k.get("homepage")).not.toBe(keys.get("homepage"));
    expect(k.get("image-gen")).toBe(keys.get("image-gen") as string);
  });

  it("moves a scenario's key when the PR also changes its spec", () => {
    const k = scenarioKeys(tree, [
      ...consentChange,
      "apps/admin/e2e-livedit/scenario-consent.browser.ts",
    ]);
    expect(k.get("consent")).not.toBe(keys.get("consent"));
    expect(k.get("image-gen")).toBe(keys.get("image-gen") as string);
  });

  it("ignores files the PR did not change — main moving on keeps every key", () => {
    // The tested tree changes (main merged a new system prompt), the PR's own
    // change does not.
    const k = scenarioKeys(
      withBlob("packages/admin-core/src/ai/system-prompt.ts", "a2"),
      consentChange,
    );
    for (const s of ciScenarios()) expect(k.get(s.id), s.id).toBe(keys.get(s.id) as string);
  });

  it("moves every key on a harness change and none on a docs change", () => {
    const harness = scenarioKeys(tree, [...consentChange, "apps/admin/e2e-livedit/helpers.ts"]);
    const docs = scenarioKeys(tree, [...consentChange, "docs/README.md"]);
    for (const s of ciScenarios()) {
      expect(harness.get(s.id), s.id).not.toBe(keys.get(s.id));
      expect(docs.get(s.id), s.id).toBe(keys.get(s.id) as string);
    }
  });

  it("tells a deleted file apart from an unchanged one", () => {
    const gone = new Map(
      [...tree].filter(([p]) => p !== "packages/plugins/consent-manager/src/index.ts"),
    );
    expect(scenarioKeys(gone, consentChange).get("consent")).not.toBe(keys.get("consent"));
  });
});

describe("planRun", () => {
  const keys = new Map(ciScenarios().map((s) => [s.id, `k-${s.id}`] as const));
  const consent = ["packages/plugins/consent-manager/src/index.ts"];
  const labels = [SELECTED_LABEL];

  it("runs what the selection picked when nothing is green yet", () => {
    const p = planRun({ mode: "pr", changed: consent, labels, keys, greens: [] });
    expect(p.mode).toBe("run");
    expect([...p.run].sort()).toEqual(["consent", "homepage"]);
    expect(p.full).toBe(false);
  });

  it("keeps a scenario green on identical inputs and reruns the rest", () => {
    const p = planRun({
      mode: "pr",
      changed: consent,
      labels,
      keys,
      greens: [
        { id: "homepage", key: "k-homepage" },
        { id: "consent", key: "stale-key" },
      ],
    });
    expect(p.run).toEqual(["consent"]);
    expect(p.carried).toEqual(["homepage"]);
  });

  it("skips (passing) when every selected scenario is already green", () => {
    const p = planRun({
      mode: "pr",
      changed: consent,
      labels,
      keys,
      greens: [
        { id: "homepage", key: "k-homepage" },
        { id: "consent", key: "k-consent" },
      ],
    });
    expect(p.mode).toBe("skip");
    expect(p.reason).toContain("already passed");
  });

  it("runs the full suite on a manual dispatch, reusing nothing", () => {
    const p = planRun({
      mode: "full",
      changed: [],
      keys,
      greens: [{ id: "homepage", key: "k-homepage" }],
    });
    expect(p.mode).toBe("run");
    expect(p.full).toBe(true);
    expect(p.carried).toEqual([]);
    expect(p.run.length).toBe(ciScenarios().length);
    expect(scenarioFiles(p.run, p.full)).toBe("");
  });

  it("runs nothing on a PR without an opt-in label, and says what would run", () => {
    const p = planRun({
      mode: "pr",
      changed: consent,
      keys,
      greens: [{ id: "homepage", key: "k-homepage" }],
    });
    expect(p.mode).toBe("skip");
    expect(p.run).toEqual([]);
    expect(p.wouldRun).toEqual(["consent"]);
    expect(p.reason).toContain("`real-ai`");
    expect(planSummary(p)).toContain("Would run: `consent`");
    const comment = optInComment(p) ?? "";
    expect(comment.startsWith("<!-- e2e-livedit-sticky -->")).toBe(true);
    expect(comment).toContain("`consent`");
    for (const l of OPT_IN_LABELS) expect(comment).toContain(`\`${l}\``);
    // An unrelated label opts nothing in.
    expect(planRun({ mode: "pr", changed: consent, labels: ["bug"], keys, greens: [] }).mode).toBe(
      "skip",
    );
  });

  it("posts no opt-in comment when nothing would run anyway", () => {
    const docs = planRun({ mode: "pr", changed: ["README.md"], keys, greens: [] });
    expect(docs.mode).toBe("skip");
    expect(optInComment(docs)).toBeNull();
    const allGreen = planRun({
      mode: "pr",
      changed: consent,
      keys,
      greens: [
        { id: "homepage", key: "k-homepage" },
        { id: "consent", key: "k-consent" },
      ],
    });
    expect(allGreen.reason).toContain("already passed");
    expect(optInComment(allGreen)).toBeNull();
  });

  it("`real-ai` runs the selection, `real-ai-full` every scenario", () => {
    const sel = planRun({ mode: "pr", changed: consent, labels: ["real-ai"], keys, greens: [] });
    expect([...sel.run].sort()).toEqual(["consent", "homepage"]);
    const full = planRun({
      mode: "pr",
      changed: consent,
      labels: [FULL_SUITE_LABEL],
      keys,
      greens: [],
    });
    expect(full.full).toBe(true);
    expect(full.run.length).toBe(ciScenarios().length);
  });

  it("names the spec files of a partial run", () => {
    const p = planRun({ mode: "pr", changed: consent, labels, keys, greens: [] });
    expect(scenarioFiles(p.run, p.full).split(",").sort()).toEqual([
      "scenario-consent.browser.ts",
      "scenario-homepage.browser.ts",
    ]);
    expect(planSummary(p)).toContain("`consent`");
  });
});

describe("recording greens", () => {
  const report = JSON.stringify({
    suites: [
      {
        file: "scenario-consent.browser.ts",
        specs: [{ tests: [{ status: "expected" }] }],
      },
      {
        file: "scenario-homepage.browser.ts",
        suites: [{ specs: [{ tests: [{ status: "unexpected" }] }] }],
      },
      {
        file: "scenario-image-gen.browser.ts",
        suites: [{ specs: [{ tests: [{ status: "skipped" }] }] }],
      },
    ],
  });

  it("counts a spec green only when every test in it passed (skipped is not green)", () => {
    expect([...passedSpecFiles(report)]).toEqual(["scenario-consent.browser.ts"]);
  });

  it("records the passed scenarios plus the carried ones, with their keys", () => {
    const greens = greensAfterRun(
      {
        mode: "run",
        reason: "x",
        full: false,
        run: ["consent", "homepage", "image-gen"],
        carried: ["lists-mega-menu"],
        reasons: [],
        keys: { consent: "kc", homepage: "kh", "image-gen": "ki", "lists-mega-menu": "km" },
      },
      passedSpecFiles(report),
    );
    expect(greens).toEqual([
      { id: "consent", key: "kc" },
      { id: "lists-mega-menu", key: "km" },
    ]);
  });
});

describe("replanAfterWait (two runs planned the same commit)", () => {
  const keys = { homepage: "kh", consent: "kc", "lists-mega-menu": "km" };
  // Run 2 planned while run 1 was still in flight: run 1 is not consulted.
  const plan: RunPlan = {
    mode: "run",
    reason: "label `real-ai-full`",
    full: true,
    run: ["homepage", "consent", "lists-mega-menu"],
    carried: [],
    reasons: [],
    keys,
    consultedRuns: [100],
  };
  const done = (runId: number, conclusion: string) => ({ runId, status: "completed", conclusion });

  it("carries every scenario the earlier run passed; nothing left is stop", () => {
    const v = replanAfterWait({
      plan,
      jobs: [done(1, "success")],
      greens: [
        { id: "homepage", key: "kh" },
        { id: "consent", key: "kc" },
        { id: "lists-mega-menu", key: "km" },
      ],
    });
    expect(v.verdict).toBe("stop");
    expect(v.plan.run).toEqual([]);
    expect([...v.plan.carried].sort()).toEqual(["consent", "homepage", "lists-mega-menu"]);
    expect(v.plan.full).toBe(false);
    expect(v.reason).toContain("run 1");
    // The carried ones are re-recorded green with their keys.
    expect(greensAfterRun(v.plan, new Set()).length).toBe(3);
  });

  it("runs only the rest when the earlier run covered a subset", () => {
    const v = replanAfterWait({
      plan,
      jobs: [done(1, "success")],
      greens: [
        { id: "homepage", key: "kh" },
        { id: "consent", key: "other-key" },
      ],
    });
    expect(v.verdict).toBe("run");
    expect(v.dropped).toEqual(["homepage"]);
    expect(v.plan.run).toEqual(["consent", "lists-mega-menu"]);
    // A narrowed run never stands in for main's tree.
    expect(v.plan.full).toBe(false);
    expect(scenarioFiles(v.plan.run, v.plan.full)).not.toBe("");
  });

  it("a red earlier run blocks — its failures are not re-rolled green", () => {
    for (const conclusion of ["failure", "timed_out", "action_required"]) {
      const v = replanAfterWait({
        plan,
        jobs: [done(1, conclusion)],
        // Even with the scenarios it did pass recorded green.
        greens: [
          { id: "homepage", key: "kh" },
          { id: "consent", key: "kc" },
        ],
      });
      expect(v.verdict, conclusion).toBe("blocked");
      expect(v.reason).toContain(`run 1 on this commit ended '${conclusion}'`);
      expect(v.plan).toBe(plan);
    }
    // One green and one red run: red wins.
    const mixed = replanAfterWait({
      plan,
      jobs: [done(1, "success"), done(2, "failure")],
      greens: [{ id: "homepage", key: "kh" }],
    });
    expect(mixed.verdict).toBe("blocked");
  });

  it("runs the consulted the plan already saw are not news (a deliberate re-request stays)", () => {
    const v = replanAfterWait({
      plan,
      jobs: [done(100, "failure")],
      greens: [{ id: "homepage", key: "kh" }],
    });
    expect(v.verdict).toBe("run");
    expect(v.plan).toBe(plan);
  });

  it("ignores cancelled, skipped and unfinished jobs, and greens without a fresh green run", () => {
    const greens = [{ id: "homepage", key: "kh" }];
    for (const job of [
      done(1, "cancelled"),
      done(1, "skipped"),
      { runId: 1, status: "in_progress", conclusion: "" },
    ]) {
      const v = replanAfterWait({ plan, jobs: [job], greens });
      expect(v.verdict, JSON.stringify(job)).toBe("run");
      expect(v.dropped).toEqual([]);
      expect(v.plan).toBe(plan);
    }
  });

  it("parses the workflow's job listing", () => {
    expect(
      parseJobsTsv("1\tcompleted\tsuccess\n2\tin_progress\t\n\nx\tcompleted\tfailure\n"),
    ).toEqual([
      { runId: 1, status: "completed", conclusion: "success" },
      { runId: 2, status: "in_progress", conclusion: "" },
    ]);
  });
});
