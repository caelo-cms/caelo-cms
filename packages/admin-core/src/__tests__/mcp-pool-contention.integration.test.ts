// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1375 — parallel MCP sessions on the shared draft must not make
 * every content-instance read slower with every edit any of them made.
 *
 * Production, 2026-11-03 (searchVIU, v0.11.9/v0.11.10, db-f1-micro): up to
 * ten Power-MCP sessions wrote to the shared draft all morning. The branch
 * view of content instances (`content-instance-refs.ts`, reached from
 * `content_instances.get` / `.list` / `set_values_many`, `lists.list` and
 * `page_module_content.*` through the instance reach) read EVERY pending
 * content-instance snapshot of the draft, with its full state, sorted it
 * and kept the newest per instance. The Cloud SQL log showed 83 statement
 * timeouts of exactly that statement and 68 temp-file spills; each held a
 * pooled connection for 60 s, and the admin answered nothing for 30–45
 * minutes. The reach's page-layout overlay and the link checker's overlays
 * had the same shape.
 *
 * Here: N agents open their own sessions and edit their own instance M
 * times each, in parallel, so the draft's pending history holds N×M
 * content-instance snapshots. Every agent then reads in parallel and sees
 * the newest state, and a branch-view read fetches one snapshot row per
 * pending instance from the draft head — not the N×M rows of history.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DatabaseAdapter,
  execute,
  OperationRegistry,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { loadContentInstanceReach } from "../ops/content/content-instance-reach.js";
import { findContentInstancesOfModules } from "../ops/content/content-instance-refs.js";
import type { McpRemoteCredential } from "../ops/security/mcp_credential.js";
import { powerExecuteTool, powerOpenSession } from "../ops/security/mcp_power.js";
import { type McpPrincipal, resolveRemoteMcpPrincipal } from "../ops/security/mcp_principal.js";
import { configureMcpBridge, type SendChatBridgeOpts } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";
import { createIapVerifier, setIapVerifierForTests } from "../security/iap-assertion.js";
import { iapTestKeyPair, signIapTestAssertion } from "../security/iap-assertion.test-helpers.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const AUDIENCE = "/projects/42/locations/europe-west1/services/caelo-admin";
const KEY = iapTestKeyPair("t1375-kid");
const OWNER = { id: "00000000-0000-4000-8137-500000000001", email: "owner@t1375.test" };
/** Parallel agent sessions, as on the affected install. */
const AGENTS = 8;
/** Edits each agent makes to its own instance. */
const EDITS = 12;
const CLIENT = "dcr:Claude Code";
const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1375-system",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let bridge: SendChatBridgeOpts;

function cred(): McpRemoteCredential {
  return {
    iapCredential: signIapTestAssertion(KEY, { aud: AUDIENCE, email: OWNER.email }),
    surface: "admin",
    client: CLIENT,
  };
}

async function principal(): Promise<McpPrincipal> {
  const r = await resolveRemoteMcpPrincipal(adapter, cred());
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function call(
  chatSessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const r = await powerExecuteTool(bridge, await principal(), { toolName, args, chatSessionId });
  if (!r.ok) throw new Error(r.message);
  return r.value as { ok: boolean; content: string };
}

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    return await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await conn.end();
  }
}

/**
 * Rows `fn` fetched from `content_instance_snapshots`, read from the
 * transaction's own statistics (`pg_stat_xact_user_tables` counts the
 * current transaction synchronously). Sequential scans, bitmap scans and
 * hash / merge joins are switched off and joins run in the written order,
 * so every row is fetched by an index lookup driven by the table the query
 * starts from, and the count shows what the query asks for — not the
 * planner's choice for a small, unanalysed test table (a hash join over
 * the whole table is cheapest there and would count every row of it).
 */
async function snapshotRowsFetched(
  chatBranchId: string,
  fn: (tx: TransactionRunner) => Promise<unknown>,
): Promise<number> {
  return adapter.withAdminTransaction(
    { ...systemCtx, chatBranchId },
    async (tx) => {
      for (const knob of [
        "enable_seqscan",
        "enable_bitmapscan",
        "enable_hashjoin",
        "enable_mergejoin",
      ]) {
        await tx.execute(sql`SELECT set_config(${knob}, 'off', true)`);
      }
      // Join in the order the query is written, so the table the query
      // starts from drives the lookups into the other.
      await tx.execute(sql`SELECT set_config('join_collapse_limit', '1', true)`);
      await tx.execute(sql`SELECT set_config('from_collapse_limit', '1', true)`);
      const before = await fetched(tx);
      await fn(tx);
      return (await fetched(tx)) - before;
    },
    { holder: "t1375.rows-fetched" },
  );
}

