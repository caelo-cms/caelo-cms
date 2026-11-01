// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 (rule 7 of docs/dev/state-and-changes.md) — a
 * `readScope: "request"` operation costs what the request names, not what
 * the site holds.
 *
 * Each op of the inputs registry (rows-read/inputs.ts) runs once on the
 * small fixture and once on the same fixture grown 10x along every history
 * dimension (rows-read/fixture.ts). Per call, with `pg_stat_statements`
 * reset right before it, the test reads the number of statements, the rows
 * they returned and the buffers they touched (`shared_blks_hit +
 * shared_blks_read`). The op fails when the large run issues a different
 * number of statements, or returns or touches more than 1.5x what the
 * small run did. (`pg_stat_user_tables` is not used: it is flushed
 * asynchronously and misses index-only scans.) A few buffers per statement
 * are allowed on top: a 10x larger index can be one B-tree level deeper,
 * which is the cost of an index lookup growing as log n, not as n.
 *
 * Ops that do not meet it yet are on {@link ALLOWLIST}, each with the
 * issue that fixes it; the test fails when an allowlisted op meets the
 * bar, so the list only shrinks. It is empty once #1268, #1269 and #1270
 * are closed.
 *
 * Opt-in (`CAELO_ROWS_READ=1`): it needs a dedicated database with
 * `pg_stat_statements` loaded, the extension created and its reset granted
 * to admin_role, and nothing else running against it — the PR CI job
 * `rows-read` provides exactly that. Every background worker is off: this
 * process starts none.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { clearSiteFontUsageCache } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { clearSiteViewCache } from "../site-view.js";
import { type FixtureRefs, growFixture, LARGE, SMALL } from "./rows-read/fixture.js";
import { ROWS_READ_INPUTS } from "./rows-read/inputs.js";

const ENABLED = process.env.CAELO_ROWS_READ === "1";
const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? "";
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL ?? "";

/**
 * Ops that do not stay O(request) yet, and the issue that fixes each
 * (`FIXME(#n)`). Shrinks to empty; never grows without a tracked issue.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  // Reads the whole site: link humanising, page tree, unbounded lists.
  "pages.list": "FIXME(#1269) unbounded, one bind parameter per page",
  "content_instances.list": "FIXME(#1269) unbounded",
  "lists.list": "FIXME(#1269) usage of every list over every module and instance",
  "lists.get": "FIXME(#1269) link humanising reads every page and medium",
  "list_types.list": "FIXME(#1269) usage counts over every list",
  "page_types.list": "FIXME(#1269) page counts over every page",
  "site_defaults.get": "FIXME(#1269) reads every page to describe the defaults",
  "content_instances.get": "FIXME(#1269) reach and link humanising read the whole site",
  "content_instances.set_values": "FIXME(#1269) reach and link canonicalising read the whole site",
};

interface Cost {
  readonly statements: number;
  readonly rows: number;
  readonly blocks: number;
  /** The call failed (a statement timeout on the large fixture is the usual one). */
  readonly error?: string;
}

/** Buffers one statement may touch on top of 1.5x: one more B-tree level per lookup. */
const BLOCKS_PER_STATEMENT_SLACK = 4;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let stats: SQL;
const small = new Map<string, Cost>();
const large = new Map<string, Cost>();

async function measure(ctx: ExecutionContext, op: string, input: unknown): Promise<Cost> {
  clearSiteViewCache();
  clearSiteFontUsageCache();
  await stats`SELECT pg_stat_statements_reset()`;
  const r = await execute(registry, adapter, ctx, op, input);
  const error = r.ok
    ? undefined
    : `${r.error.kind}${"pgDetail" in r.error && r.error.pgDetail ? ` ${JSON.stringify(r.error.pgDetail)}` : ""}`;
  const rows = (await stats`
    SELECT COALESCE(sum(calls), 0)::int AS statements,
           COALESCE(sum(rows), 0)::bigint AS rows,
           COALESCE(sum(shared_blks_hit + shared_blks_read), 0)::bigint AS blocks
      FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       -- Statements the op sent; a function's inner statements count into
       -- its caller's buffers, not as statements of their own.
       AND toplevel
       AND query NOT ILIKE '%pg_stat_statements%'
  `) as { statements: number; rows: string; blocks: string }[];
  const row = rows[0];
  return {
    statements: row?.statements ?? 0,
    rows: Number(row?.rows ?? 0),
    blocks: Number(row?.blocks ?? 0),
    ...(error ? { error } : {}),
  };
}

