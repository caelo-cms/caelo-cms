// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 Phase B1 — the `cms_admin` and `change_journal` brokers for a
 * runtime-installed plugin, end to end on a real Postgres and the real
 * Deno sandbox: staged, approved by an Owner, activated
 * (docs/dev/external-plugin-brokers.md §5.2, §7.1).
 *
 *   - `ctx.cms.call` runs only the operations the receipt names; a chat's
 *     core write lands on the chat's branch, a render's is refused, and an
 *     operation behind a plugin handle is refused for every plugin;
 *   - a change consumer of the plugin's own table gets a batch for a main
 *     write on main and for a chat write in that chat's branch scope (its
 *     writes land on the branch);
 *   - a rebuild runs in resumable chunks across drains, the consumer stays
 *     "rebuilding" (shown in plugin health) and receives no batch until it
 *     is done; a rebuild that never ends does not hold up another consumer;
 *   - a consumer of core kinds without the cms_admin receipt is refused.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  drainChangeConsumers,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-b1-test",
};
const PFX = "b1-";
/** Templates survive the per-file reset: a run's fixtures get their own slugs. */
const RUN = crypto.randomUUID().slice(0, 8);
/** Every plugin this file installs: their schemas outlive the per-file reset. */
const SCHEMAS = ["b1-cms", "b1-journal", "b1-endless", "b1-core-kinds"].map(
  (slug) => `plugin_${slug.replaceAll("-", "_")}`,
);
const dropSchemas = () =>
  adapter.withAdminTransaction(system, async (tx) => {
    for (const schema of SCHEMAS)
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
  });

type Ctx = { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string };

async function call(name: string, input: unknown, ctx: Ctx = system) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

let ownerCtx: Ctx;
async function owner(): Promise<Ctx> {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" as const };
}

/** Stage, approve as an Owner and activate one external artifact. */
async function installExternal(
  m: Record<string, unknown> & { requestedCapabilities: string[] },
  src: string,
): Promise<{ pluginId: string }> {
  const staged = (await call("plugins.stage_installation", { manifest: m, source: src })) as {
    installationId: string;
    pluginId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  if (!item) throw new Error("review missing");
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item.currentStateDigest,
      capabilities: m.requestedCapabilities,
    },
    ownerCtx,
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
  return { pluginId: staged.pluginId };
}

/** A chat on the site's shared draft, acting for the Owner. */
async function chat(name: string): Promise<PluginInvocation> {
  const r = (await call("chat.create_session", { title: `${PFX}${name}` })) as {
    chatSessionId: string;
    chatBranchId: string;
  };
  return {
    origin: "chat",
    actorId: ownerCtx.actorId,
    operatorActorId: ownerCtx.actorId,
    chatBranchId: r.chatBranchId,
    chatTaskId: r.chatSessionId,
  };
}

async function run<T>(
  slug: string,
  operationName: string,
  args: unknown,
  invocation: PluginInvocation,
) {
  const r = await runPluginOperation({ pluginSlug: slug, operationName, args, invocation });
  if (!r.ok) throw new Error(`${slug}.${operationName}: ${r.error.message}`);
  return r.value as T;
}

async function refusal(
  slug: string,
  operationName: string,
  args: unknown,
  invocation: PluginInvocation,
) {
  const r = await runPluginOperation({ pluginSlug: slug, operationName, args, invocation });
  if (r.ok) throw new Error(`${slug}.${operationName} was expected to be refused`);
  return r.error.message;
}

let pageId = "";

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await dropSchemas();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-b1-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
  ownerCtx = await owner();
  const db = new SQL(process.env.ADMIN_DATABASE_URL);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = (await tx`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES (${`${PFX}tpl-${RUN}`}, 'T', '<body><caelo-slot name="content">_</caelo-slot></body>',
                (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id`) as { id: string }[];
      const templateId = tpl[0]?.id ?? "";
      await adoptTemplateIntoHomePageType(tx, templateId);
      await tx`INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${templateId}::uuid, 'content', 'Content', 0)`;
      const p = (await tx`
        INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed)
        VALUES (${`${PFX}about-${RUN}`}, 'About', 'About us', ${templateId}::uuid, 'published', true)
        RETURNING id::text AS id`) as { id: string }[];
      pageId = p[0]?.id ?? "";
    });
  } finally {
    await db.end();
  }
  await call("pages.refresh_current_path", { pageId });
});