async function fetched(tx: TransactionRunner): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT (COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0))::int AS n
      FROM pg_stat_xact_user_tables WHERE relname = 'content_instance_snapshots'
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${OWNER.id}::uuid, 'human', ${OWNER.email}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${OWNER.id}::uuid, ${OWNER.email}, 'test-only') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${OWNER.id}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
  });
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => AUDIENCE,
      keys: async () => ({ [KEY.kid]: KEY.publicPem }),
    }),
  );
  bridge = { adapter, registry, resolveProvider: async () => null };
  configureMcpBridge(bridge);
});

afterAll(async () => {
  setIapVerifierForTests(null);
  await adapter.close();
});

describe("#1375 — parallel MCP sessions and the draft's content-instance history", () => {
  it("N sessions edit in parallel; reads see the newest state and fetch one row per instance", async () => {
    const created = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: "t1375-card",
      displayName: "t1375 card",
      html: "<div>{{body}}</div>",
      fields: [{ name: "body", kind: "text", label: "Body" } as never],
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const moduleId = (created.value as { moduleId: string }).moduleId;
    const instances: string[] = [];
    for (let i = 0; i < AGENTS; i++) {
      const r = await execute(registry, adapter, systemCtx, "content_instances.create", {
        moduleId,
        slug: `t1375-card-${i}`,
        values: { body: "start" },
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      instances.push((r.value as { contentInstanceId: string }).contentInstanceId);
    }

    const sessions = await Promise.all(
      Array.from({ length: AGENTS }, async (_, i) => {
        const r = await powerOpenSession(bridge, await principal(), { title: `t1375 agent ${i}` });
        if (!r.ok) throw new Error(r.message);
        return r.value;
      }),
    );
    const branchId = sessions[0]?.chatBranchId as string;
    expect(new Set(sessions.map((s) => s.chatBranchId)).size).toBe(1);

    // Every agent edits its own instance EDITS times; the agents run in parallel.
    await Promise.all(
      sessions.map(async (s, i) => {
        for (let e = 0; e < EDITS; e++) {
          const r = await call(s.chatSessionId, "set_content_instance_values_many", {
            items: [{ id: instances[i], values: { body: `agent ${i} edit ${e}` } }],
          });
          expect(r.ok).toBe(true);
        }
      }),
    );
    // The draft may hold other files' pending work too (one database per
    // run): compare against what the draft holds, not against constants.
    const counts = await withSql(
      async (tx) =>
        (await tx`
          SELECT
            (SELECT count(*)::int FROM content_instance_snapshots cis
               JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
              WHERE ss.chat_branch_id = ${branchId}::uuid
                AND ss.staged_at IS NULL AND ss.undone_at IS NULL) AS history,
            (SELECT count(*)::int FROM draft_pending_entities d
              WHERE d.chat_branch_id = ${branchId}::uuid
                AND d.entity_kind = 'contentInstance') AS head
        `) as { history: number; head: number }[],
    );
    const history = counts[0]?.history ?? 0;
    const head = counts[0]?.head ?? 0;
    // Each agent's EDITS edits stack up as history; the head keeps one row
    // per instance and owner.
    expect(history - head).toBeGreaterThanOrEqual(AGENTS * (EDITS - 1));

    // Every agent reads in parallel and sees the newest state of every instance.
    const reads = await Promise.all(
      sessions.map((s, i) =>
        call(s.chatSessionId, "get_content_instance", {
          id: instances[(i + 1) % AGENTS],
        }),
      ),
    );
    reads.forEach((r, i) => {
      expect(r.ok).toBe(true);
      expect(r.content).toContain(`agent ${(i + 1) % AGENTS} edit ${EDITS - 1}`);
    });

    // Fresh statistics, as autovacuum keeps them on a real install: the
    // planner then drives the overlay from the small head, not from the
    // snapshot table it cannot narrow.
    await withSql(async (tx) => {
      await tx.unsafe("ANALYZE content_instance_snapshots, draft_pending_entities, site_snapshots");
    });

    // The branch view fetches the head's row per pending instance, not the
    // history (before #1375 it fetched all `history` rows).
    const ofModule = await snapshotRowsFetched(branchId, async (tx) => {
      const found = await findContentInstancesOfModules(tx, branchId, [moduleId]);
      const mine = found.filter((f) => instances.includes(f.contentInstanceId));
      expect(mine).toHaveLength(AGENTS);
      for (const f of mine) {
        const i = instances.indexOf(f.contentInstanceId);
        expect(JSON.parse(f.valuesText)).toEqual({ body: `agent ${i} edit ${EDITS - 1}` });
      }
    });
    expect(ofModule).toBeLessThanOrEqual(head);

    // The whole reach of one instance (parents, lists, placements, pages)
    // stays below the history too.
    const reach = await snapshotRowsFetched(branchId, (tx) =>
      loadContentInstanceReach(tx, branchId, [instances[0] as string]),
    );
    expect(reach).toBeLessThanOrEqual(head);
  }, 180_000);
});
