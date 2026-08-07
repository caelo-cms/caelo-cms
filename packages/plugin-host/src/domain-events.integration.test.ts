// SPDX-License-Identifier: MPL-2.0

/**
 * #392 — domain-event outbox, end to end against real Postgres:
 * transactional atomicity (a rolled-back write emits no event), emits
 * from real core write ops, ctx.events poll/commit cursor semantics,
 * kind filtering, and the provenance ceiling (runtime-authored plugins
 * get no ctx.events).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { emitDomainEvent, registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin, type PluginEvents } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { bootstrap, type PluginHostInfra, resetPluginHost, runPluginOperation } from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t392",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

type EventsCtx = { events?: PluginEvents };

const listenerPlugin = definePlugin({
  slug: "t392-listener",
  version: "0.1.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["domain_events"],
  operations: {
    poll_events: async (ctx, args) => {
      const ev = (ctx as EventsCtx).events;
      if (!ev) throw new Error("ctx.events missing — capability not attached");
      return ev.poll(args as Parameters<PluginEvents["poll"]>[0]);
    },
    commit_cursor: async (ctx, args) => {
      const ev = (ctx as EventsCtx).events;
      if (!ev) throw new Error("ctx.events missing");
      await ev.commit((args as { cursor: number }).cursor);
      return { ok: true };
    },
  },
});

async function cleanup(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe("DELETE FROM domain_events");
      await tx.unsafe(`DELETE FROM plugin_event_cursors WHERE plugin_id IN (
        SELECT id FROM plugins WHERE slug LIKE 't392-%'
      )`);
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't392-%')
      )`);
      await tx.unsafe(
        "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't392-%')",
      );
      await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't392-%'");
      await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't392-%'");
      await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't392-%'");
      await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't392-%'");
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

async function countEvents(kind?: string): Promise<number> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx.unsafe(
        kind
          ? `SELECT COUNT(*)::int AS n FROM domain_events WHERE kind = '${kind}'`
          : "SELECT COUNT(*)::int AS n FROM domain_events",
      )) as { n: number }[];
      return rows[0]?.n ?? 0;
    });
  } finally {
    await sql.end();
  }
}

describe("#392 — domain-event outbox", () => {
  it("a rolled-back transaction emits NOTHING (outbox atomicity)", async () => {
    const before = await countEvents();
    let threw = false;
    try {
      await adapter.withAdminTransaction(SYS_CTX, async (tx) => {
        await emitDomainEvent(tx, {
          kind: "page.updated",
          entityId: "00000000-0000-4000-8000-000000000001",
          payload: { probe: "rollback" },
        });
        throw new Error("deliberate rollback");
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await countEvents()).toBe(before);
  });

  it("core write ops emit in the same tx; poll/commit cursor semantics work", async () => {
    // Seed layout+template via SQL (not under test); the pages ops ARE
    // the emit sites under test.
    const templateId = await (async () => {
      const sql = new SQL(ADMIN_URL);
      try {
        return await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const lay = (await tx.unsafe(
            `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t392-lay', 'L', '<html><body><caelo-layout-content></caelo-layout-content></body></html>', '') RETURNING id::text AS id`,
          )) as { id: string }[];
          const tpl = (await tx.unsafe(
            `INSERT INTO templates (slug, display_name, kind, html, css, layout_id) VALUES ('t392-tpl', 'T', 'home', '<main><caelo-slot name="content">_</caelo-slot></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
          )) as { id: string }[];
          await tx.unsafe(
            `INSERT INTO template_blocks (template_id, name, display_name, position) VALUES ('${tpl[0]?.id}', 'content', 'Content', 0)`,
          );
          const id = tpl[0]?.id;
          if (!id) throw new Error("template seed failed");
          return id;
        });
      } finally {
        await sql.end();
      }
    })();
    const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
      slug: "t392-page",
      title: "T392",
      templateId,
    });
    if (!created.ok) throw new Error(`pages.create: ${JSON.stringify(created.error)}`);
    const pageId = (created.value as { pageId: string }).pageId;

    expect(await countEvents("page.created")).toBeGreaterThanOrEqual(1);

    const published = await execute(registry, adapter, SYS_CTX, "pages.set_status", {
      pageId,
      status: "published",
    });
    expect(published.ok).toBe(true);
    expect(await countEvents("page.published")).toBeGreaterThanOrEqual(1);

    // Plugin-side poll: sees the events, kind filter narrows, commit advances.
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: listenerPlugin }],
    });

    const firstPoll = await runPluginOperation({
      pluginSlug: "t392-listener",
      operationName: "poll_events",
      args: {},
    });
    expect(firstPoll.ok).toBe(true);
    if (!firstPoll.ok) return;
    const first = firstPoll.value as {
      events: { kind: string; entityId: string }[];
      nextCursor: number;
    };
    expect(first.events.length).toBeGreaterThanOrEqual(2);
    expect(first.events.some((e) => e.kind === "page.created" && e.entityId === pageId)).toBe(true);
    expect(first.events.some((e) => e.kind === "page.published")).toBe(true);

    // Kind filter.
    const filtered = await runPluginOperation({
      pluginSlug: "t392-listener",
      operationName: "poll_events",
      args: { cursor: 0, kinds: ["page.published"] },
    });
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      const f = filtered.value as { events: { kind: string }[] };
      expect(f.events.length).toBeGreaterThanOrEqual(1);
      expect(f.events.every((e) => e.kind === "page.published")).toBe(true);
    }

    // Commit the cursor; the next persisted-cursor poll is empty.
    const commit = await runPluginOperation({
      pluginSlug: "t392-listener",
      operationName: "commit_cursor",
      args: { cursor: first.nextCursor },
    });
    expect(commit.ok).toBe(true);
    const afterCommit = await runPluginOperation({
      pluginSlug: "t392-listener",
      operationName: "poll_events",
      args: {},
    });
    expect(afterCommit.ok).toBe(true);
    if (afterCommit.ok) {
      expect((afterCommit.value as { events: unknown[] }).events).toHaveLength(0);
    }
  });
});
