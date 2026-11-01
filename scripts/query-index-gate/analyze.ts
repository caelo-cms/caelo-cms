// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — the query index gate's analyzer (docs/dev/query-index-gate.md).
 *
 * Input: the stream-filtered auto_explain log of an integration run
 * (`seqscan-filter.awk`): one entry per distinct plan that contains a Seq
 * Scan and ran inside a Database Adapter transaction, headed by its
 * `caelo/<holder>` tag. The run uses `enable_seqscan=off`, so the planner
 * takes any index that can serve a predicate, even on a three-row test
 * table: a Seq Scan that still filters means no index serves that filter.
 *
 * Every filtered Seq Scan becomes a {@link ScanFinding} keyed by (operation,
 * relation, normalised filter). Filter terms that only read session
 * settings (`current_setting(...)`: the RLS policies and the branch
 * identity) are dropped — they are on every scan of a policy table and say
 * nothing about the operation's own predicate. A scan with nothing left is
 * an unfiltered read and is not gated.
 *
 * Postgres's own referential-integrity statements (a parent delete checking
 * or cascading into a child: `SELECT 1 FROM ONLY … FOR KEY SHARE`,
 * `UPDATE ONLY … SET … = NULL`, `DELETE FROM ONLY …`) are classified `fk`:
 * a foreign key without a usable index. Core tables leave those to the
 * schema lint (`scripts/fk-index-lint.integration.test.ts`, which sees every
 * FK whether a test deletes its parent or not); plugin tables are created at
 * activation, outside the migrated schema the lint reads, so the gate keeps
 * theirs.
 *
 * Each finding must match an {@link ALLOWED} entry (a reasoned exemption) or
 * a {@link PENDING} entry (a known finding a tracked issue fixes); an entry
 * that matched nothing in the run is stale and fails the gate too, so the
 * lists only ever describe the code as it is.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ALLOWED, type GateRule, PENDING } from "./allowlist.js";

/** One plan of the filtered log. */
export interface PlanEntry {
  /** The adapter holder the plan ran under (operation name or holder label). */
  readonly holder: string;
  /** First line of the statement text, for samples and RI classification. */
  readonly query: string;
  /** The plan lines (Query Text excluded). */
  readonly lines: readonly string[];
}

/** One Seq Scan of an entry, with the op's own filter. */
export interface ScanFinding {
  readonly op: string;
  /** Schema-qualified relation (`public.pages`, `plugin_forms.forms`). */
  readonly relation: string;
  /** Normalised filter: constants and parameters as `?`, RLS terms dropped. */
  readonly filter: string;
  readonly kind: "filter" | "fk";
  /** `index`: a whole index walked for its order, the filter checked per row. */
  readonly scan: "seq" | "index";
  readonly sample: string;
}

const TAG = /^@@caelo\/(.*?)@@ /;

/** Split the filtered log into its plan entries. */
export function parsePlanLog(text: string): PlanEntry[] {
  const out: PlanEntry[] = [];
  for (const chunk of text.split("\n@@END")) {
    const lines = chunk.replace(/^\n+/, "").split("\n");
    const head = lines[0] ?? "";
    const tag = head.match(TAG);
    if (!tag) continue;
    const qIndex = lines.findIndex((l) => /^\s*Query Text:/.test(l));
    let query = qIndex >= 0 ? (lines[qIndex] ?? "").replace(/^\s*Query Text:/, "").trim() : "";
    // A statement that starts with a newline puts its first line below.
    if (query === "" && qIndex >= 0) {
      query = lines.slice(qIndex + 1).find((l) => l.trim() !== "") ?? "";
      query = query.trim();
    }
    out.push({ holder: tag[1] ?? "", query, lines: lines.slice(1) });
  }
  return out;
}

