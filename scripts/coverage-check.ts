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
 * Sharded in CI: `--shard <i>/<n>` runs one share of both tiers (the files
 * split by `shardFiles`) on its own database and writes its raw data —
 * `coverage/shard-<i>/unit/lcov.info` and `…/op-coverage.jsonl` — without
 * judging; `--merge <dir>` then unites every shard's data (`mergeLcov`: the
 * lines of each source file, as one run would have counted them; the op
 * sets) and applies the floors. Without either flag the script runs the
 * whole suite and gates it, as before (local use).
 *
 * The pure helpers (`parseLcovLinePct`, `mergeLcov`, `shardFiles`,
 * `parseShard`, `loadOpCoverageSet`, `computeOpCoveragePct`, `evaluateTier`,
 * `loadThresholds`, `classifyTestExit`) are exported for unit testing; the
 * orchestration runs only under `import.meta.main`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
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
 * Pooled line coverage of several lcov reports of the same code, as one
 * run over all their tests would have measured it: per source file the
 * union of its instrumented lines (`DA:<line>,<hits>`), a line hit when
 * any report hit it. Summing the reports' LF/LH instead would count a
 * file once per shard that loaded it. Throws when no report has line data.
 */
export function mergeLcov(reports: readonly string[]): LcovResult {
  const lines = new Map<string, Map<number, boolean>>();
  for (const report of reports) {
    let file: string | null = null;
    for (const raw of report.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("SF:")) {
        file = line.slice(3);
      } else if (line === "end_of_record") {
        file = null;
      } else if (file !== null && line.startsWith("DA:")) {
        const [num, hits] = line.slice(3).split(",");
        const n = Number.parseInt(num ?? "", 10);
        if (!Number.isFinite(n)) continue;
        const byLine = lines.get(file) ?? new Map<number, boolean>();
        byLine.set(n, (byLine.get(n) ?? false) || (Number.parseInt(hits ?? "0", 10) || 0) > 0);
        lines.set(file, byLine);
      }
    }
  }
  let linesFound = 0;
  let linesHit = 0;
  for (const byLine of lines.values()) {
    linesFound += byLine.size;
    for (const hit of byLine.values()) if (hit) linesHit += 1;
  }
  if (linesFound === 0) {
    throw new Error("the lcov reports contain no line data (no DA records) — nothing to merge");
  }
  return { pct: round1((100 * linesHit) / linesFound), linesFound, linesHit };
}

/** `"<i>/<n>"` → shard i of n (1-based); throws on anything else. */
export function parseShard(text: string): { index: number; count: number } {
  const m = /^(\d+)\/(\d+)$/.exec(text);
  const index = Number(m?.[1]);
  const count = Number(m?.[2]);
  if (!m || count < 1 || index < 1 || index > count) {
    throw new Error(`--shard takes <i>/<n> with 1 <= i <= n (got "${text}")`);
  }
  return { index, count };
}

/**
 * The files of shard `index` of `count`: every file in exactly one shard,
 * the shards balanced by file size (the closest proxy for run time that
 * needs no history) — largest first into the lightest shard, ties by
 * path, so every shard computes the same split.
 */
export function shardFiles(
  files: readonly string[],
  sizeOf: (file: string) => number,
  index: number,
  count: number,
): string[] {
  const load = Array.from({ length: count }, () => 0);
  const out: string[] = [];
  const sorted = [...files]
    .map((f) => ({ f, size: sizeOf(f) }))
    .sort((a, b) => b.size - a.size || a.f.localeCompare(b.f));
  for (const { f, size } of sorted) {
    let lightest = 0;
    for (let i = 1; i < count; i += 1) if ((load[i] ?? 0) < (load[lightest] ?? 0)) lightest = i;
    load[lightest] = (load[lightest] ?? 0) + size;
    if (lightest === index - 1) out.push(f);
  }
  return out.sort();
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

/**
 * How a `bun test` run ended. A Bun crash (#984: "panic: Segmentation
 * fault … a bug in Bun") kills the process by a signal — or, behind a
 * shell, exits 128 + the signal number — and must not read as "tests
 * failed": the log then shows a bare exit 1 with no `(fail)` line.
 */
export type TestRunOutcome =
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly exitCode: number }
  | { readonly kind: "crashed"; readonly signal: string; readonly exitCode: number };

