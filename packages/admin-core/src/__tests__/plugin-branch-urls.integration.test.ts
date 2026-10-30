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

// Issue #620 — these chats run on ISOLATED branches (experiments): the
// suite covers the per-branch mechanics isolated chats keep (experiments,
// migrations, pre-draft chats). The shared draft has its own suite
// (shared-draft.integration.test.ts).

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
  // `site_prefix` is a site-wide URL setting (like a locale strategy):
  // changing it moves every untagged page, so it needs a URL migration.
  adminSchema: {
    tags: { page_id: "uuid", prefix: "string" },
    site_prefix: { prefix: "string" },
  },
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
      const { q } = handles(ctx);
      const tags = await q.list("tags", { limit: 1000 });
      const byPage = new Map(tags.map((t) => [String(t.page_id), String(t.prefix)]));
      const site = (await q.list("site_prefix", { limit: 1 }))[0]?.prefix;
      const prefixOf = (id: string) => byPage.get(id) ?? (site ? String(site) : undefined);
      return {
        annotations: Object.fromEntries(
          pageIds.map((id) => {
            const prefix = prefixOf(id);
            return [id, prefix ? { prefix } : {}];
          }),
        ),
      };
    },
    /** Data change WITHOUT the refresh a well-behaved caller runs. */
    tag_page_quietly: async (ctx, args) => {
      const a = args as { pageId: string; prefix: string };
      await handles(ctx).q.insert("tags", { page_id: a.pageId, prefix: a.prefix });
      return {};
    },
    set_site_prefix: async (ctx, args) => {
      const { q } = handles(ctx);
      await q.insert("site_prefix", { prefix: (args as { prefix: string }).prefix });
      return {};
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
    await tx`DELETE FROM url_migration_pending_actions WHERE payload::text LIKE ${`%${PFX}%`}`;
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
      pageType: "home",
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
      isolation: "experiment",
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

    // A page the chat duplicates is the chat's page too (the
    // international site's create_variant duplicates the source page).
    const dup = await execute(registry, adapter, aiCtx, "pages.duplicate", {
      sourcePageId: mainId,
      newSlug: `${PFX}copy`,
    });
    if (!dup.ok) throw new Error(JSON.stringify(dup.error));
    const copyId = (dup.value as { pageId: string }).pageId;
    const copyTagged = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "tag_page",
      args: { pageId: copyId, prefix: "it" },
      invocation,
    });
    if (!copyTagged.ok) throw new Error(copyTagged.error.message);
    expect(await livePath(copyId)).toBe(`/it/${PFX}copy`);
    const copyBranch = await withSystemSql(
      async (tx) =>
        (await tx`SELECT chat_branch_id::text AS b FROM pages WHERE id = ${copyId}::uuid`) as {
          b: string | null;
        }[],
    );
    expect(copyBranch[0]?.b).toBe(chatBranchId);

    // A main page tagged from the chat keeps its live URL until publish.
    const mainTagged = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "tag_page",
      args: { pageId: mainId, prefix: "fr" },
      invocation,
    });
    if (!mainTagged.ok) throw new Error(mainTagged.error.message);
    expect(mainTagged.value).toEqual({
      path: `/fr/${PFX}main`,
      moved: false,
      awaitingUrlMigration: false,
    });
    expect(await livePath(mainId)).toBe(`/${PFX}main`);

    // Merging makes the tags live, recomposes main paths, and 301s.
    const merged = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await livePath(mainId)).toBe(`/fr/${PFX}main`);
    expect(await livePath(branchPageId)).toBe(`/de/${PFX}de`);
    expect(await livePath(copyId)).toBe(`/it/${PFX}copy`);
    const redirects = await withSystemSql(
      async (tx) =>
        (await tx`SELECT to_path FROM redirects WHERE from_path = ${`/${PFX}main`}`) as {
          to_path: string;
        }[],
    );
    expect(redirects.map((r) => r.to_path)).toEqual([`/fr/${PFX}main`]);
  });

  // #586 — a URL-setting change moves live pages only through the
  // approved URL migration (which writes the 301s), never as a side
  // effect of an unrelated merge or a per-page refresh.
  it("live paths wait for the approved URL migration after a setting change", async () => {
    const t = await execute(registry, adapter, humanCtx, "templates.create", {
      pageType: "home",
      slug: `${PFX}t586`,
      displayName: "T",
      html: '<caelo-slot name="content"></caelo-slot>',
      css: "",
    });
    if (!t.ok) throw new Error("seed template");
    const templateId = (t.value as { templateId: string }).templateId;
    const live = await execute(registry, adapter, humanCtx, "pages.create", {
      slug: `${PFX}live`,
      title: "Live",
      templateId,
    });
    if (!live.ok) throw new Error("seed page");
    const liveId = (live.value as { pageId: string }).pageId;
    const sibling = await execute(registry, adapter, humanCtx, "pages.create", {
      slug: `${PFX}sibling`,
      title: "Sibling",
      templateId,
    });
    if (!sibling.ok) throw new Error("seed sibling");
    // Only a published page has a public URL the gate protects.
    const pub = await execute(registry, adapter, humanCtx, "pages.set_status", {
      pageId: liveId,
      status: "published",
    });
    if (!pub.ok) throw new Error(JSON.stringify(pub.error));
    // The previous test's pages are tagged; these two are untagged, so the
    // setting change moves both of them.
    const ownerApproved: PluginInvocation = { origin: "approved", actorId: HUMAN };
    const set = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "set_site_prefix",
      args: { prefix: "en" },
      invocation: ownerApproved,
    });
    if (!set.ok) throw new Error(set.error.message);
    expect(await livePath(liveId)).toBe(`/${PFX}live`);

    // An unrelated chat with plugin rows merges: the live page stays.
    const s = await execute(registry, adapter, humanCtx, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}chat586`,
    });
    if (!s.ok) throw new Error("chat");
    const { chatSessionId, chatBranchId } = s.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const aiCtx: ExecutionContext = {
      actorId: AI,
      actorKind: "ai",
      requestId: "pbu586",
      chatBranchId,
      chatTaskId: chatSessionId,
    };
    const created = await execute(registry, adapter, aiCtx, "pages.create", {
      slug: `${PFX}other`,
      title: "Other",
      templateId,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const otherId = (created.value as { pageId: string }).pageId;
    const tagged = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "tag_page",
      args: { pageId: otherId, prefix: "de" },
      invocation: {
        origin: "chat",
        actorId: AI,
        operatorActorId: HUMAN,
        chatBranchId,
        chatTaskId: chatSessionId,
      },
    });
    if (!tagged.ok) throw new Error(tagged.error.message);
    const merged = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await livePath(otherId)).toBe(`/de/${PFX}other`);
    expect(await livePath(liveId)).toBe(`/${PFX}live`);

    // A per-page refresh holds the move back and says why.
    const refreshed = await execute(registry, adapter, humanCtx, "pages.refresh_current_path", {
      pageId: liveId,
    });
    if (!refreshed.ok) throw new Error(JSON.stringify(refreshed.error));
    expect(refreshed.value).toEqual({
      path: `/${PFX}live`,
      moved: false,
      awaitingUrlMigration: true,
    });
    expect(await livePath(liveId)).toBe(`/${PFX}live`);

    // The approved migration moves it, with its 301.
    const proposed = await execute(
      registry,
      adapter,
      humanCtx,
      "url_migrations.propose_migrate",
      {},
    );
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId } = proposed.value as { proposalId: string };
    const applied = await execute(registry, adapter, humanCtx, "url_migrations.execute_proposal", {
      proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    expect(await livePath(liveId)).toBe(`/en/${PFX}live`);
    const redirects = await withSystemSql(
      async (tx) =>
        (await tx`SELECT to_path FROM redirects WHERE from_path = ${`/${PFX}live`}`) as {
          to_path: string;
        }[],
    );
    expect(redirects.map((r) => r.to_path)).toEqual([`/en/${PFX}live`]);

    // PR #947 review — drift confined to ONE page (nothing else moves) is
    // still migration territory for a caller that changed no data.
    const quiet = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "tag_page_quietly",
      args: { pageId: liveId, prefix: "pt" },
      invocation: ownerApproved,
    });
    if (!quiet.ok) throw new Error(quiet.error.message);
    const confined = await execute(registry, adapter, humanCtx, "pages.refresh_current_path", {
      pageId: liveId,
    });
    if (!confined.ok) throw new Error(JSON.stringify(confined.error));
    expect(confined.value).toEqual({
      path: `/en/${PFX}live`,
      moved: false,
      awaitingUrlMigration: true,
    });
    expect(await livePath(liveId)).toBe(`/en/${PFX}live`);
  });
});