const RI_STATEMENT =
  /^(SELECT 1 FROM ONLY|UPDATE ONLY|DELETE FROM ONLY) "[^"]+"\."[^"]+" .*OPERATOR\(pg_catalog\.=\)/;

/** Whether `query` is one of Postgres's referential-integrity trigger statements. */
export function isRiStatement(query: string): boolean {
  return RI_STATEMENT.test(query);
}

/**
 * A scan node that reads its whole relation: a Seq Scan, or an Index (Only)
 * Scan used only for its order (no Index Cond — checked by the caller).
 */
const FULL_SCAN =
  /(?:(Seq) Scan on|Index (?:Only )?Scan (?:Backward )?using \S+ on) (\S+)(?: (?!\()(\S+))?/;

/** What the gate reads from the catalogs after the run, per schema-qualified relation. */
export interface Catalog {
  /** RLS policy quals (`policies.sql`). */
  readonly policies: ReadonlyMap<string, readonly string[]>;
  /** Leading key column of each index (`indexes.sql`). */
  readonly leadingColumns: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_CATALOG: Catalog = { policies: new Map(), leadingColumns: new Map() };

/**
 * Parse a catalog dump the gate job writes (`policies.sql`,
 * `indexes.sql`): one `schema.table<TAB>value` line per row.
 */
export function parseCatalogTsv(tsv: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of tsv.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const relation = line.slice(0, tab);
    const values = out.get(relation) ?? [];
    values.push(line.slice(tab + 1));
    out.set(relation, values);
  }
  return out;
}

/** Column names a normalised filter reads (identifiers not called as functions). */
function filterColumns(filter: string): string[] {
  return (filter.match(/\b[a-z_][a-z0-9_]*\b(?!\s*\()/gi) ?? []).filter(
    (w) => !KEYWORDS.has(w.toLowerCase()),
  );
}

/** The full scans of `entry` that carry a filter of the op's own. */
function scansOf(entry: PlanEntry, catalog: Catalog): ScanFinding[] {
  const out: ScanFinding[] = [];
  const kind = isRiStatement(entry.query) ? "fk" : "filter";
  const lines = entry.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const scan = line.match(FULL_SCAN);
    if (!scan) continue;
    const relation = scan[2] ?? "";
    const alias = scan[3] ?? relation.split(".").pop() ?? "";
    const indent = line.search(/\S/);
    let raw = "";
    let indexCond = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.search(/\S/) <= indent || next.includes("->")) break;
      const filter = next.match(/^\s*Filter: (.*)$/);
      if (filter) raw = filter[1] ?? "";
      if (/^\s*Index Cond: /.test(next)) indexCond = true;
    }
    if (indexCond || relation.startsWith("pg_catalog.")) continue;
    const ownNames = [alias, relation.split(".").pop() ?? ""];
    const filter = normaliseFilter(
      raw,
      ownNames,
      policyTermsOf(catalog.policies.get(relation) ?? [], ownNames),
    );
    if (filter === "") continue;
    // A whole-index walk where another index leads with a filter column is
    // a cost tie on a near-empty test table, not a missing index: with
    // rows, the planner takes the lookup (seq scans have no such tie —
    // `enable_seqscan=off` prices them out).
    const isIndexWalk = scan[1] !== "Seq";
    const leading = catalog.leadingColumns.get(relation) ?? [];
    if (isIndexWalk && filterColumns(filter).some((c) => leading.includes(c))) continue;
    out.push({
      op: entry.holder,
      relation,
      filter,
      kind,
      scan: isIndexWalk ? "index" : "seq",
      sample: entry.query.slice(0, 200),
    });
  }
  return out;
}

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "null",
  "true",
  "false",
  "any",
  "all",
  "array",
  "in",
  "like",
  "ilike",
  "case",
  "when",
  "then",
  "else",
  "end",
  "between",
  "distinct",
  "from",
  "subplan",
  "initplan",
  "hashed",
]);

/**
 * Normalise a plan's Filter text into the gate's grouping key: literals,
 * parameters and numbers become `?`, casts and the scanned relation's own
 * qualifier go, and top-level AND terms are dropped when they reference no
 * column, read a session setting, or are the relation's own RLS policy
 * (`policyTerms`, from {@link policyTermsOf}). Returns "" when nothing of
 * the op's is left.
 */
export function normaliseFilter(
  raw: string,
  ownNames: readonly string[],
  policyTerms: ReadonlySet<string> = new Set(),
): string {
  if (raw.trim() === "") return "";
  const kept = splitTop(prepare(raw, ownNames), " AND ").filter(
    (term) =>
      !term.includes("current_setting(") &&
      referencesColumn(term) &&
      !isPolicyTerm(term, policyTerms),
  );
  if (kept.every(isLivenessTerm)) return "";
  // One parenthesised form per term, whether Postgres printed the filter as
  // a single term or as a conjunction.
  return kept.map((t) => `(${unwrap(t)})`).join(" AND ");
}

/**
 * The live-row and branch columns every branch-aware table carries (core
 * `chat_branch_id` / `deleted_at`, plugin host columns `caelo_…`). A filter
 * made only of `<col> IS NULL` or `(<col> IS NULL OR <col> = ?)` on them
 * selects (nearly) every row — "the live state", "live plus this branch" —
 * so no index would serve it: the read is a whole-domain read, whose cost
 * the rows-read gate (#1267) measures, not an unindexed lookup.
 */
const LIVENESS_COLUMN = "(?:caelo_)?(?:chat_branch_id|deleted_at)";
const LIVENESS_TERM = new RegExp(
  `^(?:${LIVENESS_COLUMN} IS NULL|\\(${LIVENESS_COLUMN} IS NULL\\) OR \\(${LIVENESS_COLUMN} = \\?\\))$`,
);

function isLivenessTerm(term: string): boolean {
  return LIVENESS_TERM.test(unwrap(term));
}