const SIGNAL_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(osConstants.signals).map(([name, n]) => [n, name]),
);

/**
 * Classify a finished test process from `Bun.spawnSync`'s `exitCode` /
 * `signalCode`. A crash keeps a nonzero exit (128 + signal number, the
 * shell convention) so the gate still fails.
 */
export function classifyTestExit(proc: {
  readonly exitCode: number | null;
  readonly signalCode?: string | null;
}): TestRunOutcome {
  if (proc.signalCode) {
    const n = (osConstants.signals as Record<string, number | undefined>)[proc.signalCode];
    return { kind: "crashed", signal: proc.signalCode, exitCode: n ? 128 + n : 1 };
  }
  if (proc.exitCode === null) return { kind: "crashed", signal: "unknown", exitCode: 1 };
  if (proc.exitCode === 0) return { kind: "passed" };
  if (proc.exitCode >= 128) {
    const signal = SIGNAL_NAMES.get(proc.exitCode - 128) ?? `exit ${proc.exitCode}`;
    return { kind: "crashed", signal, exitCode: proc.exitCode };
  }
  return { kind: "failed", exitCode: proc.exitCode };
}

/** The log line for a run that did not pass; null when it passed. */
export function describeTestRun(tier: TierName, outcome: TestRunOutcome): string | null {
  if (outcome.kind === "passed") return null;
  if (outcome.kind === "crashed") {
    return `[coverage] ${tier} run: Bun crashed (signal ${outcome.signal}) — not a test failure; rerun the job (exit ${outcome.exitCode}).`;
  }
  return `[coverage] ${tier} test run failed (exit ${outcome.exitCode}) — fix failing tests first.`;
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

function runTests(
  files: string[],
  extraArgs: string[],
  extraEnv: Record<string, string>,
): TestRunOutcome {
  const proc = Bun.spawnSync(["bun", "test", ...extraArgs, ...files], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  return classifyTestExit({ exitCode: proc.exitCode, signalCode: proc.signalCode ?? null });
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

/** The value after `name` on the command line, or null. */
function argValue(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

/** Run one tier's files; the lcov / op data land in `outDir`. */
function runUnit(files: string[], outDir: string): TestRunOutcome {
  return runTests(
    files,
    [
      // `--isolate` matches the canonical `bun test --isolate` CI path: the
      // bunfig preload (scripts/test-preload.ts) re-registers its per-file
      // hooks only under isolation, so dropping it here would give the gate
      // different pass/fail semantics than the suite it's meant to gate.
      "--isolate",
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-reporter=text",
      `--coverage-dir=${join(outDir, "unit")}`,
    ],
    {},
  );
}

function runIntegration(files: string[], opFile: string): TestRunOutcome {
  writeFileSync(opFile, ""); // truncate before the pass
  return runTests(files, ["--isolate"], {
    CAELO_OP_COVERAGE: "1",
    CAELO_OP_COVERAGE_FILE: opFile,
    // Destructive per-file DB reset (scripts/test-preload.ts) is opt-in so a
    // casual `bun test <file>` can never truncate a dev install. The
    // integration tier is the one place that needs it; the unit pass above
    // deliberately runs without it — unit tests must not depend on DB state.
    CAELO_TEST_DB_RESET: "1",
  });
}

async function main(argv: readonly string[]): Promise<number> {
  mkdirSync(COVERAGE_DIR, { recursive: true });
  const thresholds = loadThresholds(JSON.parse(readFileSync(THRESHOLDS_FILE, "utf8")));

  const mergeDir = argValue(argv, "--merge");
  if (mergeDir !== null) return gateMerged(resolve(REPO_ROOT, mergeDir), thresholds);

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

  const shardArg = argValue(argv, "--shard");
  if (shardArg !== null) {
    const { index, count } = parseShard(shardArg);
    const size = (f: string) => statSync(join(REPO_ROOT, f)).size;
    const outDir = join(COVERAGE_DIR, `shard-${index}`);
    mkdirSync(outDir, { recursive: true });
    const unitShare = shardFiles(unit, size, index, count);
    const integrationShare = shardFiles(integration, size, index, count);
    console.log(
      `\n[coverage] shard ${index}/${count} — ${unitShare.length} unit + ${integrationShare.length} integration files (raw data only; the merge gates)`,
    );
    // Both tiers run even when the first fails, so one shard run reports
    // every failure of its files; the shard fails if either did.
    const unitExit: TestRunOutcome =
      unitShare.length > 0 ? runUnit(unitShare, outDir) : { kind: "passed" };
    const integExit: TestRunOutcome =
      integrationShare.length > 0
        ? runIntegration(integrationShare, join(outDir, "op-coverage.jsonl"))
        : { kind: "passed" };
    for (const [tier, exit] of [
      ["unit", unitExit],
      ["integration", integExit],
    ] as const) {
      const line = describeTestRun(tier, exit);
      if (line) console.error(line);
    }
    if (unitExit.kind !== "passed") return unitExit.exitCode;
    if (integExit.kind !== "passed") return integExit.exitCode;
    return 0;
  }

  // --- Unit pass: line coverage ---
  console.log(`\n[coverage] unit tier — ${unit.length} files, measuring line coverage…`);
  const unitExit = runUnit(unit, COVERAGE_DIR);
  if (unitExit.kind !== "passed") {
    console.error(describeTestRun("unit", unitExit));
    return unitExit.exitCode;
  }
  const unitLcovPath = join(COVERAGE_DIR, "unit", "lcov.info");
  if (!existsSync(unitLcovPath)) {
    throw new Error(`expected lcov at ${unitLcovPath} but it was not produced`);
  }
  const unitCov = parseLcovLinePct(readFileSync(unitLcovPath, "utf8"));

  // --- Integration pass: op coverage ---
  console.log(
    `\n[coverage] integration tier — ${integration.length} files, measuring op coverage…`,
  );
  const integExit = runIntegration(integration, OP_COVERAGE_FILE);
  if (integExit.kind !== "passed") {
    console.error(describeTestRun("integration", integExit));
    return integExit.exitCode;
  }
  const executed = loadOpCoverageSet(readFileSync(OP_COVERAGE_FILE, "utf8"));
  return gate(unitCov, executed, thresholds);
}

/**
 * `--merge <dir>`: unite the raw data of every `shard-<i>` under `dir`
 * and gate it. A shard without its data fails loud — a crashed or
 * missing shard must not read as less coverage.
 */
async function gateMerged(dir: string, thresholds: Thresholds): Promise<number> {
  const shards = readdirSync(dir).filter((d) => /^(coverage-)?shard-\d+$/.test(d));
  if (shards.length === 0) throw new Error(`no shard-<i> directories under ${dir}`);
  const reports: string[] = [];
  const executed = new Set<string>();
  for (const shard of shards.sort()) {
    const lcov = join(dir, shard, "unit", "lcov.info");
    const ops = join(dir, shard, "op-coverage.jsonl");
    if (!existsSync(lcov) || !existsSync(ops)) {
      throw new Error(`${shard} has no coverage data (${lcov}, ${ops}) — did the shard run?`);
    }
    reports.push(readFileSync(lcov, "utf8"));
    for (const name of loadOpCoverageSet(readFileSync(ops, "utf8"))) executed.add(name);
  }
  console.log(`[coverage] merged ${shards.length} shards: ${shards.join(", ")}`);
  return gate(mergeLcov(reports), executed, thresholds);
}

/** Compare both tiers to their floors and write the summary. */
async function gate(
  unitCov: LcovResult,
  executed: Set<string>,
  thresholds: Thresholds,
): Promise<number> {
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
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[coverage] gate crashed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