afterAll(async () => {
  resetPluginHost();
  await dropSchemas();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("cms_admin through the broker (#1729 §7.1)", () => {
  const SLUG = "b1-cms";
  beforeAll(async () => {
    await installExternal(
      {
        slug: SLUG,
        version: "1.0.0",
        tier: 2,
        schema: {},
        operations: ["call"],
        requestedCapabilities: ["cms_admin"],
        capabilityReasons: { cms_admin: "Read and rename pages" },
        capabilityConstraints: {
          cms_admin: { operations: ["pages.list", "pages.update", "plugin_storage.list"] },
        },
      },
      `export default {slug:"${SLUG}",version:"1.0.0",tier:2,operations:{
        call: async (ctx, args) => ctx.cms.call(args.op, args.input),
      }};`,
    );
  });

  const title = async (invocation: PluginInvocation) => {
    const r = await run<{ pages: { id: string; title: string }[] }>(
      SLUG,
      "call",
      { op: "pages.list", input: { pageIds: [pageId] } },
      invocation,
    );
    return r.pages.find((p) => p.id === pageId)?.title;
  };

  it("a chat's core write lands on the chat's branch, not on main", async () => {
    const c = await chat("cms-write");
    await run(SLUG, "call", { op: "pages.update", input: { pageId, title: "About the team" } }, c);
    expect(await title(c)).toBe("About the team");
    expect(await title({ origin: "owner-panel", actorId: ownerCtx.actorId })).toBe("About us");
  });

  it("a render reads core data and is refused a write", async () => {
    const render: PluginInvocation = { origin: "render", actorId: ownerCtx.actorId };
    expect(await title(render)).toBe("About us");
    expect(
      await refusal(SLUG, "call", { op: "pages.update", input: { pageId, title: "x" } }, render),
    ).toContain("a render only reads");
  });

  it("refuses an operation the receipt does not name, and one behind a plugin handle", async () => {
    const worker: PluginInvocation = { origin: "worker", actorId: ownerCtx.actorId };
    expect(await refusal(SLUG, "call", { op: "redirects.create", input: {} }, worker)).toContain(
      "not among the operations the Owner approved",
    );
    expect(await refusal(SLUG, "call", { op: "plugin_storage.list", input: {} }, worker)).toContain(
      "call it through that handle",
    );
  });
});

describe("change_journal through the broker (#1729 §5.2)", () => {
  const SLUG = "b1-journal";
  let pluginId = "";
  /** Chunks the rebuild needs; each drain below runs one. */
  const CHUNKS = 3;

  beforeAll(async () => {
    ({ pluginId } = await installExternal(
      {
        slug: SLUG,
        version: "1.0.0",
        tier: 2,
        schema: {},
        adminSchema: {
          notes: { body: "text" },
          seen: { note_id: "text", branch: "text" },
          rebuilds: { chunk: "text" },
        },
        operations: ["add", "onChanges", "rebuild", "seen"],
        requestedCapabilities: ["cms_admin_schema", "change_journal"],
        capabilityReasons: {
          cms_admin_schema: "Keep notes and what it saw",
          change_journal: "React to its own notes",
        },
        changeConsumer: {
          operationName: "onChanges",
          rebuildOperationName: "rebuild",
          kinds: [],
          ownTables: ["notes"],
          lines: "all",
        },
      },
      `export default {slug:"${SLUG}",version:"1.0.0",tier:2,operations:{
        add: async (ctx, args) => ctx.adminQuery.insert("notes", { body: args.body }),
        onChanges: async (ctx, args) => {
          // At least once: one insert arrives as its row and its snapshot.
          const notes = new Set(args.changes.filter((c) => c.table === "notes" && c.op === "insert").map((c) => c.rowId));
          for (const id of notes)
            await ctx.adminQuery.insert("seen", { note_id: id, branch: args.chatBranchId ?? "main" });
          return {};
        },
        rebuild: async (ctx, args) => {
          const n = args.cursor ? Number(args.cursor) : 0;
          await ctx.adminQuery.insert("rebuilds", { chunk: String(n) });
          return n < ${CHUNKS - 1} ? { done: false, cursor: String(n + 1) } : { done: true };
        },
        seen: async (ctx) => ({
          seen: await ctx.adminQuery.list("seen", { limit: 100 }),
          rebuilds: await ctx.adminQuery.list("rebuilds", { limit: 100 }),
        }),
      }};`,
    ));
  });

  const main: PluginInvocation = { origin: "worker", actorId: system.actorId };
  const consumerRow = () =>
    adapter.withAdminTransaction(system, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT rebuild_pending, rebuild_cursor FROM change_consumers
        WHERE plugin_id = ${pluginId}::uuid`)) as unknown as {
        rebuild_pending: boolean;
        rebuild_cursor: string | null;
      }[];
      return rows[0];
    });
  const health = async () => {
    const r = (await call("plugins.list", {}, ownerCtx)) as {
      plugins: { slug: string; health: { consumerRebuild: unknown } }[];
    };
    return r.plugins.find((p) => p.slug === SLUG)?.health.consumerRebuild;
  };

  it("resumes its rebuild across drains, delivering no batch until it is done", async () => {
    const cursors: (string | null)[] = [];
    for (let drain = 1; drain < CHUNKS; drain++) {
      const [report] = await drainChangeConsumers({ adapter, registry }, SLUG, {
        maxRebuildChunks: 1,
      });
      expect(report).toMatchObject({ slug: SLUG, rebuilding: true, changes: 0 });
      const row = await consumerRow();
      expect(row?.rebuild_pending).toBe(true);
      cursors.push(row?.rebuild_cursor ?? null);
      expect(await health()).toMatchObject({ resumable: true });
      // Written while the rebuild runs (after the consumer's cursor was
      // taken): delivered only once the rebuild is done.
      if (drain === 1) await run(SLUG, "add", { body: "during the rebuild" }, main);
    }
    expect(cursors).toEqual(["1", "2"]);
    expect((await run<{ seen: unknown[] }>(SLUG, "seen", {}, main)).seen).toEqual([]);

    const [done] = await drainChangeConsumers({ adapter, registry }, SLUG, { maxRebuildChunks: 1 });
    expect(done).toMatchObject({ rebuilt: true });
    expect(await consumerRow()).toEqual({ rebuild_pending: false, rebuild_cursor: null });
    expect(await health()).toBeNull();
    const after = await run<{ seen: { branch: string }[]; rebuilds: { chunk: string }[] }>(
      SLUG,
      "seen",
      {},
      main,
    );
    expect(after.rebuilds.map((r) => r.chunk).sort()).toEqual(["0", "1", "2"]);
    expect(after.seen.map((s) => s.branch)).toEqual(["main"]);
  });

  it("delivers a chat's write in that chat's branch scope, and its writes land on the branch", async () => {
    const c = await chat("journal-write");
    await run(SLUG, "add", { body: "from the chat" }, c);
    await drainChangeConsumers({ adapter, registry }, SLUG);
    const inChat = await run<{ seen: { branch: string }[] }>(SLUG, "seen", {}, c);
    expect(inChat.seen.map((s) => s.branch).sort()).toEqual(
      [c.chatBranchId as string, "main"].sort(),
    );
    // On main only the main write was seen: the branch batch wrote on the branch.
    const onMain = await run<{ seen: { branch: string }[] }>(SLUG, "seen", {}, main);
    expect(onMain.seen.map((s) => s.branch)).toEqual(["main"]);
  });

  it("a rebuild that never ends stays rebuilding without holding up another consumer", async () => {
    await installExternal(
      {
        slug: "b1-endless",
        version: "1.0.0",
        tier: 2,
        schema: {},
        adminSchema: { notes: { body: "text" } },
        operations: ["onChanges", "rebuild"],
        requestedCapabilities: ["cms_admin_schema", "change_journal"],
        capabilityReasons: {
          cms_admin_schema: "Keep notes",
          change_journal: "React to its notes",
        },
        changeConsumer: {
          operationName: "onChanges",
          rebuildOperationName: "rebuild",
          kinds: [],
          ownTables: ["notes"],
          lines: "main",
        },
      },
      `export default {slug:"b1-endless",version:"1.0.0",tier:2,operations:{
        onChanges: async () => ({}),
        rebuild: async (ctx, args) => ({ done: false, cursor: String(Number(args.cursor ?? 0) + 1) }),
      }};`,
    );
    await run(SLUG, "add", { body: "next to an endless rebuild" }, main);
    const reports = await drainChangeConsumers({ adapter, registry }, undefined, {
      maxRebuildChunks: 2,
    });
    expect(reports.find((r) => r.slug === "b1-endless")).toMatchObject({ rebuilding: true });
    expect(reports.find((r) => r.slug === SLUG)?.changes).toBeGreaterThan(0);
    const r = (await call("plugins.list", {}, ownerCtx)) as {
      plugins: { slug: string; health: { consumerRebuild: unknown } }[];
    };
    expect(r.plugins.find((p) => p.slug === "b1-endless")?.health.consumerRebuild).toMatchObject({
      resumable: true,
    });
  });

  it("refuses a consumer of core kinds without the cms_admin grant, at staging", async () => {
    await expect(
      installExternal(
        {
          slug: "b1-core-kinds",
          version: "1.0.0",
          tier: 2,
          schema: {},
          adminSchema: { notes: { body: "text" } },
          operations: ["onChanges", "rebuild"],
          requestedCapabilities: ["cms_admin_schema", "change_journal"],
          capabilityReasons: {
            cms_admin_schema: "Keep notes",
            change_journal: "React to page changes",
          },
          changeConsumer: {
            operationName: "onChanges",
            rebuildOperationName: "rebuild",
            kinds: ["page"],
            lines: "main",
          },
        },
        `export default {slug:"b1-core-kinds",version:"1.0.0",tier:2,operations:{
          onChanges: async () => ({}), rebuild: async () => ({}),
        }};`,
      ),
    ).rejects.toThrow("consuming core kinds needs the cms");
  });
});