/**
 * The normalised terms of a relation's RLS policies (`pg_policies.qual`),
 * so a plan's Filter can be told apart from them: each qual whole and each
 * of its AND terms. Permissive policies reach the plan OR-ed together,
 * which {@link isPolicyTerm} handles.
 */
export function policyTermsOf(quals: readonly string[], ownNames: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const qual of quals) {
    const q = prepare(qual, ownNames);
    out.add(unwrap(q));
    for (const term of splitTop(q, " AND ")) out.add(unwrap(term));
  }
  return out;
}

function isPolicyTerm(term: string, policyTerms: ReadonlySet<string>): boolean {
  const t = unwrap(term);
  if (policyTerms.has(t)) return true;
  const alternatives = splitTop(t, " OR ");
  return (
    alternatives.length > 1 &&
    alternatives.every((a) => policyTerms.has(unwrap(a)) || a.includes("current_setting("))
  );
}

function prepare(raw: string, ownNames: readonly string[]): string {
  let f = raw
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/::"?[a-z_][a-z0-9_ ]*"?(\[\])?/gi, "")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    // An inlined array literal's length is a value, not a different filter.
    .replace(/ARRAY\[\?(?:, \?)*\]/g, "ARRAY[?]")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
  for (const name of new Set(ownNames.filter((n) => n !== ""))) {
    f = f.replace(new RegExp(`\\b${escapeRegExp(name)}\\.`, "g"), "");
  }
  return f.trim();
}

function referencesColumn(term: string): boolean {
  const idents = term.match(/\b[a-z_][a-z0-9_]*\b(?!\s*\()/gi) ?? [];
  return idents.some((w) => !KEYWORDS.has(w.toLowerCase()) && !/^col\d+$/.test(w));
}

/** Strip parentheses that wrap the whole of `t`. */
function unwrap(t: string): string {
  let s = t.trim();
  while (s.startsWith("(") && closingParen(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
  return s;
}

/** Split `f` at top-level occurrences of `sep` (" AND " / " OR "). */
function splitTop(f: string, sep: string): string[] {
  const s = unwrap(f);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      start = i + sep.length;
    }
  }
  out.push(s.slice(start));
  return out.map((t) => t.trim()).filter((t) => t !== "");
}

function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`);
}

/** Whether `rule` covers `finding` (`*` globs in table and op; filter exact). */
export function ruleMatches(rule: GateRule, finding: ScanFinding): boolean {
  if (!globRegExp(rule.table).test(finding.relation)) return false;
  if (rule.op !== undefined && !globRegExp(rule.op).test(finding.op)) return false;
  if (rule.filter !== undefined && rule.filter !== finding.filter) return false;
  if (rule.kind !== undefined && rule.kind !== finding.kind) return false;
  return true;
}

/** The gate's verdict over one run. */
export interface GateVerdict {
  /** Distinct findings nothing explains: each one fails the gate. */
  readonly violations: readonly ScanFinding[];
  /** Whole-index walks with a filter: listed for a reviewer, never failing. */
  readonly advisory: readonly ScanFinding[];
  readonly allowed: number;
  readonly pending: number;
  /** Core FK findings left to the schema lint. */
  readonly coveredByFkLint: number;
  /** Entries of the lists that matched nothing: each one fails the gate. */
  readonly stale: readonly GateRule[];
}

const PLUGIN_SCHEMA = /^plugin_[a-z0-9_]+\./;

/** Distinct findings of a run, one per (op, relation, filter, kind). */
export function distinctFindings(
  entries: readonly PlanEntry[],
  catalog: Catalog = EMPTY_CATALOG,
): ScanFinding[] {
  const byKey = new Map<string, ScanFinding>();
  for (const entry of entries) {
    for (const f of scansOf(entry, catalog)) {
      const key = `${f.kind}|${f.op}|${f.relation}|${f.filter}`;
      if (!byKey.has(key)) byKey.set(key, f);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.relation.localeCompare(b.relation) ||
      a.op.localeCompare(b.op) ||
      a.filter.localeCompare(b.filter),
  );
}

/** Judge `findings` against the allowlist and the pending list. */
export function evaluate(
  findings: readonly ScanFinding[],
  allowed: readonly GateRule[] = ALLOWED,
  pending: readonly GateRule[] = PENDING,
): GateVerdict {
  const used = new Set<GateRule>();
  const violations: ScanFinding[] = [];
  let allowedCount = 0;
  let pendingCount = 0;
  let coveredByFkLint = 0;
  const advisory: ScanFinding[] = [];
  for (const f of findings) {
    if (f.kind === "fk" && !PLUGIN_SCHEMA.test(f.relation)) {
      coveredByFkLint++;
      continue;
    }
    // A whole-index walk is reported, never gated: on a near-empty test
    // table it costs the same as the lookup a join or a cursor would do with
    // rows, so it does not prove a missing index the way a Seq Scan under
    // `enable_seqscan=off` does.
    if (f.scan === "index") {
      advisory.push(f);
      continue;
    }
    const allow = allowed.find((r) => ruleMatches(r, f));
    if (allow) {
      used.add(allow);
      allowedCount++;
      continue;
    }
    const known = pending.find((r) => ruleMatches(r, f));
    if (known) {
      used.add(known);
      pendingCount++;
      continue;
    }
    violations.push(f);
  }
  const stale = [...allowed, ...pending].filter((r) => !used.has(r));
  return {
    violations,
    advisory,
    allowed: allowedCount,
    pending: pendingCount,
    coveredByFkLint,
    stale,
  };
}

/** The gate's Markdown report (CI step summary + log). */
export function renderReport(verdict: GateVerdict, entries: number): string {
  const out: string[] = ["## Query index gate", ""];
  out.push(
    `${entries} distinct Seq Scan plans from Query API transactions; ${verdict.allowed} findings allowlisted, ${verdict.pending} pending a tracked fix, ${verdict.coveredByFkLint} core FK checks left to the FK index lint.`,
    "",
  );
  if (verdict.violations.length > 0) {
    out.push(`### ${verdict.violations.length} unindexed filter(s)`, "");
    out.push(
      "Each is a query whose filter no index serves (the run uses `enable_seqscan=off`). Add an index (a migration), or — for a singleton table or a deliberate full read — an `ALLOWED` entry with its reason in `scripts/query-index-gate/allowlist.ts`. See docs/dev/query-index-gate.md.",
      "",
    );
    for (const v of verdict.violations) out.push(...findingLines(v));
    out.push("");
  }
  if (verdict.stale.length > 0) {
    out.push(`### ${verdict.stale.length} stale list entr(y/ies)`, "");
    out.push(
      "These entries matched no finding in this run: the index exists now or the query is gone. Delete them from `scripts/query-index-gate/allowlist.ts`.",
      "",
    );
    for (const s of verdict.stale) out.push(`- ${JSON.stringify(s)}`);
    out.push("");
  }
  if (verdict.advisory.length > 0) {
    out.push(
      `<details><summary>${verdict.advisory.length} whole-index walks with a filter (advisory, not gated)</summary>`,
      "",
      "The planner walked a whole index for its order and filtered each row. On a near-empty test table that can be a cost tie with the lookup it takes on real data, so these do not fail the gate; one on a growing table is worth a look.",
      "",
    );
    for (const a of verdict.advisory) out.push(...findingLines(a));
    out.push("", "</details>", "");
  }
  if (verdict.violations.length === 0 && verdict.stale.length === 0) out.push("Gate passed.");
  return out.join("\n");
}

