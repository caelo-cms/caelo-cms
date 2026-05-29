// SPDX-License-Identifier: MPL-2.0

/**
 * Coverage gate (issue #14) — operationalises CLAUDE.md §6's "Coverage gates in
 * CI: unit ≥ 90%, integration ≥ 80% of declared Query API ops".
 *
 * Two tiers, two metrics:
 *   - **Unit** — `*.test.ts` minus `*.integration.test.ts`. Metric: pooled lcov
 *     line-coverage % from `bun test --coverage`.
 *   - **Integration** — `*.integration.test.ts`. Metric: op-coverage =
 *     (declared Query API ops exercised) ÷ (declared ops). The integration pass
 *     runs with `CAELO_OP_COVERAGE=1`, so `defineOperation` appends each
 *     exercised op name to `coverage/op-coverage.jsonl`; declared ops come from
 *     `registerAdminOps(new OperationRegistry()).names()`.
 *
 * Enforcement is a **ratchet floor**, not the 90/80 target: floors live in
 * `scripts/coverage-thresholds.json`, seeded from the CI-observed baseline with
 * a downward margin so the build is green at merge and a human raises the floor
 * as coverage improves. The gate exits non-zero when a tier is below its floor;
 * a tier with no measurable data fails loud (CLAUDE.md §2 — no silent
 * fallbacks). A summary lands at `coverage/coverage-summary.json` for the CI
 * artifact, written even when the gate fails.
 *
 * The pure helpers (`parseLcovLinePct`, `loadOpCoverageSet`,
 * `computeOpCoveragePct`, `evaluateTier`, `loadThresholds`) are exported for
 * unit testing; the orchestration runs only under `import.meta.main`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COVERAGE_DIR = join(REPO_ROOT, "coverage");
const OP_COVERAGE_FILE = join(COVERAGE_DIR, "op-coverage.jsonl");
const SUMMARY_FILE = join(COVERAGE_DIR, "coverage-summary.json");
const THRESHOLDS_FILE = join(REPO_ROOT, "scripts", "coverage-thresholds.json");

/** Round to one decimal place (e.g. 52.34 -> 52.3). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface LcovResult {
  pct: number;
  linesFound: number;
  linesHit: number;
}

/**
 * Parse pooled line-coverage % from lcov text. Sums `LF:` (lines found) and
 * `LH:` (lines hit) across every record and returns `100 * LH / LF`. Pooling
 * (not per-file averaging) matches how a single codebase-level threshold should
 * read. Throws when there is no `LF` data at all, so an empty/garbage report
 * fails loud rather than reporting a fake 0%.
 */
export function parseLcovLinePct(lcov: string): LcovResult {
  let linesFound = 0;
  let linesHit = 0;
  let sawRecord = false;
  for (const raw of lcov.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("LF:")) {
      linesFound += Number.parseInt(line.slice(3), 10) || 0;
      sawRecord = true;
    } else if (line.startsWith("LH:")) {
      linesHit += Number.parseInt(line.slice(3), 10) || 0;
      sawRecord = true;
    }
  }
  if (!sawRecord || linesFound === 0) {
    throw new Error(
      "lcov report contains no line-coverage data (no LF/LH records or zero lines found)",
    );
  }
  return { pct: round1((100 * linesHit) / linesFound), linesFound, linesHit };
}

/**
 * Read a set of op names from an `op-coverage.jsonl` body (one name per line,
 * append-only, with duplicates / blank lines / trailing newline expected). The
 * union de-dupes across the isolate workers that produced it.
 */
export function loadOpCoverageSet(jsonlText: string): Set<string> {
  const set = new Set<string>();
  for (const raw of jsonlText.split("\n")) {
    const name = raw.trim();
    if (name) set.add(name);
  }
  return set;
}

export interface OpCoverageResult {
  pct: number;
  declared: number;
  exercised: number;
  missing: string[];
}

/**
 * Op-coverage % = (declared ops that were exercised) ÷ (declared ops) * 100.
 * Executed names not in the declared set (stray imports, test-only ops) are
 * ignored so they cannot inflate the numerator. Throws on an empty declared set
 * (a registry that failed to load) rather than dividing by zero.
 */
