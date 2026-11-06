// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1269 — the plans of the gate's slow statements.
 *
 * `pg_stat_statements` says which statements took the database's time, not
 * why: a statement that costs 8 s under load and 6 buffers in a local
 * repro has a different plan in the gate, and only the gate's own plan
 * shows it. So the gate's Postgres runs `auto_explain` with `log_analyze`
 * and `log_buffers` (timing off: per-node clocks are what makes analyze
 * expensive, and the gate's CPU share is a fifth of a core), and every
 * statement over `log_min_duration` lands in the Postgres log as a JSON
 * plan. This file reads those plans back for the report: grouped by
 * statement text, each group with its count, total and slowest duration,
 * and the slowest plan rendered as an indented tree with actual rows,
 * loops and buffers per node.
 */

/** One statement's plan, as `auto_explain` logged it. */
export interface LoggedPlan {
  readonly durationMs: number;
  /** The statement text, whitespace collapsed. */
  readonly query: string;
  /** The `Plan` object of the JSON explain output. */
  readonly plan: PlanNode;
}

/** A node of a JSON explain plan (only the keys the report reads are typed). */
export interface PlanNode {
  readonly "Node Type"?: string;
  readonly Plans?: readonly PlanNode[];
  readonly [key: string]: unknown;
}

/** The slow statements of one text, slowest plan kept. */
export interface SlowPlanGroup {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  /** The statement text, cut at 400 characters. */
  readonly query: string;
  /** The slowest occurrence's plan, rendered (see `renderPlan`). */
  readonly plan: string;
}

/** The first line of an `auto_explain` entry (default `log_line_prefix`, `%m [%p] `). */
const PLAN_HEADER = /LOG: {2}duration: ([\d.]+) ms {2}plan:\s*$/;

/**
 * The plans `auto_explain` (`log_format=json`) wrote into `log`. Postgres
 * writes a plan's lines after its header line, each indented with a tab;
 * the entry ends at the next line that is not. An entry whose JSON does
 * not parse (a line cut by the log driver) is skipped, not guessed at.
 */
export function parseLoggedPlans(log: string): LoggedPlan[] {
  const lines = log.split("\n");
  const plans: LoggedPlan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = PLAN_HEADER.exec(lines[i] ?? "");
    if (!header) continue;
    const body: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1] ?? "").startsWith("\t")) {
      body.push((lines[i + 1] ?? "").slice(1));
      i++;
    }
    let parsed: { "Query Text"?: unknown; Plan?: unknown };
    try {
      parsed = JSON.parse(body.join("\n")) as typeof parsed;
    } catch {
      continue;
    }
    if (typeof parsed.Plan !== "object" || parsed.Plan === null) continue;
    plans.push({
      durationMs: Number(header[1]),
      query: String(parsed["Query Text"] ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      plan: parsed.Plan as PlanNode,
    });
  }
  return plans;
}

/** The `limit` statement texts with the most logged time, heaviest first. */
export function groupSlowPlans(plans: readonly LoggedPlan[], limit: number): SlowPlanGroup[] {
  const groups = new Map<string, { count: number; totalMs: number; slowest: LoggedPlan }>();
  for (const p of plans) {
    const g = groups.get(p.query);
    if (!g) {
      groups.set(p.query, { count: 1, totalMs: p.durationMs, slowest: p });
      continue;
    }
    g.count += 1;
    g.totalMs += p.durationMs;
    if (p.durationMs > g.slowest.durationMs) g.slowest = p;
  }
  return [...groups.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
    .map((g) => ({
      count: g.count,
      totalMs: Math.round(g.totalMs),
      maxMs: Math.round(g.slowest.durationMs),
      query: g.slowest.query.slice(0, 400),
      plan: renderPlan(g.slowest.plan),
    }));
}

/** Conditions worth showing per node, in this order. */
const CONDITIONS = [
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Filter",
] as const;

/**
 * A plan as an indented tree, one node per line: the node, what it reads,
 * actual rows × loops, the buffers it touched (its subtree's, as explain
 * counts them) and its conditions. Rows removed by a filter are shown,
 * since a filter that throws away most of what an index returned is the
 * usual reason a cheap-looking plan is not.
 */
export function renderPlan(node: PlanNode, depth = 0): string {
  const str = (key: string) => (typeof node[key] === "string" ? (node[key] as string) : null);
  const num = (key: string) => (typeof node[key] === "number" ? (node[key] as number) : null);
  const head = [
    str("Parent Relationship") === "SubPlan" || str("Subplan Name")
      ? `[${str("Subplan Name") ?? "SubPlan"}] `
      : "",
    node["Node Type"] ?? "?",
    str("Index Name") ? ` using ${str("Index Name")}` : "",
    str("Relation Name") ? ` on ${str("Relation Name")}` : "",
    str("CTE Name") ? ` on CTE ${str("CTE Name")}` : "",
    str("Function Name") ? ` on ${str("Function Name")}()` : "",
  ].join("");
  const hit = num("Shared Hit Blocks") ?? 0;
  const read = num("Shared Read Blocks") ?? 0;
  const stats = [
    `rows=${num("Actual Rows") ?? "?"}`,
    `loops=${num("Actual Loops") ?? "?"}`,
    `buffers=${hit + read}${read > 0 ? ` (read ${read})` : ""}`,
    num("Rows Removed by Filter") ? `removed by filter=${num("Rows Removed by Filter")}` : "",
    num("Rows Removed by Index Recheck")
      ? `removed by recheck=${num("Rows Removed by Index Recheck")}`
      : "",
  ].filter(Boolean);
  const conditions = CONDITIONS.flatMap((k) => (str(k) ? [`${k}: ${str(k)}`] : []));
  const pad = "  ".repeat(depth);
  const lines = [
    `${pad}${head} (${stats.join(" ")})`,
    ...conditions.map((c) => `${pad}    ${c}`),
    ...(node.Plans ?? []).map((child) => renderPlan(child, depth + 1)),
  ];
  return lines.join("\n");
}
