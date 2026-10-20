// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — reference integrity across plugin composition
 * points, against the real plugin host:
 *
 *   - link-resolve (rollout D): a link on a German page to a page without
 *     a German version is `variant-missing` — blocking, with the fix
 *     (create the translation, or link a page that exists in German);
 *   - link locations (rollout E's hook): a reference stored in a plugin's
 *     own table is checked like core content and names the plugin;
 *   - a selected-header Stage asks plugins for the post-merge state, not
 *     the chat's whole pending branch.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { definePlugin, type PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { checkReferences } from "../ops/content/link-integrity.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "rif-p" };
const PFX = `rifp-${Date.now().toString(36)}`;
const SLUG = "t724f-links";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
/** page id → its link-resolve answer, filled per test. */
const variants: Record<string, { variant: string; group: string | null }> = {};

async function run<T = unknown>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function linkPage(slug: string, href: string): Promise<string> {
  const v = await run<{ pageId: string }>("pages.build_page", {
    page: { slug, title: slug, templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `RIFP ${slug}`,
        html: `<a href="{{cta_href}}">go</a>`,
        fields: [{ name: "cta_href", kind: "url", label: "CTA" }],
        content: { source: "inline", values: { cta_href: href } },
      },
    ],
  });
  return v.pageId;
}

type AdminCtx = { adminQuery?: PluginAdminQuery };

const plugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { links: { label: "text", data: "jsonb" } },
  requestedCapabilities: ["cms_admin_schema", "link_resolve"],
  linkResolveOperation: "resolve",
  linkLocationsOperation: "link_locations",
  operations: {
    resolve: async (_ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      return {
        pages: Object.fromEntries(
          pageIds.filter((id) => variants[id]).map((id) => [id, variants[id]]),
        ),
      };
    },
    add: async (ctx, args) => {
      const q = (ctx as AdminCtx).adminQuery;
      if (!q) throw new Error("adminQuery missing");
      const a = args as { label: string; data: unknown };
      return q.insert("links", { label: a.label, data: a.data });
    },
    remove: async (ctx, args) => {
      const q = (ctx as AdminCtx).adminQuery;
      if (!q) throw new Error("adminQuery missing");
      await q.delete("links", (args as { id: string }).id);
      return { removed: true };
    },
    link_locations: async (ctx) => {
      const q = (ctx as AdminCtx).adminQuery;
      if (!q) throw new Error("adminQuery missing");
      const rows = (await q.list("links", {})) as { id: string; label: string }[];
      return {
        locations: rows.map((r) => ({
          table: "links",
          rowId: r.id,
          column: "data",
          label: `Footer links (${r.label})`,
        })),
      };
    },
  },
});