export function computeOpCoveragePct(declared: string[], executed: Set<string>): OpCoverageResult {
  const declaredSet = new Set(declared);
  if (declaredSet.size === 0) {
    throw new Error("declared op set is empty — the op registry failed to enumerate");
  }
  const missing: string[] = [];
  let exercised = 0;
  for (const name of declaredSet) {
    if (executed.has(name)) exercised += 1;
    else missing.push(name);
  }
  return {
    pct: round1((100 * exercised) / declaredSet.size),
    declared: declaredSet.size,
    exercised,
    missing: missing.sort(),
  };
}

export type TierName = "unit" | "integration";

export interface TierVerdict {
  tier: TierName;
  measured: number;
  floor: number;
  pass: boolean;
}

/** A tier passes when measured >= floor (exact-floor is a pass, not a flake). */
export function evaluateTier(tier: TierName, measured: number, floor: number): TierVerdict {
  return { tier, measured, floor, pass: measured >= floor };
}

/** Shape of `coverage/coverage-summary.json` — the machine-readable artifact. */
export interface CoverageSummary {
  pass: boolean;
  unit: TierVerdict & { linesFound: number; linesHit: number };
  integration: TierVerdict & { declared: number; exercised: number };
  target: { unitLinePct: number; integrationOpPct: number };
}

const ThresholdsSchema = z
  .object({
    unitLinePct: z.number().min(0).max(100),
    integrationOpPct: z.number().min(0).max(100),
    target: z.object({
      unitLinePct: z.number().min(0).max(100),
      integrationOpPct: z.number().min(0).max(100),
    }),
  })
  .passthrough();

export type Thresholds = z.infer<typeof ThresholdsSchema>;

/** Validate the thresholds config. Throws (loud) on a malformed/missing floor. */
export function loadThresholds(parsed: unknown): Thresholds {
  return ThresholdsSchema.parse(parsed);
}

/**
 * Append a markdown result table to GitHub Actions' job summary when running in
 * CI, so the per-tier numbers are visible inline on the run without downloading
 * the coverage artifact. No-op locally (GITHUB_STEP_SUMMARY unset).
 */
function writeStepSummary(summary: CoverageSummary): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const row = (v: TierVerdict, detail: string) =>
    `| ${v.tier} | ${v.measured}% | ${v.floor}% | ${detail} | ${v.pass ? "✅ pass" : "❌ FAIL"} |`;
  const md = [
    `### Coverage gate — ${summary.pass ? "✅ passed" : "❌ FAILED"}`,
    "",
    "| Tier | Measured | Floor | Detail | Result |",
    "| --- | --- | --- | --- | --- |",
    row(summary.unit, `${summary.unit.linesHit}/${summary.unit.linesFound} lines`),
    row(
      summary.integration,
      `${summary.integration.exercised}/${summary.integration.declared} ops`,
    ),
    "",
    `Targets to ratchet toward: unit ${summary.target.unitLinePct}% line coverage, ` +
      `integration ${summary.target.integrationOpPct}% of declared ops.`,
    "",
  ].join("\n");
  appendFileSync(path, `${md}\n`);
}

// ---------------------------------------------------------------------------
// Orchestration (runs only as a script, never on import)
// ---------------------------------------------------------------------------

/** Discover repo test files, partitioned into the two tiers. */
function discoverTestFiles(): { unit: string[]; integration: string[] } {
  const glob = new Bun.Glob("**/*.test.ts");
  const unit: string[] = [];
  const integration: string[] = [];
  for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
    if (rel.includes("node_modules") || rel.includes("/dist/") || rel.startsWith("dist/")) continue;
    if (rel.endsWith(".integration.test.ts")) integration.push(rel);
    else unit.push(rel);
  }
  return { unit: unit.sort(), integration: integration.sort() };
}

