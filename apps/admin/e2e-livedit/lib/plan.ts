// SPDX-License-Identifier: MPL-2.0
/**
 * Which real-AI scenarios a run executes — the planner behind
 * `.github/workflows/e2e-livedit.yml` (manifest: `../scenario-paths.ts`).
 *
 *   bun run apps/admin/e2e-livedit/lib/plan.ts plan \
 *     --mode pr|full --changed <file> --greens <dir> [--labels a,b] --out <file> [--comment <file>]
 *   bun run apps/admin/e2e-livedit/lib/plan.ts record \
 *     --plan <file> --report <playwright-report.json> --out <file>
 *   bun run apps/admin/e2e-livedit/lib/plan.ts after-wait \
 *     --plan <file> --jobs <tsv> --greens <dir> --out <file> [--summary <file>]
 *
 * `plan` decides; `record` writes the scenarios this run leaves green, so a
 * later run of the same PR can keep them; `after-wait` re-decides once the
 * paid job holds the PR's concurrency slot, from what other runs of the same
 * commit finished meanwhile ({@link replanAfterWait}). A PR runs only with the label
 * `real-ai` (its selection) or `real-ai-full` (everything); without one the
 * plan says what it WOULD run and `--comment` gets the opt-in PR comment.
 * The release gate is planned by `main-greens.ts` (per-scenario reuse on
 * main), a manual dispatch runs everything.
 *
 * Result keys. A scenario's key is a SHA-256 over what THIS PR changed in
 * the files the scenario covers: every changed file under its `paths` (for
 * the core: every changed AI-relevant file), its own spec and the harness,
 * each with its git blob id in the tested tree (or "deleted"). A run that
 * passed a scenario records `{id, key}`; a later push whose key for that
 * scenario is the same keeps the result instead of paying for it again — so
 * a follow-up push re-runs exactly what was red plus the scenarios whose
 * covered files the PR changed since.
 *
 * Main moving on does NOT change a key: the PR's own changes do. That is the
 * trade-off this workflow already makes for main (a regression that only
 * appears when two PRs combine surfaces at the release gate, which re-runs
 * every scenario whose covered files changed since its last green on main —
 * see `main-greens.ts`). Keying on the whole tested tree
 * instead would re-run the core on nearly every push, because main changes
 * AI files several times a day. Sound to the same degree as the path
 * selection itself: a file outside a scenario's paths is, by the manifest's
 * contract, a file that scenario does not exercise.
 *
 * Pure functions are exported for `plan.test.ts`; the CLI only does I/O.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AI_RELEVANT_PATHS,
  HARNESS_EXCLUDE,
  HARNESS_PATHS,
  NO_REAL_AI_COVERAGE,
  NON_RUNTIME_PATHS,
  SCENARIOS,
  type ScenarioCoverage,
} from "../scenario-paths.js";

/** Label that makes a PR run the whole suite. */
export const FULL_SUITE_LABEL = "real-ai-full";
/**
 * Label that makes a PR run the scenarios its change selects. Without it (or
 * {@link FULL_SUITE_LABEL}) a PR runs nothing: Real-AI on PRs is opt-in, the
 * release gate is where main gets its run.
 */
export const SELECTED_LABEL = "real-ai";
/** The labels that opt a PR into the paid suite. */
export const OPT_IN_LABELS: readonly string[] = [SELECTED_LABEL, FULL_SUITE_LABEL];
/**
 * GitHub's PR files API stops at 3000 files; a PR that size cannot be
 * classified reliably, so it runs everything.
 */
export const MAX_CLASSIFIABLE_FILES = 3000;
/** Where every spec lives, relative to the repo root. */
export const SPEC_DIR = "apps/admin/e2e-livedit";

/** True when `path` matches any of `globs`. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => new Bun.Glob(g).match(path));
}

/** A file whose change can alter what the AI sees or does (see the manifest). */
export function isAiRelevant(path: string): boolean {
  return (
    matchesAny(path, AI_RELEVANT_PATHS) &&
    !matchesAny(path, NON_RUNTIME_PATHS) &&
    !matchesAny(path, NO_REAL_AI_COVERAGE)
  );
}

/** A file of the suite's own machinery (a change runs every scenario). */
export function isHarness(path: string): boolean {
  return matchesAny(path, HARNESS_PATHS) && !matchesAny(path, HARNESS_EXCLUDE);
}