async function measureAll(refs: FixtureRefs, size: "small" | "large", into: Map<string, Cost>) {
  const system: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system",
    requestId: "rows-read",
  };
  for (const entry of ROWS_READ_INPUTS) {
    const ctx = entry.ctx === "chat" ? refs.chat : system;
    // Warm-up call first: a chat's first write takes its locks and the
    // process's first call verifies the database roles — one-time costs
    // that are not what grows with the site.
    await execute(registry, adapter, ctx, entry.op, entry.input(refs, `${size}-warm`));
    into.set(entry.op, await measure(ctx, entry.op, entry.input(refs, size)));
  }
}

/** Why `big` is not within the bar of `base`, or null when it is. */
export function exceedsBar(base: Cost, big: Cost): string | null {
  if (base.error) return `fails on the small fixture: ${base.error}`;
  if (big.error) return `fails on the large fixture: ${big.error}`;
  if (big.statements !== base.statements) {
    return `statements ${base.statements} → ${big.statements}`;
  }
  if (big.rows > base.rows * 1.5) return `rows ${base.rows} → ${big.rows}`;
  if (big.blocks > base.blocks * 1.5 + BLOCKS_PER_STATEMENT_SLACK * base.statements) {
    return `buffers ${base.blocks} → ${big.blocks}`;
  }
  return null;
}

describe.skipIf(!ENABLED)("#1267 — request-scoped ops do not read more on a larger site", () => {
  beforeAll(async () => {
    if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");
    adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
    registry = new OperationRegistry();
    registerAdminOps(registry);
    stats = new SQL(ADMIN_URL, { max: 1 });
    const deps = { adapter, registry, adminUrl: ADMIN_URL };
    const refsSmall = await growFixture(deps, SMALL);
    await measureAll(refsSmall, "small", small);
    const refsLarge = await growFixture(deps, LARGE);
    await measureAll(refsLarge, "large", large);
  }, 900_000);

  afterAll(async () => {
    await stats?.end();
    await adapter?.close();
  });

  it("the bar itself: equal statements, at most 1.5x rows and buffers", () => {
    const base = { statements: 4, rows: 10, blocks: 100 };
    expect(exceedsBar(base, { statements: 4, rows: 15, blocks: 166 })).toBeNull();
    expect(exceedsBar(base, { statements: 5, rows: 10, blocks: 100 })).toContain("statements");
    expect(exceedsBar(base, { statements: 4, rows: 16, blocks: 100 })).toContain("rows");
    expect(exceedsBar(base, { statements: 4, rows: 10, blocks: 200 })).toContain("buffers");
    expect(exceedsBar(base, { ...base, error: "timeout" })).toContain("large fixture");
  });

  it("every measured op is a request-scoped op, and every allowlisted op is measured", () => {
    for (const entry of ROWS_READ_INPUTS) {
      const op = registry.lookup(entry.op);
      expect({ op: entry.op, ok: op.ok }).toEqual({ op: entry.op, ok: true });
      if (op.ok)
        expect({ op: entry.op, scope: op.value.readScope }).toEqual({
          op: entry.op,
          scope: "request",
        });
    }
    const measured = new Set(ROWS_READ_INPUTS.map((e) => e.op));
    expect(Object.keys(ALLOWLIST).filter((op) => !measured.has(op))).toEqual([]);
    for (const reason of Object.values(ALLOWLIST))
      expect(reason).toMatch(/^FIXME\(#(1268|1269|1270)\) /);
  });

  it("stays within the bar, or is on the allowlist — and the allowlist only shrinks", () => {
    const report: string[] = [];
    const failures: string[] = [];
    const nowCompliant: string[] = [];
    for (const entry of ROWS_READ_INPUTS) {
      const base = small.get(entry.op);
      const big = large.get(entry.op);
      if (!base || !big) throw new Error(`${entry.op}: not measured`);
      const why = exceedsBar(base, big);
      report.push(
        `${entry.op}: statements ${base.statements}/${big.statements}, rows ${base.rows}/${big.rows}, buffers ${base.blocks}/${big.blocks}${why ? ` — ${why}` : ""}`,
      );
      if (why && !(entry.op in ALLOWLIST)) failures.push(`${entry.op}: ${why}`);
      if (!why && entry.op in ALLOWLIST) nowCompliant.push(entry.op);
    }
    console.log(`[rows-read] small/large per op:\n${report.join("\n")}`);
    expect(failures).toEqual([]);
    // Remove these from ALLOWLIST: they meet the bar now.
    expect(nowCompliant).toEqual([]);
  });
});
