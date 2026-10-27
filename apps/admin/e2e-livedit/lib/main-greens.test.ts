// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { SCENARIOS, type ScenarioCoverage } from "../scenario-paths.js";
import {
  isUnmapped,
  MAX_GREEN_AGE_DAYS,
  type MainGreen,
  mainGreenFileName,
  mainGreensAfterRun,
  newestGreens,
  parseMainGreenName,
  planRelease,
  staleMainGreenNames,
  triggersScenario,
} from "./main-greens.js";
import { ciScenarios, planSummary, scenarioFiles } from "./plan.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ALL = ciScenarios().map((s) => s.id);
const scenario = (id: string): ScenarioCoverage => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (s === undefined) throw new Error(id);
  return s;
};

/** Every CI scenario green on `sha`, `age` days ago. */
const allGreen = (sha: string, age: number): Map<string, MainGreen> =>
  new Map(ALL.map((id) => [id, { id, at: daysAgo(age), sha, run: "1-1" }] as const));

describe("green record names", () => {
  it("round-trips scenario, time, commit and run", () => {
    const name = mainGreenFileName(
      "lists-mega-menu",
      new Date("2026-10-26T20:03:03.456Z"),
      SHA_A,
      "40392177029",
      "2",
    );
    expect(name).toBe(`lists-mega-menu_20261026T200303Z_${SHA_A}_40392177029-2.json`);
    expect(parseMainGreenName(name)).toEqual({
      id: "lists-mega-menu",
      at: new Date("2026-10-26T20:03:03Z"),
      sha: SHA_A,
      run: "40392177029-2",
    });
  });

  it("refuses to write a record it could not read back", () => {
    expect(() => mainGreenFileName("homepage", NOW, "not-a-sha", "1", "1")).toThrow();
    expect(() => mainGreenFileName("homepage", NOW, SHA_A, "x", "1")).toThrow();
  });

  it("ignores names that do not parse (they count as no record)", () => {
    for (const n of [
      "README.md",
      `homepage_20261026T200303Z_${SHA_A.slice(0, 7)}_1-1.json`,
      `homepage_2026-10-26_${SHA_A}_1-1.json`,
      `Homepage_20261026T200303Z_${SHA_A}_1-1.json`,
      `homepage_20261399T999999Z_${SHA_A}_1-1.json`,
    ]) {
      expect(parseMainGreenName(n), n).toBeNull();
    }
    expect(newestGreens(["README.md", "garbage.json"]).size).toBe(0);
  });

  it("keeps the newest record per scenario and prunes the rest", () => {
    const old = mainGreenFileName("homepage", daysAgo(3), SHA_A, "1", "1");
    const fresh = mainGreenFileName("homepage", daysAgo(1), SHA_B, "2", "1");
    const other = mainGreenFileName("consent", daysAgo(5), SHA_A, "1", "1");
    const names = [fresh, old, other, "README.md"];
    expect(newestGreens(names).get("homepage")?.sha).toBe(SHA_B);
    expect(staleMainGreenNames(names)).toEqual([old]);
  });
});

describe("triggersScenario", () => {
  const home = scenario("homepage");
  const consent = scenario("consent");

  it("a covered file triggers its scenario; the core takes every AI-relevant file", () => {
    expect(triggersScenario(consent, "packages/plugins/consent-manager/src/index.ts")).toBe(true);
    expect(triggersScenario(home, "packages/plugins/consent-manager/src/index.ts")).toBe(true);
    expect(triggersScenario(consent, "packages/admin-core/src/ai/system-prompt.ts")).toBe(false);
    expect(triggersScenario(home, "packages/admin-core/src/ai/system-prompt.ts")).toBe(true);
  });

  it("the scenario's own spec triggers it alone", () => {
    const spec = "apps/admin/e2e-livedit/scenario-consent.browser.ts";
    expect(triggersScenario(consent, spec)).toBe(true);
    expect(triggersScenario(home, spec)).toBe(false);
  });

  it("the harness triggers every scenario", () => {
    for (const s of ciScenarios()) {
      expect(triggersScenario(s, "apps/admin/e2e-livedit/helpers.ts"), s.id).toBe(true);
      expect(triggersScenario(s, ".github/workflows/e2e-livedit.yml"), s.id).toBe(true);
    }
  });

  it("NO_REAL_AI_COVERAGE files, tests and docs never trigger", () => {
    for (const f of [
      "packages/admin-core/src/ops/users.ts",
      // Also under the core's `apps/admin/src/lib/server/**`, but declared uncovered.
      "apps/admin/src/lib/server/step-up.ts",
      "packages/admin-core/src/ai/chat-runner/loop-budget-gate.test.ts",
      "docs/internal/e2e-livedit.md",
      "README.md",
    ]) {
      for (const s of ciScenarios()) expect(triggersScenario(s, f), `${s.id} ${f}`).toBe(false);
    }
  });
});

