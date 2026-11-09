// SPDX-License-Identifier: MPL-2.0

/**
 * #1538 — `find_redirects` reaches every rule of a table larger than one
 * page. Before, the tool never passed a page position to `redirects.list`
 * and sliced the op's first ≤200 rows in memory: every offset past them
 * answered nothing, `full` stopped at 200 and an unfiltered read never said
 * how many rules exist. Now the op pages by keyset cursor on `from_path` and
 * counts every matching row, and the tool hands the cursor on.
 *
 * Real Postgres per §6.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry, type ToolContext } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let toolCtx: ToolContext;
const tools = createDefaultToolRegistry();

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "redir-paging-ai",
};
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "human",
  requestId: "redir-paging-human",
};

const PFX = "/redirpaging";
/** More rules than the old 200-row page, 30 of them 410 Gone. */
const SEEDED = 260;
const GONE = 30;
const fromPaths = Array.from(
  { length: SEEDED },
  (_v, i) => `${PFX}/rule-${String(i).padStart(3, "0")}`,
);

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE from_path LIKE ${`${PFX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

/** The fromPath of every TOON row of a find_redirects answer. */
function shownPaths(content: string): string[] {
  return [...content.matchAll(/^ {2}([^,]+),/gm)].map((m) => m[1] as string);
}

async function findRedirects(args: Record<string, unknown>) {
  const r = await tools.dispatch("find_redirects", args, AI, toolCtx);
  expect(r.ok).toBe(true);
  return r.content;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  toolCtx = { adapter, registry };
  await wipe();
  const created = await execute(registry, adapter, HUMAN, "redirects.create_many", {
    redirects: fromPaths.map((fromPath, i) => ({
      fromPath,
      toPath: i < GONE ? "/gone" : "/target",
      statusCode: i < GONE ? 410 : 301,
    })),
  });
  if (!created.ok) throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("redirects.list — keyset paging (#1538)", () => {
  it("next cursor reaches every row, in fromPath order, and counts the whole set", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await execute(registry, adapter, AI, "redirects.list", {
        query: PFX,
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const v = r.value as {
        redirects: { fromPath: string }[];
        totalCount: number;
        nextCursor: string | null;
      };
      expect(v.totalCount).toBe(SEEDED);
      seen.push(...v.redirects.map((x) => x.fromPath));
      cursor = v.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(fromPaths);
  });

  it("refuses a cursor it did not issue, naming the field", async () => {
    const r = await execute(registry, adapter, AI, "redirects.list", { cursor: "not-a-cursor" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("HandlerError");
    expect(JSON.stringify(r.error)).toContain('"path":["cursor"]');
  });

  // Regression (Copilot on #1539): a cursor carried only the last path, so
  // reusing it with another filter silently skipped that filter's rows
  // before the path.
  it("refuses a cursor reused with another query or statusCode", async () => {
    const first = await execute(registry, adapter, AI, "redirects.list", {
      query: PFX,
      limit: 100,
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const cursor = (first.value as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    for (const changed of [{ query: `${PFX}/rule-0` }, { query: PFX, statusCode: 410 }]) {
      const r = await execute(registry, adapter, AI, "redirects.list", {
        ...changed,
        limit: 100,
        cursor,
      });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(JSON.stringify(r.error)).toContain('"path":["cursor"]');
      expect(JSON.stringify(r.error)).toContain("same filter and statusCode");
    }
  });
});

describe("find_redirects — every rule reachable (#1538)", () => {
  it("an unfiltered read says how many rules the table holds", async () => {
    const content = await findRedirects({});
    const total = Number(/ shown of (\d+)/.exec(content)?.[1]);
    expect(total).toBeGreaterThanOrEqual(SEEDED);
    expect(content).toContain("— more exist; next cursor: ");
  });

  it("following next cursor shows every rule once, across the char cap", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 20; call++) {
      // 200 rows outgrow the char cap: each page is re-read to the rows that fit.
      const content = await findRedirects({
        filter: PFX,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      expect(content).toContain(`of ${SEEDED} matching (filter="${PFX}")`);
      seen.push(...shownPaths(content));
      cursor = /next cursor: (\S+)/.exec(content)?.[1];
      if (!cursor) break;
    }
    expect(seen).toEqual(fromPaths);
  });

  it("full returns more than 200 rules in one call", async () => {
    const content = await findRedirects({ filter: PFX, full: true });
    expect(shownPaths(content)).toEqual(fromPaths);
    expect(content).toContain(`# ${SEEDED} shown of ${SEEDED} matching`);
    expect(content).not.toContain("next cursor");
  });

  it("statusCode narrows the count to the matching rules", async () => {
    const content = await findRedirects({ filter: PFX, statusCode: 410, limit: 10 });
    expect(content).toContain(`# 10 shown of ${GONE} matching`);
    expect(shownPaths(content)).toEqual(fromPaths.slice(0, 10));
  });
});