/** Scenarios CI can run (opt-in ones only skip themselves there). */
export function ciScenarios(
  scenarios: readonly ScenarioCoverage[] = SCENARIOS,
): ScenarioCoverage[] {
  return scenarios.filter((s) => s.optIn === undefined);
}

/** The files a scenario's own `paths` cover, plus its spec. */
export function coversFile(s: ScenarioCoverage, path: string): boolean {
  return path === `${SPEC_DIR}/${s.file}` || matchesAny(path, s.paths);
}

/** Why one scenario was picked: the changed files that matched it. */
export interface SelectionReason {
  readonly id: string;
  readonly files: readonly string[];
}

/** What a PR's changed files select, before any reuse. */
export interface Selection {
  /** "skip": nothing AI-relevant changed; "full": every scenario. */
  readonly kind: "skip" | "some" | "full";
  readonly reason: string;
  /** Scenario ids to consider (all CI scenarios for "full"). */
  readonly ids: readonly string[];
  readonly reasons: readonly SelectionReason[];
}

/**
 * Pick the scenarios a PR's changed files can break (rules in the manifest
 * header). `labels` are the PR's labels.
 */
export function selectScenarios(
  changed: readonly string[],
  labels: readonly string[] = [],
  scenarios: readonly ScenarioCoverage[] = SCENARIOS,
): Selection {
  const ci = ciScenarios(scenarios);
  const all = ci.map((s) => s.id);
  if (labels.includes(FULL_SUITE_LABEL)) {
    return { kind: "full", reason: `label \`${FULL_SUITE_LABEL}\``, ids: all, reasons: [] };
  }
  if (changed.length >= MAX_CLASSIFIABLE_FILES) {
    return {
      kind: "full",
      reason: `${changed.length} changed files — too many to classify`,
      ids: all,
      reasons: [],
    };
  }
  const harness = changed.filter(isHarness);
  if (harness.length > 0) {
    return {
      kind: "full",
      reason: `harness changed (${harness.slice(0, 5).join(", ")}${harness.length > 5 ? ", …" : ""})`,
      ids: all,
      reasons: [],
    };
  }
  const relevant = changed.filter(isAiRelevant);
  const specs = changed.filter((f) => ci.some((s) => f === `${SPEC_DIR}/${s.file}`));
  if (relevant.length === 0 && specs.length === 0) {
    return {
      kind: "skip",
      reason: "no AI-relevant file changed",
      ids: [],
      reasons: [],
    };
  }
  const reasons: SelectionReason[] = [];
  for (const s of ci) {
    const files = changed.filter((f) => coversFile(s, f));
    if (s.core === true && relevant.length > 0) {
      reasons.push({
        id: s.id,
        files: files.length > 0 ? files : ["(core: any AI-relevant change)"],
      });
    } else if (files.length > 0) {
      reasons.push({ id: s.id, files });
    }
  }
  return {
    kind: "some",
    reason: `${relevant.length} AI-relevant file(s) changed`,
    ids: reasons.map((r) => r.id),
    reasons,
  };
}

/** `path → git blob id` of the tested tree. */
export type TreeIndex = ReadonlyMap<string, string>;

/**
 * Each CI scenario's result key over the PR's `changed` files (see the file
 * header), with their blob ids from the tested `tree`.
 */
export function scenarioKeys(
  tree: TreeIndex,
  changed: readonly string[],
  scenarios: readonly ScenarioCoverage[] = SCENARIOS,
): Map<string, string> {
  const paths = [...new Set(changed)].sort();
  const harness = paths.filter(isHarness);
  const keys = new Map<string, string>();
  for (const s of ciScenarios(scenarios)) {
    const own = paths.filter((p) => coversFile(s, p) || (s.core === true && isAiRelevant(p)));
    const covered = [...new Set([...own, ...harness])].sort();
    const h = createHash("sha256");
    h.update(`scenario ${s.id}\n`);
    for (const p of covered) h.update(`${tree.get(p) ?? "deleted"} ${p}\n`);
    keys.set(s.id, h.digest("hex"));
  }
  return keys;
}

/** One scenario a previous run left green, with the key it was green on. */
export interface GreenResult {
  readonly id: string;
  readonly key: string;
}

