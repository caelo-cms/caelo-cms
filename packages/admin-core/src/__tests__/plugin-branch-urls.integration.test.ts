// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin URL annotations on a chat branch (regression: a locale variant
 * created in a chat composed `/<slug>` instead of `/de/<slug>`, because
 * `current_path` was composed from main while the variant row lived on
 * the branch).
 *
 * - a page the branch created composes with the branch's plugin rows and
 *   persists that path;
 * - a main page refreshed from the chat keeps its live path until
 *   publish (the refresh reports the branch's view);
 * - merging the branch recomposes main-line paths and 301s what moved.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import {
  definePlugin,
  type PluginAdminQuery,
  type PluginCms,
  type PluginInvocation,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SLUG = "t-pbu";
const SCHEMA = "plugin_t_pbu";
const PFX = "t-pbu-";
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const AI = "00000000-0000-0000-0000-000000000a1a";
const humanCtx: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "pbu" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

type Ctx = { adminQuery?: PluginAdminQuery; cms?: PluginCms };
const handles = (ctx: unknown) => {
  const { adminQuery, cms } = ctx as Ctx;
  if (!adminQuery || !cms) throw new Error("capabilities missing");
  return { q: adminQuery, cms };
};

/** A minimal locale plugin: a tag row puts a path prefix on its page. */
const plugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { tags: { page_id: "uuid", prefix: "string" } },
  requestedCapabilities: ["cms_admin_schema", "cms_admin"],
  urlAnnotationsOperation: "annotations",
  urlContributions: [
    {
      slot: "path-prefix",
      encode: (page) =>
        typeof page.annotations.prefix === "string" ? [page.annotations.prefix] : [],
      decode: () => null,
    },
  ],
  operations: {
    annotations: async (ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const tags = await handles(ctx).q.list("tags", { limit: 1000 });
      const byPage = new Map(tags.map((t) => [String(t.page_id), String(t.prefix)]));
      return {
        annotations: Object.fromEntries(
          pageIds.map((id) => [id, byPage.has(id) ? { prefix: byPage.get(id) } : {}]),
        ),
      };
    },
    tag_page: async (ctx, args) => {
      const { q, cms } = handles(ctx);
      const a = args as { pageId: string; prefix: string };
      await q.insert("tags", { page_id: a.pageId, prefix: a.prefix });
      return cms.call("pages.refresh_current_path", { pageId: a.pageId });
    },
  },
});

async function withSystemSql<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  await withSystemSql(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const byPluginActor = `SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`;
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}%`}`;
    await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(
      `DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`,
    );
    await tx.unsafe(`DELETE FROM plugins WHERE slug = '${SLUG}'`);
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
  });
}

async function livePath(pageId: string): Promise<string | undefined> {
  return withSystemSql(async (tx) => {
    const rows = (await tx`SELECT current_path FROM pages WHERE id = ${pageId}::uuid`) as {
      current_path: string;
    }[];
    return rows[0]?.current_path;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const infra: PluginHostInfra = { adapter, registry, lockPluginRow };
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: HUMAN,
    testPlugins: [{ definition: plugin }],
  });
  expect(report.failed).toEqual([]);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("plugin URL annotations on a chat branch", () => {
  it("composes branch pages from branch rows and moves main paths only on merge", async () => {
    const t = await execute(registry, adapter, humanCtx, "templates.create", {
      slug: `${PFX}t`,
      displayName: "T",
      html: '<caelo-slot name="content"></caelo-slot>',
      css: "",
    });
    if (!t.ok) throw new Error("seed template");
    const templateId = (t.value as { templateId: string }).templateId;
    const main = await execute(registry, adapter, humanCtx, "pages.create", {
      slug: `${PFX}main`,
      title: "Main",
      templateId,
    });
    if (!main.ok) throw new Error("seed page");
    const mainId = (main.value as { pageId: string }).pageId;
    expect(await livePath(mainId)).toBe(`/${PFX}main`);

    const s = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: `${PFX}chat`,
    });
    if (!s.ok) throw new Error("chat");
    const { chatSessionId, chatBranchId } = s.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const aiCtx: ExecutionContext = {
      actorId: AI,
      actorKind: "ai",
      requestId: "pbu",
      chatBranchId,
      chatTaskId: chatSessionId,
    };
    const invocation: PluginInvocation = {
      origin: "chat",
      actorId: AI,
      operatorActorId: HUMAN,
      chatBranchId,
      chatTaskId: chatSessionId,
    };

    // A page the chat creates composes with the chat's own tag row.
    const created = await execute(registry, adapter, aiCtx, "pages.create", {
      slug: `${PFX}de`,
      title: "DE",
      templateId,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const branchPageId = (created.value as { pageId: string }).pageId;
    const tagged = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "tag_page",
      args: { pageId: branchPageId, prefix: "de" },
      invocation,
    });
    if (!tagged.ok) throw new Error(tagged.error.message);
    expect(await livePath(branchPageId)).toBe(`/de/${PFX}de`);

    // A main page tagged from the chat keeps its live URL until publish.
    const mainTagged = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "tag_page",
      args: { pageId: mainId, prefix: "fr" },
      invocation,
    });
    if (!mainTagged.ok) throw new Error(mainTagged.error.message);
    expect(mainTagged.value).toEqual({ path: `/fr/${PFX}main`, moved: false });
    expect(await livePath(mainId)).toBe(`/${PFX}main`);

    // Merging makes the tags live, recomposes main paths, and 301s.
    const merged = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await livePath(mainId)).toBe(`/fr/${PFX}main`);
    expect(await livePath(branchPageId)).toBe(`/de/${PFX}de`);
    const redirects = await withSystemSql(
      async (tx) =>
        (await tx`SELECT to_path FROM redirects WHERE from_path = ${`/${PFX}main`}`) as {
          to_path: string;
        }[],
    );
    expect(redirects.map((r) => r.to_path)).toEqual([`/fr/${PFX}main`]);
  });
});