function runTests(files: string[], extraArgs: string[], extraEnv: Record<string, string>): number {
  const proc = Bun.spawnSync(["bun", "test", ...extraArgs, ...files], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  return proc.exitCode ?? 1;
}

async function enumerateDeclaredOps(): Promise<string[]> {
  // Imported lazily (dynamic import, typed) so the pure helpers above — and the
  // unit tests that import them — never pull in the heavy admin-core graph.
  const { OperationRegistry } = await import("@caelo-cms/query-api");
  const { registerAdminOps } = await import("@caelo-cms/admin-core");
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  return [...registry.names()];
}

async function main(): Promise<number> {
  mkdirSync(COVERAGE_DIR, { recursive: true });
  const thresholds = loadThresholds(JSON.parse(readFileSync(THRESHOLDS_FILE, "utf8")));
  const { unit, integration } = discoverTestFiles();

  // Fail loud on an empty tier (CLAUDE.md §2): `bun test` with zero file args
  // would run the whole suite (or emit no coverage), letting a glob/rename
  // mistake read as a hollow pass. A real repo always has files in both tiers.
  if (unit.length === 0)
    throw new Error("no unit-tier test files found (*.test.ts) — check discovery");
  if (integration.length === 0)
    throw new Error(
      "no integration-tier test files found (*.integration.test.ts) — check discovery",
    );

  // --- Unit pass: line coverage ---
  const unitLcovDir = join(COVERAGE_DIR, "unit");
  console.log(`\n[coverage] unit tier — ${unit.length} files, measuring line coverage…`);
  const unitExit = runTests(
    unit,
    [
      // `--isolate` matches the canonical `bun test --isolate` CI path: the
      // bunfig preload (scripts/test-preload.ts) re-registers its per-file
      // hooks only under isolation, so dropping it here would give the gate
      // different pass/fail semantics than the suite it's meant to gate.
      "--isolate",
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-reporter=text",
      `--coverage-dir=${unitLcovDir}`,
    ],
    {},
  );
  if (unitExit !== 0) {
    console.error(`[coverage] unit test run failed (exit ${unitExit}) — fix failing tests first.`);
    return unitExit;
  }
  const unitLcovPath = join(unitLcovDir, "lcov.info");
  if (!existsSync(unitLcovPath)) {
    throw new Error(`expected lcov at ${unitLcovPath} but it was not produced`);
  }
  const unitCov = parseLcovLinePct(readFileSync(unitLcovPath, "utf8"));

  // --- Integration pass: op coverage ---
  console.log(
    `\n[coverage] integration tier — ${integration.length} files, measuring op coverage…`,
  );
  writeFileSync(OP_COVERAGE_FILE, ""); // truncate before the pass
  const integExit = runTests(integration, ["--isolate"], {
    CAELO_OP_COVERAGE: "1",
    CAELO_OP_COVERAGE_FILE: OP_COVERAGE_FILE,
  });
  if (integExit !== 0) {
    console.error(
      `[coverage] integration test run failed (exit ${integExit}) — fix failing tests first.`,
    );
    return integExit;
  }
  const executed = loadOpCoverageSet(readFileSync(OP_COVERAGE_FILE, "utf8"));
  const declared = await enumerateDeclaredOps();
  const opCov = computeOpCoveragePct(declared, executed);

  // --- Compare to floors + write summary ---
  const unitVerdict = evaluateTier("unit", unitCov.pct, thresholds.unitLinePct);
  const integVerdict = evaluateTier("integration", opCov.pct, thresholds.integrationOpPct);
  const pass = unitVerdict.pass && integVerdict.pass;

  const summary: CoverageSummary = {
    pass,
    unit: { ...unitVerdict, linesFound: unitCov.linesFound, linesHit: unitCov.linesHit },
    integration: { ...integVerdict, declared: opCov.declared, exercised: opCov.exercised },
    target: thresholds.target,
  };
  writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
  writeStepSummary(summary);

  console.log("\n[coverage] summary");
  for (const v of [unitVerdict, integVerdict]) {
    const tag = v.pass ? "PASS" : "FAIL";
    console.log(`  ${tag}  ${v.tier}: ${v.measured}% (floor ${v.floor}%)`);
  }
  if (!pass) {
    console.error(
      "\n[coverage] gate FAILED — a tier dropped below its floor. Add tests to recover, " +
        "or (if this is an intentional, justified change) adjust scripts/coverage-thresholds.json.",
    );
    if (opCov.missing.length > 0 && !integVerdict.pass) {
      const SHOW = 25;
      const shown = opCov.missing.slice(0, SHOW);
      const tail = opCov.missing.length - shown.length;
      console.error(
        `[coverage] integration: ${opCov.missing.length} declared ops never exercised — ` +
          "add an integration test for these (closest to the floor first):",
      );
      for (const name of shown) console.error(`    - ${name}`);
      if (tail > 0) console.error(`    … and ${tail} more`);
    }
    return 1;
  }
  console.log("\n[coverage] gate PASSED.");
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[coverage] gate crashed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
