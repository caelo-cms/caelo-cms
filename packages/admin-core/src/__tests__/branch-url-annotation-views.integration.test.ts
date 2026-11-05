// SPDX-License-Identifier: MPL-2.0

/**
 * #1411 — a URL a plugin composes on a branch without a page snapshot.
 *
 * A chat that links a main page into a locale variant writes a plugin row,
 * not a page: `pages.refresh_current_path` reports the branch's URL and
 * leaves the live one alone. The chat's views of that page follow the
 * branch URL (humanising, canonicalising, `pages.list`, the preview's
 * paths); main keeps the live one until the merge. A page no pending
 * plugin row names costs no plugin call.
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
import { loadLinkTargetLookup } from "../links/canonicalise.js";
import { humaniseForRead } from "../links/humanise.js";
import { loadLinkTargets, siteViewDriftPaths } from "../links/link-targets.js";
import { lockPluginRow } from "../locks.js";
import { pendingUrlAnnotationPageIds } from "../ops/content/branch-url-drift.js";
import { registerAdminOps } from "../register.js";
import { loadSiteView } from "../site-view.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SLUG = "t-buav";
const SCHEMA = "plugin_t_buav";
const PFX = "t-buav-";
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const AI = "00000000-0000-0000-0000-000000000a1a";
const systemCtx: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "buav" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let annotationCalls = 0;

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
  adminSchema: { tags: { page_id: "uuid", prefix: "string", note: "text" } },
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
      annotationCalls += 1;
      const { pageIds } = args as { pageIds: string[] };
      const tags = await handles(ctx).q.list("tags", { limit: 1000 });
      const byPage = new Map(tags.map((t) => [String(t.page_id), String(t.prefix)]));
      const roots = new Set(tags.filter((t) => t.note === "root").map((t) => String(t.page_id)));
      return {
        annotations: Object.fromEntries(
          pageIds.map((id) => {
            const prefix = byPage.get(id);
            return [id, prefix ? { prefix, isLocaleRoot: roots.has(id) } : {}];
          }),
        ),
      };
    },
    tag_page: async (ctx, args) => {
      const { q, cms } = handles(ctx);
      const a = args as { pageId: string; prefix: string };
      await q.insert("tags", { page_id: a.pageId, prefix: a.prefix });
      return cms.call("pages.refresh_current_path", { pageId: a.pageId });
    },
    /** A locale root: serves at its prefix, so its path drops its slug. */
    tag_root: async (ctx, args) => {
      const { q, cms } = handles(ctx);
      const a = args as { pageId: string; prefix: string };
      await q.insert("tags", { page_id: a.pageId, prefix: a.prefix, note: "root" });
      return cms.call("pages.refresh_current_path", { pageId: a.pageId });
    },
    tag_page_quietly: async (ctx, args) => {
      const a = args as { pageId: string; prefix: string };
      await handles(ctx).q.insert("tags", { page_id: a.pageId, prefix: a.prefix });
      return {};
    },
    /** A pending write of the row that leaves its prefix as it is. */
    retag_page_quietly: async (ctx, args) => {
      const { q } = handles(ctx);
      const a = args as { pageId: string; prefix: string };
      const row = (await q.list("tags", { limit: 1000 })).find(
        (t) => String(t.page_id) === a.pageId,
      );
      if (!row) throw new Error("no tag row");
      await q.update("tags", String(row.id), { note: "touched" });
      return {};
    },
    untag_page: async (ctx, args) => {
      const { q, cms } = handles(ctx);
      const { pageId } = args as { pageId: string };
      const tags = await q.list("tags", { limit: 1000 });
      const row = tags.find((t) => String(t.page_id) === pageId);
      if (!row) throw new Error("no tag row");
      await q.delete("tags", String(row.id));
      return cms.call("pages.refresh_current_path", { pageId });
    },
  },
});

async function withSystemSql<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
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
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}%`}`;
    const byPluginActor = `SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`;
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

async function okOf<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function page(slug: string): Promise<string> {
  const { pageId } = await okOf<{ pageId: string }>(systemCtx, "pages.create", {
    slug: `${PFX}${slug}`,
    title: slug,
    templateId,
  });
  return pageId;
}

/**
 * A fresh chat, as the AI and as the plugin see it: on its own branch,
 * or on the shared draft (the only binding `chat.undo_changes` serves).
 */