async function cleanupPlugin(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // The plugin's actor keeps its audit + snapshot rows (FK); deleting
      // the plugin row nulls actors.plugin_id.
      await tx.unsafe(`DELETE FROM plugins WHERE slug = '${SLUG}'`);
      await tx.unsafe(`DROP SCHEMA IF EXISTS plugin_${SLUG.replace(/-/g, "_")} CASCADE`);
      await tx`UPDATE templates SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanupPlugin();
  const infra: PluginHostInfra = { adapter, registry, lockPluginRow };
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: plugin }],
  });
  expect(report.failed).toEqual([]);
  templateId = (
    await run<{ templateId: string }>("templates.create", {
      slug: `${PFX}-tpl`,
      displayName: "RIFP Template",
      html: `<main><caelo-slot name="content">_</caelo-slot></main>`,
    })
  ).templateId;
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await cleanupPlugin();
  await adapter.close();
});

describe("#724 F — reference integrity through plugin composition points", () => {
  it("a German page linking a page without a German version is variant-missing and blocks", async () => {
    const about = await linkPage(`${PFX}-about`, "https://example.com/a");
    const en = await linkPage(`${PFX}-en`, `/${PFX}-about`);
    const de = await linkPage(`${PFX}-de`, `/${PFX}-about`);
    variants[about] = { variant: "en", group: `${PFX}-g-about` };
    variants[en] = { variant: "en", group: `${PFX}-g-home` };
    variants[de] = { variant: "de", group: `${PFX}-g-home` };

    const issues = await adapter.withAdminTransaction(SYS, (tx) =>
      checkReferences(tx, { branchId: null, env: "staging" }),
    );
    const v = issues.filter((i) => i.problem === "variant-missing");
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("block");
    expect(v[0]?.variant).toBe("de");
    expect(v[0]?.pageIds).toEqual([de]);
    expect(v[0]?.message).toContain(`"/${PFX}-about" has no "de" version`);
    expect(v[0]?.message).toContain("create_variant");
  });

  it("checks references stored in a plugin's own table and names the plugin", async () => {
    const gone = await linkPage(`${PFX}-gone`, "https://example.com/g");
    const added = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: SLUG,
      operationName: "add",
      args: { label: "de", data: { links: [{ label: "Gone", href: `caelo:page/${gone}` }] } },
    });
    expect(added.ok).toBe(true);
    await run("pages.delete", { pageId: gone });

    const issues = await adapter.withAdminTransaction(SYS, (tx) =>
      checkReferences(tx, { branchId: null, env: "production" }),
    );
    const p = issues.find((i) => i.place.kind === "plugin");
    expect(p?.problem).toBe("missing-target");
    expect(p?.severity).toBe("block");
    expect(p?.message).toContain(`plugin "${SLUG}": Footer links (de)`);
    expect(p?.fix.tool).toBe("get_plugin");
  });

  it("a selected-header Stage checks plugin links as they are after the merge, not the chat's unselected changes", async () => {
    // Regression (Codex on #893): the Stage gate asked plugins as the
    // merged branch, so a plugin change the Stage did NOT select (here: a
    // row deleted on the branch) hid a broken link that main keeps.
    const target = await linkPage(`${PFX}-sel-t`, "https://example.com/s");
    const added = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: SLUG,
      operationName: "add",
      args: { label: "sel", data: { links: [{ label: "T", href: `caelo:page/${target}` }] } },
    });
    if (!added.ok) throw new Error(added.error.message);
    const rowId = (added.value as { id: string }).id;

    const s = await run<{ chatSessionId: string; chatBranchId: string }>("chat.create_session", {
      isolation: "experiment",
      title: `${PFX}-sel`,
    });
    const chatCtx: ExecutionContext = { ...SYS, chatBranchId: s.chatBranchId };
    const deleted = await execute(registry, adapter, chatCtx, "pages.delete", { pageId: target });
    if (!deleted.ok) throw new Error(JSON.stringify(deleted.error));
    const removed = await runPluginOperation({
      invocation: {
        origin: "chat",
        actorId: SYSTEM_ACTOR_ID,
        operatorActorId: SYSTEM_ACTOR_ID,
        chatBranchId: s.chatBranchId,
        chatTaskId: s.chatSessionId,
      },
      pluginSlug: SLUG,
      operationName: "remove",
      args: { id: rowId },
    });
    if (!removed.ok) throw new Error(removed.error.message);

    // The page deletion is selected; the plugin row's deletion is not.
    const headers = await adapter.withAdminTransaction(
      SYS,
      async (tx) =>
        (await tx.execute(sql`
        SELECT ss.id::text AS id,
               EXISTS (SELECT 1 FROM plugin_row_snapshots prs
                        WHERE prs.site_snapshot_id = ss.id) AS plugin
          FROM site_snapshots ss
         WHERE ss.chat_branch_id = ${s.chatBranchId}::uuid
         ORDER BY ss.created_at, ss.id
      `)) as unknown as { id: string; plugin: boolean }[],
    );
    const selected = headers.filter((h) => !h.plugin).map((h) => h.id);
    expect(selected.length).toBeGreaterThan(0);
    expect(headers.some((h) => h.plugin)).toBe(true);

    const merged = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: s.chatSessionId,
      headerIds: selected,
    });
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.error.message).toContain("Stage refused");
    expect(merged.error.message).toContain(`plugin "${SLUG}": Footer links (sel)`);
  });
});