/** The planner's verdict for one run. */
export interface RunPlan {
  /** "skip": run nothing; "run": run `run`. */
  readonly mode: "skip" | "run";
  readonly reason: string;
  /** Every CI scenario runs (the run may stand in for main's tree). */
  readonly full: boolean;
  /** Scenario ids to execute. */
  readonly run: readonly string[];
  /** Selected scenarios kept from an earlier green run on the same inputs. */
  readonly carried: readonly string[];
  readonly reasons: readonly SelectionReason[];
  /** Key per CI scenario on this tree. */
  readonly keys: Readonly<Record<string, string>>;
  /**
   * PR without an opt-in label: what it WOULD run (selection minus carried
   * greens). Empty when nothing would run; absent on opted-in runs.
   */
  readonly wouldRun?: readonly string[];
  /** Why each carried scenario was kept (release gate: the green it rests on). */
  readonly carriedReasons?: readonly SelectionReason[];
  /**
   * PR runs: the ids of the workflow runs that were already complete when
   * the plan read their greens. A run of the same commit that is NOT in this
   * list finished while this one waited (see {@link replanAfterWait}).
   */
  readonly consultedRuns?: readonly number[];
}

/**
 * Combine the selection with earlier greens. `mode: "full"` (manual
 * dispatch) runs everything and reuses nothing; the release gate is planned
 * by `main-greens.ts`. A PR without an opt-in label ({@link OPT_IN_LABELS})
 * runs nothing and reports what it would run.
 */
export function planRun(args: {
  mode: "pr" | "full";
  changed: readonly string[];
  labels?: readonly string[];
  keys: ReadonlyMap<string, string>;
  greens: readonly GreenResult[];
  scenarios?: readonly ScenarioCoverage[];
}): RunPlan {
  const scenarios = args.scenarios ?? SCENARIOS;
  const keys = Object.fromEntries(args.keys);
  const all = ciScenarios(scenarios).map((s) => s.id);
  if (args.mode === "full") {
    return {
      mode: "run",
      reason: "manual dispatch: the full suite",
      full: true,
      run: all,
      carried: [],
      reasons: [],
      keys,
    };
  }
  const sel = selectScenarios(args.changed, args.labels ?? [], scenarios);
  if (sel.kind === "skip") {
    return {
      mode: "skip",
      reason: sel.reason,
      full: false,
      run: [],
      carried: [],
      reasons: [],
      keys,
    };
  }
  const green = new Set(args.greens.map((g) => `${g.id} ${g.key}`));
  const run: string[] = [];
  const carried: string[] = [];
  for (const id of sel.ids) {
    if (green.has(`${id} ${args.keys.get(id)}`)) carried.push(id);
    else run.push(id);
  }
  const labels = args.labels ?? [];
  if (run.length > 0 && !OPT_IN_LABELS.some((l) => labels.includes(l))) {
    return {
      mode: "skip",
      reason: `Real-AI is opt-in on PRs: add the label \`${SELECTED_LABEL}\` (the selected scenarios) or \`${FULL_SUITE_LABEL}\` (every scenario) to run it`,
      full: false,
      run: [],
      carried,
      reasons: sel.reasons,
      keys,
      wouldRun: run,
    };
  }
  if (run.length === 0) {
    return {
      mode: "skip",
      reason: `every selected scenario already passed on these inputs (${carried.join(", ")})`,
      full: false,
      run,
      carried,
      reasons: sel.reasons,
      keys,
    };
  }
  return {
    mode: "run",
    reason: sel.reason,
    full: run.length === all.length,
    run,
    carried,
    reasons: sel.reasons,
    keys,
  };
}

/** Spec file names for `CAELO_LIVEDIT_SCENARIOS` (empty = every spec). */
export function scenarioFiles(
  ids: readonly string[],
  full: boolean,
  scenarios: readonly ScenarioCoverage[] = SCENARIOS,
): string {
  if (full) return "";
  return ids
    .map((id) => scenarios.find((s) => s.id === id)?.file)
    .filter((f): f is string => f !== undefined)
    .join(",");
}

/** Minimal shape of Playwright's JSON reporter output that `record` reads. */
interface PwSuite {
  readonly file?: string;
  readonly specs?: readonly {
    readonly ok?: boolean;
    readonly tests?: readonly { readonly status?: string }[];
  }[];
  readonly suites?: readonly PwSuite[];
}

