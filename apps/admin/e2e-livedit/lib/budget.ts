// SPDX-License-Identifier: MPL-2.0
/**
 * Weekly spend guard for the real-AI suite.
 *
 * Every run that reached the provider records its real cost (`ai-cost.json`,
 * `totalMicrocents`, 1 USD = 1e8 microcents) as one file on the
 * `e2e-livedit-ledger` branch, named so the spend is readable from a single
 * directory listing — no artifact downloads, one API call:
 *
 *   runs/<YYYYMMDDTHHMMSSZ>_<run_id>-<attempt>_<microcents>.json
 *
 * The plan job sums the trailing 7 days and, when the total is over the
 * weekly budget (repo variable `E2E_LIVEDIT_WEEKLY_BUDGET_USD`, default
 * {@link DEFAULT_WEEKLY_BUDGET_USD}), PR runs skip with a passing check; the
 * release gate and a manual dispatch always run. Why a ledger branch and not
 * the existing `e2e-livedit-cost-<run_id>` artifacts: summing those means one
 * listing plus one zip download per run (~400 API calls for a week), more
 * than GITHUB_TOKEN's hourly budget allows per plan job.
 *
 *   bun run apps/admin/e2e-livedit/lib/budget.ts name --cost <ai-cost.json> --run <id> --attempt <n>
 *   bun run apps/admin/e2e-livedit/lib/budget.ts spend --names <file> --budget-usd <n> --out <file>
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Weekly budget when the repo variable is unset (maintainer target $150–250/week). */
export const DEFAULT_WEEKLY_BUDGET_USD = 250;
/** Trailing window the guard sums. */
export const WINDOW_DAYS = 7;
/** Ledger entries older than this are pruned on write (the window plus slack). */
export const KEEP_DAYS = 9;
/** 1 USD in the cost columns' unit. */
export const MICROCENTS_PER_USD = 100_000_000;

/** One ledger entry, parsed from its file name. */
export interface LedgerEntry {
  readonly at: Date;
  readonly run: string;
  readonly microcents: number;
}

const NAME = /^(\d{8}T\d{6}Z)_([0-9]+-[0-9]+)_([0-9]+)\.json$/;

function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** The ledger file name for one run attempt. */
export function ledgerFileName(
  at: Date,
  runId: string,
  attempt: string,
  microcents: number,
): string {
  if (!/^[0-9]+$/.test(runId) || !/^[0-9]+$/.test(attempt)) {
    throw new Error(`budget: run id / attempt must be numeric (got ${runId}/${attempt})`);
  }
  return `${stamp(at)}_${runId}-${attempt}_${Math.max(0, Math.round(microcents))}.json`;
}

/** Parse a ledger file name; null for anything else in the directory. */
export function parseLedgerName(name: string): LedgerEntry | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const s = m[1] ?? "";
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return { at, run: m[2] ?? "", microcents: Number(m[3]) };
}

/** Microcents spent in the `days` before `now`. */
export function trailingSpend(names: readonly string[], now: Date, days = WINDOW_DAYS): number {
  const from = now.getTime() - days * 86_400_000;
  let total = 0;
  for (const n of names) {
    const e = parseLedgerName(n);
    if (e && e.at.getTime() > from && e.at.getTime() <= now.getTime()) total += e.microcents;
  }
  return total;
}

/** Ledger entries to delete when writing (older than {@link KEEP_DAYS}). */
export function staleLedgerNames(names: readonly string[], now: Date): string[] {
  const from = now.getTime() - KEEP_DAYS * 86_400_000;
  return names.filter((n) => {
    const e = parseLedgerName(n);
    return e !== null && e.at.getTime() <= from;
  });
}

/** The budget from the repo variable; empty means the default, junk fails loudly. */
export function parseBudgetUsd(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_WEEKLY_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `E2E_LIVEDIT_WEEKLY_BUDGET_USD must be a non-negative number of dollars (got "${raw}")`,
    );
  }
  return n;
}

/** The guard's verdict. */
export interface BudgetVerdict {
  readonly over: boolean;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  /** One line for the summary and the PR comment. */
  readonly line: string;
}

/** Compare the trailing spend with the budget. */
export function budgetVerdict(spentMicrocents: number, budgetUsd: number): BudgetVerdict {
  const spentUsd = spentMicrocents / MICROCENTS_PER_USD;
  const over = spentUsd >= budgetUsd;
  const line = over
    ? `Real-AI weekly budget used: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} (trailing ${WINDOW_DAYS} days) — runs on release gate / manual dispatch only.`
    : `Real-AI weekly budget: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} used (trailing ${WINDOW_DAYS} days).`;
  return { over, spentUsd, budgetUsd, line };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const cmd = process.argv[2];
  if (cmd === "name") {
    const cost = JSON.parse(readFileSync(arg("cost") ?? "", "utf8")) as {
      totalMicrocents?: unknown;
    };
    const micro = Number(cost.totalMicrocents ?? 0);
    console.log(
      ledgerFileName(
        new Date(),
        arg("run") ?? "",
        arg("attempt") ?? "",
        Number.isFinite(micro) ? micro : 0,
      ),
    );
    return;
  }
  if (cmd === "spend") {
    const names = readFileSync(arg("names") ?? "", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const verdict = budgetVerdict(
      trailingSpend(names, new Date()),
      parseBudgetUsd(arg("budget-usd")),
    );
    writeFileSync(arg("out") ?? "", `${JSON.stringify(verdict)}\n`);
    console.log(verdict.line);
    return;
  }
  if (cmd === "stale") {
    const names = readFileSync(arg("names") ?? "", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const n of staleLedgerNames(names, new Date())) console.log(n);
    return;
  }
  throw new Error(`budget.ts: unknown command ${cmd ?? "(none)"} — use name | spend | stale`);
}

if (import.meta.main) main();
