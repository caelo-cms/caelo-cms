// SPDX-License-Identifier: MPL-2.0
/**
 * Per-scenario reuse for the release gate: which scenarios a release-gate
 * run (release-cut dispatches `e2e-livedit.yml` on `release-gate/<sha>`)
 * executes, and the green records it reuses.
 *
 *   bun run apps/admin/e2e-livedit/lib/main-greens.ts plan --names <file> --out <file>
 *   bun run apps/admin/e2e-livedit/lib/main-greens.ts record \
 *     --plan <file> --report <playwright-report.json> --sha <sha> --run <id> --attempt <n> --dir <dir>
 *   bun run apps/admin/e2e-livedit/lib/main-greens.ts stale --names <file>
 *
 * Every scenario a release gate or a manual dispatch on `main` passes is
 * recorded on the `e2e-livedit-ledger` branch (the same branch the weekly
 * budget reads) as an empty-bodied file whose NAME is the record:
 *
 *   greens/<scenario-id>_<YYYYMMDDTHHMMSSZ>_<commit sha>_<run_id>-<attempt>.json
 *
 * Why the ledger branch and not the `e2e-livedit-scenario-greens-*`
 * artifacts the PR reuse reads: the gate needs the newest green per
 * scenario across ALL earlier gate runs, which from artifacts is a run
 * listing plus one zip download per run (and they expire after 30 days);
 * from the branch it is one directory listing, and the files outlive
 * artifact retention. The commit sha in the name is what makes the reuse
 * computable: the gate diffs that commit's tree against the commit it
 * gates (`git diff --name-only <green sha> HEAD`, a plain tree diff, so it
 * does not care how the two commits are related).
 *
 * The rule, per CI scenario (`planRelease`): it RUNS when
 *   - it has no record (none yet, a name that does not parse, a new
 *     scenario),
 *   - its newest green is older than {@link MAX_GREEN_AGE_DAYS} days (the
 *     safety net against provider / model drift: the code did not change,
 *     the model behind it may have),
 *   - the diff from its green commit cannot be computed (unknown commit),
 *   - the diff touches the harness, a file the scenario covers (its paths,
 *     its spec; for the core every AI-relevant file), or an AI-relevant file
 *     no CI scenario maps (the manifest test forbids that; if it happens
 *     anyway, the gate runs rather than trusts).
 * Files in `NO_REAL_AI_COVERAGE` and tests/docs never trigger a run.
 * Otherwise the green is carried over. Every uncertainty resolves to "run".
 *
 * Carried scenarios are NOT re-recorded: their record keeps the commit and
 * the time they really passed, so the 7-day net measures the last REAL run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_REAL_AI_COVERAGE,
  NON_RUNTIME_PATHS,
  SCENARIOS,
  type ScenarioCoverage,
} from "../scenario-paths.js";
import {
  ciScenarios,
  coversFile,
  isAiRelevant,
  isHarness,
  matchesAny,
  passedSpecFiles,
  planSummary,
  type RunPlan,
  type SelectionReason,
  scenarioFiles,
} from "./plan.js";

/** A green older than this re-runs even when none of its inputs changed. */
export const MAX_GREEN_AGE_DAYS = 7;
/** Directory of the green records on the ledger branch. */
export const GREENS_DIR = "greens";

/** One recorded green of a scenario on main / a release gate. */
export interface MainGreen {
  readonly id: string;
  readonly at: Date;
  readonly sha: string;
  readonly run: string;
}

const NAME = /^([a-z0-9-]+)_(\d{8}T\d{6}Z)_([0-9a-f]{40})_([0-9]+-[0-9]+)\.json$/;

function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** The record file name (inside {@link GREENS_DIR}) for one passed scenario. */
export function mainGreenFileName(
  id: string,
  at: Date,
  sha: string,
  runId: string,
  attempt: string,
): string {
  const name = `${id}_${stamp(at)}_${sha}_${runId}-${attempt}.json`;
  if (parseMainGreenName(name) === null) {
    throw new Error(`main-greens: cannot record ${id} @ ${sha} (run ${runId}-${attempt})`);
  }
  return name;
}

/** Parse a record name; null for anything that is not one (it then counts as no record). */
export function parseMainGreenName(name: string): MainGreen | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const s = m[2] ?? "";
  const at = new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
  );
  if (Number.isNaN(at.getTime())) return null;
  return { id: m[1] ?? "", at, sha: m[3] ?? "", run: m[4] ?? "" };
}

/** The newest parseable record per scenario id, with its file name. */
function newestByScenario(names: readonly string[]): Map<string, { g: MainGreen; name: string }> {
  const out = new Map<string, { g: MainGreen; name: string }>();
  for (const name of names) {
    const g = parseMainGreenName(name);
    if (g === null) continue;
    const prev = out.get(g.id);
    if (prev === undefined || g.at.getTime() > prev.g.at.getTime()) out.set(g.id, { g, name });
  }
  return out;
}

/** The newest parseable record per scenario id. */
export function newestGreens(names: readonly string[]): Map<string, MainGreen> {
  return new Map([...newestByScenario(names)].map(([id, v]) => [id, v.g]));
}

/** Records to delete on write: every parseable one but the newest per scenario. */
export function staleMainGreenNames(names: readonly string[]): string[] {
  const keep = new Set([...newestByScenario(names).values()].map((v) => v.name));
  return names.filter((n) => parseMainGreenName(n) !== null && !keep.has(n));
}

/** True when a changed file can break scenario `s` (rules in the file header). */
export function triggersScenario(s: ScenarioCoverage, path: string): boolean {
  if (matchesAny(path, NO_REAL_AI_COVERAGE)) return false;
  if (isHarness(path)) return true;
  if (matchesAny(path, NON_RUNTIME_PATHS)) return false;
  return coversFile(s, path) || (s.core === true && isAiRelevant(path));
}