/**
 * Spec files whose every test passed (status "expected"). A spec with a
 * skipped test or no test at all is not green: it proved nothing.
 */
export function passedSpecFiles(reportJson: string): Set<string> {
  const report = JSON.parse(reportJson) as { suites?: readonly PwSuite[] };
  const verdict = new Map<string, boolean>();
  const walk = (suite: PwSuite, file: string | undefined): void => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      if (f === undefined) continue;
      const tests = spec.tests ?? [];
      const ok = tests.length > 0 && tests.every((t) => t.status === "expected");
      verdict.set(f, (verdict.get(f) ?? true) && ok);
    }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const s of report.suites ?? []) walk(s, undefined);
  const out = new Set<string>();
  for (const [file, ok] of verdict) if (ok) out.add(file.split("/").pop() ?? file);
  return out;
}

/**
 * The greens this run leaves: every scenario it ran and passed, plus the
 * ones it carried (re-recorded so a later run needs only the newest record).
 * Only called when the run-level gates passed (bug gate, cost capture).
 */
export function greensAfterRun(
  plan: RunPlan,
  passedFiles: ReadonlySet<string>,
  scenarios: readonly ScenarioCoverage[] = SCENARIOS,
): GreenResult[] {
  const out: GreenResult[] = [];
  for (const id of plan.run) {
    const file = scenarios.find((s) => s.id === id)?.file;
    const key = plan.keys[id];
    if (file !== undefined && key !== undefined && passedFiles.has(file)) out.push({ id, key });
  }
  for (const id of plan.carried) {
    const key = plan.keys[id];
    if (key !== undefined) out.push({ id, key });
  }
  return out;
}

/** The paid job of another workflow run on the same commit. */
export interface OtherRunJob {
  readonly runId: number;
  /** GitHub job status: queued | in_progress | completed | … */
  readonly status: string;
  /** GitHub job conclusion ("" while not completed). */
  readonly conclusion: string;
}

/** What the paid job does once it holds the concurrency slot. */
export interface AfterWaitVerdict {
  /** run: execute `plan.run`; stop: nothing left, pass; blocked: fail. */
  readonly verdict: "run" | "stop" | "blocked";
  readonly reason: string;
  /** Planned scenarios a run that finished meanwhile already left green. */
  readonly dropped: readonly string[];
  /** The plan to execute and record from (unchanged unless `dropped`). */
  readonly plan: RunPlan;
}

/** Job conclusions that carry no verdict about the commit. */
const NO_VERDICT_CONCLUSIONS: readonly string[] = ["cancelled", "skipped"];

/**
 * Re-decide a PR plan after the paid job waited in the PR's concurrency
 * queue. Two runs can plan the same commit before either paid job finishes
 * (a push and a `real-ai-full` label seconds apart): both plan the same
 * scenarios, and the second, queued behind the first, would pay for them a
 * second time. `jobs` are the paid jobs of the OTHER runs on this commit;
 * only those that completed after the plan read its greens (not in
 * `plan.consultedRuns`) are news.
 *
 * - One of them ended red (failure, timed out, …): blocked. Its failures
 *   stand for this commit — a duplicate run must not re-roll a red scenario
 *   (or a run-level bug gate) into a green check. Re-running THAT run, or a
 *   new push, is the way to a new verdict.
 * - Otherwise each planned scenario whose `{id, key}` is in `greens` (what
 *   those runs recorded — only scenarios that passed) moves to `carried`;
 *   nothing left to run is "stop" (a passing check, like a plan whose every
 *   scenario is already green).
 * - Cancelled / skipped jobs say nothing about the commit and are ignored.
 */
