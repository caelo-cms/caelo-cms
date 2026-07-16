// SPDX-License-Identifier: MPL-2.0

/**
 * CLAUDE.md §11.A — `redirects.delete_many` with a `matches` substring is
 * capped for AI actors: "Hard to predict the blast radius of a regex-style
 * match."
 *
 * `matches` compiles to an unbounded `ILIKE '%<matches>%'`, so `matches: "/"`
 * matches every rooted path — i.e. every redirect on the site. Before this
 * guard the only thing between the AI and that was a sentence in the tool
 * description ("Always run find_redirects FIRST"): a prompt, not a boundary
 * (§2). Every deleted 301 strands an inbound link and the recovery is
 * "manually re-create N redirects" — §11.A's own definition of hard-to-revert.
 *
 * Real Postgres per §6.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "redir-gate-ai",
};
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "human",
  requestId: "redir-gate-human",
};

const PFX = "/redirgate";

/** Live redirect rows under our prefix. RLS needs caelo.actor_kind set. */
async function countUnder(prefix: string): Promise<number> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT count(*)::int AS n FROM redirects WHERE from_path LIKE ${`${prefix}%`}
      `) as unknown as { n: number }[];
      return rows[0]?.n ?? 0;
    });
  } finally {
    await sql.end();
  }
}

async function seed(n: number, prefix: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await execute(registry, adapter, HUMAN, "redirects.create", {
      fromPath: `${prefix}-${i}`,
      toPath: "/",
      statusCode: 301,
    });
    if (!r.ok) throw new Error(`seed ${prefix}-${i}`);
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE from_path LIKE ${`${PFX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("redirects.delete_many — `matches` is capped for AI (§11.A)", () => {
  it("REJECTS an AI matches-delete at/over the limit and deletes NOTHING", async () => {
    const prefix = `${PFX}-big`;
    await seed(12, prefix);
    expect(await countUnder(prefix)).toBe(12);

    const r = await execute(registry, adapter, AI, "redirects.delete_many", { matches: prefix });
    expect(r.ok).toBe(false);

    // The rejection must be actionable — name the count and the way forward.
    if (!r.ok) {
      const msg = JSON.stringify(r.error);
      expect(msg).toContain("12");
      expect(msg).toContain("find_redirects");
      expect(msg).toContain("redirectIds");
    }

    // The whole point: nothing was deleted on the way to finding out.
    expect(await countUnder(prefix)).toBe(12);
  });

  it("ALLOWS an AI matches-delete under the limit", async () => {
    const prefix = `${PFX}-small`;
    await seed(3, prefix);

    const r = await execute(registry, adapter, AI, "redirects.delete_many", { matches: prefix });
    expect(r.ok).toBe(true);
    expect((r.value as { deleted: number }).deleted).toBe(3);
    expect(await countUnder(prefix)).toBe(0);
  });

  it("ALLOWS a HUMAN matches-delete over the limit — the human IS the decision", async () => {
    const prefix = `${PFX}-human`;
    await seed(12, prefix);

    const r = await execute(registry, adapter, HUMAN, "redirects.delete_many", { matches: prefix });
    expect(r.ok).toBe(true);
    expect((r.value as { deleted: number }).deleted).toBe(12);
    expect(await countUnder(prefix)).toBe(0);
  });

  it("ALLOWS an AI delete of MANY explicit redirectIds — enumeration is the review", async () => {
    const prefix = `${PFX}-ids`;
    await seed(12, prefix);
    const listed = await execute(registry, adapter, AI, "redirects.list", {});
    if (!listed.ok) throw new Error("list");
    const ids = (listed.value as { redirects: { id: string; fromPath: string }[] }).redirects
      .filter((x) => x.fromPath.startsWith(prefix))
      .map((x) => x.id);
    expect(ids).toHaveLength(12);

    const r = await execute(registry, adapter, AI, "redirects.delete_many", { redirectIds: ids });
    expect(r.ok).toBe(true);
    expect(await countUnder(prefix)).toBe(0);
  });

  it("the catastrophic case: AI cannot wipe every redirect with matches='/'", async () => {
    const prefix = `${PFX}-all`;
    await seed(12, prefix);

    // '/' ILIKE-matches every rooted from_path on the site.
    const r = await execute(registry, adapter, AI, "redirects.delete_many", { matches: "/" });
    expect(r.ok).toBe(false);
    expect(await countUnder(prefix)).toBe(12);
  });
});