/**
 * An AI-relevant file no CI scenario maps by its own paths or spec (the
 * core's catch-all does not count). `plan.test.ts` keeps this empty on main.
 */
export function isUnmapped(
  path: string,
  scenarios: readonly ScenarioCoverage[] = SCENARIOS,
): boolean {
  return isAiRelevant(path) && !ciScenarios(scenarios).some((s) => coversFile(s, path));
}

/**
 * Plan a release-gate run. `diffs` maps a green's commit sha to the files
 * that differ between it and the gated commit (null: could not compute).
 */
export function planRelease(args: {
  now: Date;
  greens: ReadonlyMap<string, MainGreen>;
  diffs: ReadonlyMap<string, readonly string[] | null>;
  scenarios?: readonly ScenarioCoverage[];
}): RunPlan {
  const scenarios = args.scenarios ?? SCENARIOS;
  const ci = ciScenarios(scenarios);
  const maxAge = MAX_GREEN_AGE_DAYS * 86_400_000;
  const run: string[] = [];
  const carried: string[] = [];
  const reasons: SelectionReason[] = [];
  const carriedReasons: SelectionReason[] = [];
  for (const s of ci) {
    const g = args.greens.get(s.id);
    const why = (files: readonly string[]) => {
      run.push(s.id);
      reasons.push({ id: s.id, files });
    };
    if (g === undefined) {
      why(["(no green record on main)"]);
      continue;
    }
    const at = g.at.toISOString().slice(0, 16).replace("T", " ");
    if (args.now.getTime() - g.at.getTime() > maxAge) {
      why([`(last green ${at} UTC is older than ${MAX_GREEN_AGE_DAYS} days)`]);
      continue;
    }
    const diff = args.diffs.get(g.sha);
    if (diff === undefined || diff === null) {
      why([`(cannot diff against its green commit ${g.sha.slice(0, 7)})`]);
      continue;
    }
    const unmapped = diff.filter((f) => isUnmapped(f, scenarios));
    const hits = diff.filter((f) => triggersScenario(s, f));
    if (unmapped.length > 0 || hits.length > 0) {
      why([...new Set([...hits, ...unmapped.map((f) => `${f} (unmapped)`)])]);
      continue;
    }
    carried.push(s.id);
    carriedReasons.push({
      id: s.id,
      files: [`green on ${g.sha.slice(0, 7)} at ${at} UTC, no covered file changed since`],
    });
  }
  return {
    mode: "run",
    reason:
      run.length === 0
        ? `release gate: every scenario carried over from its green on main (${carried.length})`
        : `release gate: ${run.length} scenario(s) to run, ${carried.length} carried over from their green on main`,
    full: run.length === ci.length,
    run,
    carried,
    reasons,
    keys: {},
    carriedReasons,
  };
}

/**
 * The record names this run leaves: every scenario it RAN and passed (not
 * the carried ones — see the file header).
 */
export function mainGreensAfterRun(
  plan: RunPlan,
  passedFiles: ReadonlySet<string>,
  at: Date,
  sha: string,
  runId: string,
  attempt: string,
  scenarios: readonly ScenarioCoverage[] = SCENARIOS,
): string[] {
  const out: string[] = [];
  for (const id of plan.run) {
    const file = scenarios.find((s) => s.id === id)?.file;
    if (file !== undefined && passedFiles.has(file)) {
      out.push(mainGreenFileName(id, at, sha, runId, attempt));
    }
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readNames(path: string | undefined): string[] {
  if (path === undefined || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Files that differ between `sha` and HEAD; null when git cannot tell. */
function diffAgainstHead(sha: string): string[] | null {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", sha, "HEAD"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function main(): void {
  const cmd = process.argv[2];
  if (cmd === "plan") {
    const out = arg("out");
    if (out === undefined) throw new Error("main-greens.ts plan: --out <file> is required");
    const greens = newestGreens(readNames(arg("names")));
    const diffs = new Map<string, string[] | null>();
    for (const g of greens.values())
      if (!diffs.has(g.sha)) diffs.set(g.sha, diffAgainstHead(g.sha));
    const plan = planRelease({ now: new Date(), greens, diffs });
    // An empty run list must never reach Playwright as "" (= every spec):
    // the workflow skips the paid steps when `paid` is false.
    const record = {
      ...plan,
      scenarioFiles: scenarioFiles(plan.run, plan.full),
      paid: plan.run.length > 0,
    };
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(planSummary(plan));
    return;
  }
  if (cmd === "record") {
    const planPath = arg("plan");
    const reportPath = arg("report");
    const dir = arg("dir");
    const sha = arg("sha") ?? "";
    if (planPath === undefined || reportPath === undefined || dir === undefined) {
      throw new Error("main-greens.ts record: --plan, --report and --dir are required");
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as RunPlan;
    const passed = existsSync(reportPath)
      ? passedSpecFiles(readFileSync(reportPath, "utf8"))
      : new Set<string>();
    const names = mainGreensAfterRun(
      plan,
      passed,
      new Date(),
      sha,
      arg("run") ?? "",
      arg("attempt") ?? "",
    );
    mkdirSync(join(dir, GREENS_DIR), { recursive: true });
    for (const n of names) writeFileSync(join(dir, GREENS_DIR, n), "{}\n");
    console.log(`recorded ${names.length} green scenario(s) on main: ${names.join(", ")}`);
    return;
  }
  if (cmd === "stale") {
    for (const n of staleMainGreenNames(readNames(arg("names")))) console.log(n);
    return;
  }
  throw new Error(`main-greens.ts: unknown command ${cmd ?? "(none)"} — use plan | record | stale`);
}

if (import.meta.main) main();