async function chat(
  isolation: "experiment" | "draft" = "experiment",
): Promise<{ ctx: ExecutionContext; invocation: PluginInvocation; chatSessionId: string }> {
  const { chatSessionId, chatBranchId } = await okOf<{
    chatSessionId: string;
    chatBranchId: string;
  }>(systemCtx, "chat.create_session", {
    ...(isolation === "experiment" ? { isolation } : {}),
    title: `${PFX}chat`,
  });
  return {
    chatSessionId,
    ctx: {
      actorId: AI,
      actorKind: "ai",
      requestId: "buav",
      chatBranchId,
      chatTaskId: chatSessionId,
    },
    invocation: {
      origin: "chat",
      actorId: AI,
      operatorActorId: HUMAN,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
  };
}

async function runPlugin(
  operationName: string,
  args: Record<string, unknown>,
  invocation: PluginInvocation,
): Promise<unknown> {
  const r = await runPluginOperation({ pluginSlug: SLUG, operationName, args, invocation });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.message}`);
  return r.value;
}

/** What a read of `{ link }` shows the caller. */
async function humanised(ctx: ExecutionContext, pageId: string): Promise<string> {
  const out = await adapter.withAdminTransaction(ctx, (tx) =>
    humaniseForRead(tx, ctx, { link: `caelo:page/${pageId}` }),
  );
  return out.link;
}

/** The page `path` canonicalises to in the caller's view (null = none). */
async function canonicalised(ctx: ExecutionContext, path: string): Promise<string | null> {
  return adapter.withAdminTransaction(ctx, async (tx) => {
    const lookup = await loadLinkTargetLookup(tx, ctx.chatBranchId ?? null);
    return lookup.pageIdForPath(path);
  });
}

/** The path of the full branch view (null = not a link target). */
async function fullView(ctx: ExecutionContext, pageId: string): Promise<string | null> {
  const t = await adapter.withAdminTransaction(ctx, (tx) =>
    loadLinkTargets(tx, ctx.chatBranchId ?? null),
  );
  return t.pages.find((p) => p.id === pageId)?.path ?? null;
}

/** The path `pages.list` reports for the page. */
async function listed(ctx: ExecutionContext, pageId: string): Promise<string | undefined> {
  const { pages } = await okOf<{ pages: { id: string; currentPath: string }[] }>(
    ctx,
    "pages.list",
    { pageIds: [pageId] },
  );
  return pages[0]?.currentPath;
}

/** The ids `pages.list({ paths })` finds for one path. */
async function listedAt(ctx: ExecutionContext, path: string): Promise<string[]> {
  const { pages } = await okOf<{ pages: { id: string }[] }>(ctx, "pages.list", { paths: [path] });
  return pages.map((p) => p.id);
}

/** The pages the chat's pending plugin rows name. */
async function pendingOf(ctx: ExecutionContext): Promise<string[]> {
  return adapter.withAdminTransaction(ctx, (tx) =>
    pendingUrlAnnotationPageIds(tx, ctx.chatBranchId ?? null),
  );
}

/** The path the preview's site view gives the page, drift applied. */
async function previewPath(ctx: ExecutionContext, pageId: string): Promise<string | undefined> {
  const chatBranchId = ctx.chatBranchId ?? null;
  const { view, annotated } = await adapter.withAdminTransaction(ctx, async (tx) => ({
    view: await loadSiteView(tx, chatBranchId),
    annotated: await pendingUrlAnnotationPageIds(tx, chatBranchId),
  }));
  const drift = await siteViewDriftPaths(view, { chatBranchId }, annotated);
  return drift.get(pageId) ?? view.pages.find((p) => p.id === pageId)?.currentPath;
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
  const t = await okOf<{ templateId: string }>(systemCtx, "templates.create", {
    pageType: "home",
    slug: `${PFX}t`,
    displayName: "T",
    html: '<caelo-slot name="content"></caelo-slot>',
    css: "",
  });
  templateId = t.templateId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("branch views of a URL a plugin changes without a page snapshot (#1411)", () => {
  it("follow the branch URL in the chat and the live URL on main", async () => {
    const pageId = await page("linked");
    const live = `/${PFX}linked`;
    const branch = `/fr/${PFX}linked`;
    const { ctx, invocation } = await chat();

    const refreshed = await runPlugin("tag_page", { pageId, prefix: "fr" }, invocation);
    expect(refreshed).toEqual({ path: branch, moved: false, awaitingUrlMigration: false });

    expect(await humanised(ctx, pageId)).toBe(branch);
    expect(await fullView(ctx, pageId)).toBe(branch);
    expect(await canonicalised(ctx, branch)).toBe(pageId);
    expect(await canonicalised(ctx, live)).toBeNull();
    expect(await listed(ctx, pageId)).toBe(branch);
    expect(await listedAt(ctx, branch)).toEqual([pageId]);
    expect(await previewPath(ctx, pageId)).toBe(branch);

    expect(await humanised(systemCtx, pageId)).toBe(live);
    expect(await fullView(systemCtx, pageId)).toBe(live);
    expect(await canonicalised(systemCtx, live)).toBe(pageId);
    expect(await canonicalised(systemCtx, branch)).toBeNull();
    expect(await listed(systemCtx, pageId)).toBe(live);
    expect(await previewPath(systemCtx, pageId)).toBe(live);
  });

  // PR #1501 review — the composed path of a locale root does not end in
  // the page's slug, so a lookup by path must not start from the slug.
  it("find a page by a branch path that does not end in its slug", async () => {
    const pageId = await page("startseite");
    const { ctx, invocation } = await chat();
    await runPlugin("tag_root", { pageId, prefix: "ca" }, invocation);

    expect(await listed(ctx, pageId)).toBe("/ca");
    expect(await listedAt(ctx, "/ca")).toEqual([pageId]);
    expect(await listedAt(systemCtx, "/ca")).toEqual([]);
    expect(await canonicalised(ctx, "/ca")).toBe(pageId);
  });

  it("follow a pending removal of the row that gave a live page its URL", async () => {
    const pageId = await page("unlinked");
    const approved: PluginInvocation = { origin: "approved", actorId: HUMAN };
    await runPlugin("tag_page", { pageId, prefix: "de" }, approved);
    const live = `/de/${PFX}unlinked`;
    const branch = `/${PFX}unlinked`;
    const { ctx, invocation } = await chat();

    expect(await humanised(ctx, pageId)).toBe(live);
    await runPlugin("untag_page", { pageId }, invocation);

    expect(await humanised(ctx, pageId)).toBe(branch);
    expect(await canonicalised(ctx, branch)).toBe(pageId);
    expect(await listed(ctx, pageId)).toBe(branch);
    expect(await humanised(systemCtx, pageId)).toBe(live);
  });

  it("stop following once the pending row is undone", async () => {
    const pageId = await page("undone");
    const { ctx, invocation, chatSessionId } = await chat("draft");
    await runPlugin("tag_page", { pageId, prefix: "it" }, invocation);
    expect(await humanised(ctx, pageId)).toBe(`/it/${PFX}undone`);

    await okOf(systemCtx, "chat.undo_changes", { chatSessionId });

    expect(await humanised(ctx, pageId)).toBe(`/${PFX}undone`);
    expect(await listed(ctx, pageId)).toBe(`/${PFX}undone`);
  });

  it("asks no plugin for a page no pending row names", async () => {
    const tagged = await page("tagged");
    const untouched = await page("untouched");
    const { ctx, invocation } = await chat();
    await runPlugin("tag_page", { pageId: tagged, prefix: "es" }, invocation);

    annotationCalls = 0;
    expect(await humanised(ctx, untouched)).toBe(`/${PFX}untouched`);
    expect(await listed(ctx, untouched)).toBe(`/${PFX}untouched`);
    expect(annotationCalls).toBe(0);
  });

  it("keeps the stored path while the composition differs only on main (#586)", async () => {
    const pageId = await page("waiting");
    const live = `/${PFX}waiting`;
    // A tag with no refresh: the stored path waits for the URL migration.
    const approved: PluginInvocation = { origin: "approved", actorId: HUMAN };
    await runPlugin("tag_page_quietly", { pageId, prefix: "nl" }, approved);
    expect(await humanised(systemCtx, pageId)).toBe(live);

    // The chat's pending row names the page but gives it no other URL
    // than main composes, so the chat sees the stored path too.
    const { ctx, invocation } = await chat();
    await runPlugin("retag_page_quietly", { pageId, prefix: "nl" }, invocation);
    expect(await pendingOf(ctx)).toEqual([pageId]);
    expect(await humanised(ctx, pageId)).toBe(live);
    expect(await listed(ctx, pageId)).toBe(live);
    expect(await fullView(ctx, pageId)).toBe(live);
  });
});