export function replanAfterWait(args: {
  plan: RunPlan;
  jobs: readonly OtherRunJob[];
  greens: readonly GreenResult[];
}): AfterWaitVerdict {
  const { plan } = args;
  const consulted = new Set(plan.consultedRuns ?? []);
  const fresh = args.jobs.filter((j) => j.status === "completed" && !consulted.has(j.runId));
  const red = fresh.find(
    (j) => j.conclusion !== "success" && !NO_VERDICT_CONCLUSIONS.includes(j.conclusion),
  );
  if (red !== undefined) {
    return {
      verdict: "blocked",
      reason: `run ${red.runId} on this commit ended '${red.conclusion || "unknown"}' while this run waited for it — its result stands. Re-run that run (Re-run failed jobs) or push a fix; this run does not pay to re-roll it.`,
      dropped: [],
      plan,
    };
  }
  const sources = fresh.filter((j) => j.conclusion === "success").map((j) => j.runId);
  const green = new Set(args.greens.map((g) => `${g.id} ${g.key}`));
  const dropped =
    sources.length === 0 ? [] : plan.run.filter((id) => green.has(`${id} ${plan.keys[id]}`));
  if (dropped.length === 0) {
    return { verdict: "run", reason: plan.reason, dropped, plan };
  }
  const run = plan.run.filter((id) => !dropped.includes(id));
  const from = sources.map((id) => `run ${id}`).join(", ");
  const next: RunPlan = {
    ...plan,
    full: false,
    run,
    carried: [...plan.carried, ...dropped],
    reason:
      run.length === 0
        ? `every planned scenario passed in ${from} on this commit while this run waited (${dropped.join(", ")})`
        : `${plan.reason}; ${dropped.join(", ")} passed in ${from} on this commit while this run waited`,
  };
  return { verdict: run.length === 0 ? "stop" : "run", reason: next.reason, dropped, plan: next };
}

/** `runId\tstatus\tconclusion` lines (the workflow's job listing). */
export function parseJobsTsv(text: string): OtherRunJob[] {
  const out: OtherRunJob[] = [];
  for (const line of text.split("\n")) {
    const [id, status, conclusion] = line.split("\t");
    const runId = Number(id);
    if (!Number.isSafeInteger(runId) || runId <= 0 || status === undefined || status === "")
      continue;
    out.push({ runId, status, conclusion: conclusion?.trim() ?? "" });
  }
  return out;
}

/** The Markdown block the job summary and the PR comment show. */
export function planSummary(plan: RunPlan): string {
  const lines = [`**Scenario selection:** ${plan.reason}.`];
  if (plan.wouldRun !== undefined && plan.wouldRun.length > 0) {
    lines.push("", `Would run: ${plan.wouldRun.map((id) => `\`${id}\``).join(", ")}.`);
  }
  if (plan.full) lines.push("", "Every CI scenario runs.");
  else if (plan.run.length > 0)
    lines.push("", `Runs: ${plan.run.map((id) => `\`${id}\``).join(", ")}.`);
  if (plan.carried.length > 0) {
    lines.push(
      "",
      `Kept from an earlier green run on identical inputs: ${plan.carried.map((id) => `\`${id}\``).join(", ")}.`,
    );
  }
  if (plan.carriedReasons !== undefined && plan.carriedReasons.length > 0) {
    lines.push("", "<details><summary>What each kept scenario rests on</summary>", "");
    for (const r of plan.carriedReasons) lines.push(`- \`${r.id}\`: ${r.files.join(", ")}`);
    lines.push("", "</details>");
  }
  if (plan.reasons.length > 0 && (!plan.full || plan.carriedReasons !== undefined)) {
    lines.push("", "<details><summary>Why each scenario was selected</summary>", "");
    for (const r of plan.reasons) {
      const shown = r.files
        .slice(0, 8)
        .map((f) => `\`${f}\``)
        .join(", ");
      lines.push(`- \`${r.id}\`: ${shown}${r.files.length > 8 ? `, … (${r.files.length})` : ""}`);
    }
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

/**
 * The sticky PR comment for a PR that is not opted in but would run
 * something; null when nothing would run (a notice is enough then).
 */
export function optInComment(plan: RunPlan): string | null {
  if (plan.wouldRun === undefined || plan.wouldRun.length === 0) return null;
  return [
    "<!-- e2e-livedit-sticky -->",
    "## e2e-livedit — not run (opt-in)",
    "",
    `This PR changes files the Real-AI suite covers. It would run: ${plan.wouldRun.map((id) => `\`${id}\``).join(", ")}.`,
    "",
    `Real-AI runs on a PR only on request (each run costs real money; main gets its run at the release gate). Add the label \`${SELECTED_LABEL}\` to run these scenarios, or \`${FULL_SUITE_LABEL}\` for every scenario — adding the label starts the run. The check passes as skipped until then.`,
    "",
  ].join("\n");
}

/** `git ls-tree -r HEAD` of the checkout, as a path → blob index. */
function readTree(): Map<string, string> {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const tree = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, , blob] = entry.slice(0, tab).split(" ");
    if (blob !== undefined) tree.set(entry.slice(tab + 1), blob);
  }
  return tree;
}