function findingLines(f: ScanFinding): string[] {
  return [
    `- \`${f.relation}\` · op \`${f.op}\` · ${f.kind === "fk" ? "FK check" : "filter"} \`${f.filter}\``,
    `  - statement: \`${f.sample.replace(/`/g, "'")}\``,
  ];
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "string" },
      policies: { type: "string" },
      indexes: { type: "string" },
    },
    allowPositionals: true,
  });
  const logPath = positionals[0];
  if (!logPath || !values.policies || !values.indexes) {
    console.error(
      "usage: bun scripts/query-index-gate/analyze.ts <filtered-plan-log> --policies <policies.tsv> --indexes <indexes.tsv> [--json <out>]",
    );
    process.exit(2);
  }
  const catalog: Catalog = {
    policies: parseCatalogTsv(await Bun.file(values.policies).text()),
    leadingColumns: parseCatalogTsv(await Bun.file(values.indexes).text()),
  };
  if (catalog.policies.size === 0 || catalog.leadingColumns.size === 0) {
    console.error(
      `[query-index-gate] the catalog dumps (${values.policies}, ${values.indexes}) are empty: the dump step failed. Every table has an RLS policy and a primary key, so the gate cannot judge plans without them.`,
    );
    process.exit(1);
  }
  const entries = parsePlanLog(await Bun.file(logPath).text());
  if (entries.length === 0) {
    console.error(
      `[query-index-gate] ${logPath} holds no tagged Seq Scan plans: auto_explain did not log, or the adapter no longer tags its transactions (packages/query-api/src/statement-tag.ts). Failing rather than passing an empty run.`,
    );
    process.exit(1);
  }
  const findings = distinctFindings(entries, catalog);
  const verdict = evaluate(findings);
  const report = renderReport(verdict, entries.length);
  console.log(report);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${report}\n`);
  if (values.json) {
    await Bun.write(values.json, JSON.stringify({ findings, verdict }, null, 2));
  }
  process.exit(verdict.violations.length > 0 || verdict.stale.length > 0 ? 1 : 0);
}