describe("planRelease", () => {
  const diffs = (files: readonly string[]) => new Map([[SHA_A, files]]);

  it("carries every scenario when nothing changed since its green", () => {
    const p = planRelease({ now: NOW, greens: allGreen(SHA_A, 1), diffs: diffs([]) });
    expect(p.mode).toBe("run");
    expect(p.run).toEqual([]);
    expect([...p.carried].sort()).toEqual([...ALL].sort());
    expect(p.full).toBe(false);
    expect(p.reason).toContain("every scenario carried over");
    expect(planSummary(p)).toContain(`green on ${SHA_A.slice(0, 7)}`);
  });

  it("runs only the scenarios whose covered files changed (plus the core)", () => {
    const p = planRelease({
      now: NOW,
      greens: allGreen(SHA_A, 1),
      diffs: diffs(["packages/plugins/consent-manager/src/index.ts", "docs/README.md"]),
    });
    expect([...p.run].sort()).toEqual(["consent", "homepage"]);
    expect(p.carried.length).toBe(ALL.length - 2);
    expect(scenarioFiles(p.run, p.full).split(",").sort()).toEqual([
      "scenario-consent.browser.ts",
      "scenario-homepage.browser.ts",
    ]);
    expect(p.reasons.find((r) => r.id === "consent")?.files).toEqual([
      "packages/plugins/consent-manager/src/index.ts",
    ]);
  });

  it("runs only the edited scenario when just its spec changed", () => {
    const p = planRelease({
      now: NOW,
      greens: allGreen(SHA_A, 1),
      diffs: diffs(["apps/admin/e2e-livedit/scenario-consent.browser.ts"]),
    });
    expect(p.run).toEqual(["consent"]);
  });

  it("runs everything on a harness change", () => {
    const p = planRelease({
      now: NOW,
      greens: allGreen(SHA_A, 1),
      diffs: diffs(["apps/admin/e2e-livedit/helpers.ts"]),
    });
    expect([...p.run].sort()).toEqual([...ALL].sort());
    expect(p.full).toBe(true);
    expect(scenarioFiles(p.run, p.full)).toBe("");
  });

  it("runs nothing for changes only to files no CI scenario covers", () => {
    const p = planRelease({
      now: NOW,
      greens: allGreen(SHA_A, 1),
      diffs: diffs([
        "packages/admin-core/src/ops/users.ts",
        "packages/provisioning/src/wizard.ts",
        "apps/admin/e2e-livedit/scenario-paths.ts",
      ]),
    });
    expect(p.run).toEqual([]);
  });

  it(`re-runs a green older than ${MAX_GREEN_AGE_DAYS} days even when nothing changed`, () => {
    const greens = allGreen(SHA_A, 1);
    greens.set("consent", {
      id: "consent",
      at: daysAgo(MAX_GREEN_AGE_DAYS + 0.01),
      sha: SHA_A,
      run: "1-1",
    });
    const p = planRelease({ now: NOW, greens, diffs: diffs([]) });
    expect(p.run).toEqual(["consent"]);
    expect(p.reasons[0]?.files[0]).toContain("older than 7 days");
    // Just inside the window still carries.
    greens.set("consent", {
      id: "consent",
      at: daysAgo(MAX_GREEN_AGE_DAYS - 0.01),
      sha: SHA_A,
      run: "1-1",
    });
    expect(planRelease({ now: NOW, greens, diffs: diffs([]) }).run).toEqual([]);
  });

  it("runs a scenario with no record, and one whose green commit cannot be diffed", () => {
    const greens = allGreen(SHA_A, 1);
    greens.delete("image-gen");
    greens.set("consent", { id: "consent", at: daysAgo(1), sha: SHA_B, run: "1-1" });
    const p = planRelease({
      now: NOW,
      greens,
      diffs: new Map<string, readonly string[] | null>([
        [SHA_A, []],
        [SHA_B, null],
      ]),
    });
    expect([...p.run].sort()).toEqual(["consent", "image-gen"]);
    // A commit missing from the diff map entirely is the same as unknown.
    const q = planRelease({ now: NOW, greens: allGreen(SHA_B, 1), diffs: diffs([]) });
    expect([...q.run].sort()).toEqual([...ALL].sort());
  });

  it("with no records at all runs the full suite", () => {
    const p = planRelease({ now: NOW, greens: new Map(), diffs: new Map() });
    expect(p.full).toBe(true);
    expect(p.run.length).toBe(ALL.length);
  });

  it("runs every scenario on an AI-relevant file no scenario maps", () => {
    // Synthetic manifest: the core's paths do not reach `ai/new-area.ts`, so
    // only its catch-all would — an unmapped file reruns everything.
    const scenarios: ScenarioCoverage[] = [
      { id: "homepage", file: "scenario-homepage.browser.ts", core: true, paths: ["x/**"] },
      { id: "consent", file: "scenario-consent.browser.ts", paths: ["y/**"] },
    ];
    const f = "packages/admin-core/src/ai/new-area.ts";
    expect(isUnmapped(f, scenarios)).toBe(true);
    expect(isUnmapped(f)).toBe(false);
    const greens = new Map(
      ["homepage", "consent"].map(
        (id) => [id, { id, at: daysAgo(1), sha: SHA_A, run: "1-1" }] as const,
      ),
    );
    const p = planRelease({ now: NOW, greens, diffs: diffs([f]), scenarios });
    expect([...p.run].sort()).toEqual(["consent", "homepage"]);
  });
});

describe("recording main greens", () => {
  it("records the scenarios this run ran and passed — not the carried ones", () => {
    const plan = planRelease({
      now: NOW,
      greens: allGreen(SHA_A, 1),
      diffs: diffs(["packages/plugins/consent-manager/src/index.ts"]),
    });
    const names = mainGreensAfterRun(
      plan,
      new Set(["scenario-consent.browser.ts", "scenario-ai-nested-cta.browser.ts"]),
      NOW,
      SHA_B,
      "7",
      "1",
    );
    expect(names).toEqual([mainGreenFileName("consent", NOW, SHA_B, "7", "1")]);
  });

  function diffs(files: readonly string[]) {
    return new Map([[SHA_A, files]]);
  }
});