/** Every `{id,key}` in the JSON files of `dir` (a missing dir is no greens). */
function readGreens(dir: string | undefined): GreenResult[] {
  if (dir === undefined || !existsSync(dir)) return [];
  const out: GreenResult[] = [];
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as { greens?: unknown };
      for (const g of Array.isArray(parsed.greens) ? parsed.greens : []) {
        const r = g as { id?: unknown; key?: unknown };
        if (typeof r.id === "string" && typeof r.key === "string")
          out.push({ id: r.id, key: r.key });
      }
    } catch {
      // A damaged record only costs a re-run; never a false green.
    }
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const cmd = process.argv[2];
  const out = arg("out");
  if (out === undefined) throw new Error("plan.ts: --out <file> is required");
  if (cmd === "plan") {
    const mode = arg("mode");
    if (mode !== "pr" && mode !== "full") throw new Error("plan.ts plan: --mode pr|full");
    const changedPath = arg("changed");
    const changed =
      changedPath !== undefined && existsSync(changedPath)
        ? readFileSync(changedPath, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    if (mode === "pr" && changedPath === undefined) {
      throw new Error("plan.ts plan --mode pr: --changed <file> is required");
    }
    const labels = (arg("labels") ?? "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const consultedPath = arg("consulted");
    const consultedRuns =
      consultedPath !== undefined && existsSync(consultedPath)
        ? readFileSync(consultedPath, "utf8")
            .split("\n")
            .map((l) => Number(l.trim()))
            .filter((n) => Number.isSafeInteger(n) && n > 0)
        : undefined;
    const plan: RunPlan = {
      ...planRun({
        mode,
        changed,
        labels,
        keys: scenarioKeys(readTree(), changed),
        greens: readGreens(arg("greens")),
      }),
      ...(consultedRuns !== undefined ? { consultedRuns } : {}),
    };
    // `scenarioFiles` is what the workflow hands Playwright
    // (CAELO_LIVEDIT_SCENARIOS); empty = every spec.
    const record = { ...plan, scenarioFiles: scenarioFiles(plan.run, plan.full) };
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    const commentPath = arg("comment");
    const comment = optInComment(plan);
    if (commentPath !== undefined && comment !== null) writeFileSync(commentPath, comment);
    console.log(planSummary(plan));
    return;
  }
  if (cmd === "record") {
    const planPath = arg("plan");
    const reportPath = arg("report");
    if (planPath === undefined || reportPath === undefined) {
      throw new Error("plan.ts record: --plan <file> --report <file> are required");
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as RunPlan;
    const passed = existsSync(reportPath)
      ? passedSpecFiles(readFileSync(reportPath, "utf8"))
      : new Set<string>();
    const greens = greensAfterRun(plan, passed);
    writeFileSync(out, `${JSON.stringify({ greens }, null, 2)}\n`);
    console.log(
      `recorded ${greens.length} green scenario(s): ${greens.map((g) => g.id).join(", ")}`,
    );
    return;
  }
  if (cmd === "after-wait") {
    const planPath = arg("plan");
    const jobsPath = arg("jobs");
    if (planPath === undefined || jobsPath === undefined) {
      throw new Error("plan.ts after-wait: --plan <file> --jobs <file> are required");
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as RunPlan;
    const v = replanAfterWait({
      plan,
      jobs: parseJobsTsv(readFileSync(jobsPath, "utf8")),
      greens: readGreens(arg("greens")),
    });
    const scenarios = scenarioFiles(v.plan.run, v.plan.full);
    if (v.dropped.length > 0) {
      writeFileSync(out, `${JSON.stringify({ ...v.plan, scenarioFiles: scenarios }, null, 2)}\n`);
      const summaryPath = arg("summary");
      if (summaryPath !== undefined) writeFileSync(summaryPath, `${planSummary(v.plan)}\n`);
    }
    // One JSON line for the workflow step.
    console.log(
      JSON.stringify({
        verdict: v.verdict,
        reason: v.reason,
        dropped: v.dropped,
        scenarios,
        full: v.plan.full,
      }),
    );
    return;
  }
  throw new Error(`plan.ts: unknown command ${cmd ?? "(none)"} — use plan | record | after-wait`);
}

if (import.meta.main) main();
