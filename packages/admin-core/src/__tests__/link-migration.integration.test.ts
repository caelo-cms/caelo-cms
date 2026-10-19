// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the one-time literal-link → reference
 * migration against a real Postgres (CLAUDE.md §6).
 *
 * Content is first written through the ops (so it is valid), then
 * rewritten to its pre-#724 literal form with SQL — the state an
 * upgraded install starts from. Covers:
 *   - every surface: module HTML, module field defaults, content values
 *     (by field kind: a `text` value that looks like a path stays),
 *     structured sets (submenus), plugin storage via the plugin hook;
 *   - a dry run reports and writes nothing;
 *   - apply converts, emits ONE main-line snapshot, reports unresolved
 *     links with where they are, and is listed by the report op;
 *   - unresolvable links stay literal (never guessed);
 *   - idempotency: a second run converts nothing; the boot guard skips;
 *   - chat branches: a chat's pending state is converted by appending a
 *     pending snapshot owned by the same chat task;
 *   - revert restores exactly what changed, and refuses (names) a part
 *     edited since unless told to keep it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR,
  actorKind: "system",
  requestId: "link-migration-test",
};
const PFX = `lmig${Date.now().toString(36)}`;
const PLUGIN_SLUG = `${PFX}-store`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
const ids = {
  about: "",
  pricing: "",
  nav: "",
  card: "",
  instance: "",
  setId: "",
  branch: "",
  branchInstance: "",
  pluginRow: "",
};

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx);
    });
  } finally {
    await sql.end();
  }
}

async function run<T>(op: string, input: unknown, ctx: ExecutionContext = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function failure(
  op: string,
  input: unknown,
  ctx: ExecutionContext = SYSTEM,
): Promise<string> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (r.ok) throw new Error(`${op} unexpectedly succeeded`);
  return (r.error as { message?: string }).message ?? JSON.stringify(r.error);
}

function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

async function makePage(slug: string): Promise<string> {
  const r = await run<{ pageId: string }>("pages.build_page", {
    page: { slug, title: slug, templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${slug} body`,
        description: "Page body.",
        kind: "content",
        html: "<p>{{body_text}}</p>",
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: slug } },
      },
    ],
  });
  return r.pageId;
}

async function moduleRow(
  id: string,
): Promise<{ html: string; fields: { name: string; default?: unknown }[] }> {
  const rows = (await asSystem(
    (tx) => tx`SELECT html, fields FROM modules WHERE id = ${id}::uuid`,
  )) as {
    html: string;
    fields: unknown;
  }[];
  const r = rows[0];
  if (!r) throw new Error("module missing");
  return { html: r.html, fields: json(r.fields) };
}

async function instanceValues(id: string): Promise<Record<string, unknown>> {
  const rows = (await asSystem(
    (tx) => tx`SELECT "values" FROM content_instances WHERE id = ${id}::uuid`,
  )) as { values: unknown }[];
  return json(rows[0]?.values);
}

async function setItems(
  id: string,
): Promise<{ label: string; href: string; children?: { href: string }[] }[]> {
  const rows = (await asSystem(
    (tx) => tx`SELECT items FROM structured_sets WHERE id = ${id}::uuid`,
  )) as {
    items: unknown;
  }[];
  return json(rows[0]?.items);
}

async function pluginRows(): Promise<{ id: string; payload: { cta_href?: string } }[]> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR },
    pluginSlug: PLUGIN_SLUG,
    operationName: "list",
    args: {},
  });
  if (!r.ok) throw new Error(`list: ${r.error.message}`);
  return r.value as { id: string; payload: { cta_href?: string } }[];
}

/** A Tier-1 plugin that stores a link in its own table and names it to the hook. */
const storePlugin = definePlugin<PluginContextTier1>({
  slug: PLUGIN_SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { items: { payload: "jsonb", created_at: "timestamp" } },
  requestedCapabilities: ["cms_admin_schema"],
  operations: {
    put: async (ctx, args) => {
      const q = ctx.adminQuery;
      if (!q) throw new Error("no adminQuery");
      return q.insert("items", { payload: (args as { payload: unknown }).payload });
    },
    list: async (ctx) => {
      const q = ctx.adminQuery;
      if (!q) throw new Error("no adminQuery");
      return q.list("items", { limit: 100 });
    },
    link_locations: async (ctx) => {
      const q = ctx.adminQuery;
      if (!q) throw new Error("no adminQuery");
      const rows = (await q.list("items", { limit: 100 })) as { id: string }[];
      return {
        locations: rows.map((r) => ({
          table: "items",
          rowId: r.id,
          column: "payload",
          label: `${PFX} plugin item`,
          fields: [{ name: "cta_href", kind: "url" }],
        })),
      };
    },
  },
  linkLocationsOperation: "link_locations",
});

async function wipe(): Promise<void> {
  resetPluginHost();
  await asSystem(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "plugin_${PLUGIN_SLUG.replace(/-/g, "_")}" CASCADE`);
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN_SLUG}))`;
    await tx`DELETE FROM site_snapshots WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN_SLUG}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN_SLUG})`;
    await tx`DELETE FROM plugins WHERE slug = ${PLUGIN_SLUG}`;
    await tx`DELETE FROM link_migration_runs`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM structured_sets WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}%`} OR display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`} OR display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
  });
}

const ABOUT = `/${PFX}-about`;
const PRICING = `/${PFX}-pricing`;
const GONE = `/${PFX}-gone`;

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const infra: PluginHostInfra = { adapter, registry };
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR,
    testPlugins: [{ definition: storePlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  templateId = (
    await run<{ templateId: string }>("templates.create", {
      slug: `${PFX}-tpl`,
      displayName: `${PFX} TPL`,
      html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    })
  ).templateId;
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  ids.about = await makePage(`${PFX}-about`);
  ids.pricing = await makePage(`${PFX}-pricing`);

  // Layout chrome: links in the HTML and in a link-list field default.
  ids.nav = (
    await run<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-nav`,
      displayName: `${PFX} Nav`,
      html: '<nav><a href="https://example.com/">Home</a>{{#links}}<a href="{{href}}">{{label}}</a>{{/links}}</nav>',
      fields: [{ name: "links", kind: "link-list", label: "Links", default: [] }],
    })
  ).moduleId;
  ids.card = (
    await run<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-card`,
      displayName: `${PFX} Card`,
      html: '<div><a href="{{cta_href}}">{{cta_label}}</a><span>{{price_note}}</span>{{{body_html}}}</div>',
      fields: [
        { name: "cta_label", kind: "text", label: "CTA" },
        { name: "cta_href", kind: "url", label: "CTA link" },
        { name: "price_note", kind: "text", label: "Price note" },
        { name: "body_html", kind: "richtext", label: "Body" },
      ],
    })
  ).moduleId;
  ids.instance = (
    await run<{ contentInstanceId: string }>("content_instances.create", {
      moduleId: ids.card,
      slug: `${PFX}-card-1`,
      displayName: `${PFX} card`,
      values: {
        cta_label: "Buy",
        cta_href: "https://example.com/x",
        price_note: "x",
        body_html: "<p>x</p>",
      },
    })
  ).contentInstanceId;
  ids.setId = (
    await run<{ setId: string }>("structured_sets.set", {
      kind: "nav-menu",
      slug: `${PFX}-menu`,
      displayName: `${PFX} menu`,
      items: [{ label: "Home", href: "https://example.com/" }],
    })
  ).setId;
  const put = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR },
    pluginSlug: PLUGIN_SLUG,
    operationName: "put",
    args: { payload: { cta_href: "https://example.com/y" } },
  });
  if (!put.ok) throw new Error(`put: ${put.error.message}`);
  ids.pluginRow = (put.value as { id: string }).id;

  // The pre-#724 state: literal paths everywhere.
  await asSystem(async (tx) => {
    await tx`UPDATE modules SET html = ${`<nav><a href="${ABOUT}">About</a><a href="${GONE}">Old</a>{{#links}}<a href="{{href}}">{{label}}</a>{{/links}}</nav>`},
             fields = ${JSON.stringify([{ name: "links", kind: "link-list", label: "Links", default: [{ label: "Pricing", href: `${PRICING}#plans` }] }])}::jsonb
             WHERE id = ${ids.nav}::uuid`;
    await tx`UPDATE content_instances SET "values" = ${JSON.stringify({
      cta_label: "Buy",
      cta_href: PRICING,
      price_note: "/month",
      body_html: `<p>See <a href="${ABOUT}">about</a> and <a href="https://example.com/ext">ext</a></p>`,
    })}::jsonb WHERE id = ${ids.instance}::uuid`;
    await tx`UPDATE structured_sets SET items = ${JSON.stringify([
      { label: "About", href: ABOUT, children: [{ label: "Pricing", href: PRICING }] },
      { label: "Gone", href: GONE },
    ])}::jsonb WHERE id = ${ids.setId}::uuid`;
    // Plugin tables are RLS-scoped to their plugin.
    await tx`SELECT set_config('caelo.plugin_id', (SELECT id::text FROM plugins WHERE slug = ${PLUGIN_SLUG}), true)`;
    const updated = await tx.unsafe(
      `UPDATE "plugin_${PLUGIN_SLUG.replace(/-/g, "_")}".items SET payload = '{"cta_href":"${PRICING}"}'::jsonb WHERE id = '${ids.pluginRow}' RETURNING id`,
    );
    if (updated.length !== 1) throw new Error("plugin fixture row not rewritten");
  });

  // A chat with pending (unstaged) work holding a literal link.
  const session = await run<{ chatBranchId: string }>("chat.create_session", {
    title: `${PFX}-chat`,
  });
  ids.branch = session.chatBranchId;
  const ai: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: "link-migration-ai",
    chatBranchId: ids.branch,
  };
  ids.branchInstance = (
    await run<{ contentInstanceId: string }>(
      "content_instances.create",
      {
        moduleId: ids.card,
        slug: `${PFX}-card-branch`,
        displayName: `${PFX} branch card`,
        values: {
          cta_label: "Go",
          cta_href: "https://example.com/z",
          price_note: "",
          body_html: "",
        },
      },
      ai,
    )
  ).contentInstanceId;
  await asSystem(
    (tx) => tx`UPDATE content_instance_snapshots
                 SET state = jsonb_set(state, '{values,cta_href}', to_jsonb(${ABOUT}::text))
               WHERE content_instance_id = ${ids.branchInstance}::uuid`,
  );
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

interface MigrateOut {
  skipped: boolean;
  run: {
    runId: string;
    counts: Record<string, number>;
    unresolvedCount: number;
    siteSnapshotId: string | null;
  };
  unresolved: {
    value: string;
    label: string;
    where: string;
    surface: string;
    branchId: string | null;
  }[];
}

describe("links.migrate_to_references", () => {
  let applyRunId = "";

  it("a dry run reports what it would convert and writes nothing", async () => {
    const out = await run<MigrateOut>("links.migrate_to_references", { dryRun: true });
    expect(out.skipped).toBe(false);
    expect(out.run.siteSnapshotId).toBeNull();
    expect(out.run.counts.module_html).toBeGreaterThanOrEqual(1);
    expect((await moduleRow(ids.nav)).html).toContain(`href="${ABOUT}"`);
    expect((await instanceValues(ids.instance)).cta_href).toBe(PRICING);
  });

  it("converts every surface, keeps unresolvable links literal and reports them", async () => {
    const out = await run<MigrateOut>("links.migrate_to_references", {});
    applyRunId = out.run.runId;
    expect(out.run.siteSnapshotId).not.toBeNull();

    const nav = await moduleRow(ids.nav);
    expect(nav.html).toContain(`href="caelo:page/${ids.about}"`);
    expect(nav.html).toContain(`href="${GONE}"`); // never guessed
    expect(nav.fields[0]?.default).toEqual([
      { label: "Pricing", href: `caelo:page/${ids.pricing}#plans` },
    ]);

    const values = await instanceValues(ids.instance);
    expect(values.cta_href).toBe(`caelo:page/${ids.pricing}`);
    expect(values.price_note).toBe("/month"); // a text field is not a link
    expect(values.body_html).toBe(
      `<p>See <a href="caelo:page/${ids.about}">about</a> and <a href="https://example.com/ext">ext</a></p>`,
    );

    expect(await setItems(ids.setId)).toEqual([
      {
        label: "About",
        href: `caelo:page/${ids.about}`,
        children: [{ label: "Pricing", href: `caelo:page/${ids.pricing}` }],
      },
      { label: "Gone", href: GONE },
    ]);

    // The plugin hook: core converted the column the plugin named.
    const row = (await pluginRows()).find((r) => r.id === ids.pluginRow);
    expect(row?.payload.cta_href).toBe(`caelo:page/${ids.pricing}`);

    const mine = out.unresolved.filter((u) => u.value === GONE);
    expect(mine.map((u) => u.surface).sort()).toEqual(["module_html", "structured_sets"]);
    expect(mine.find((u) => u.surface === "module_html")?.label).toBe(`module "${PFX} Nav"`);

    // ONE main-line snapshot carries every changed entity, plugin row included.
    const snap = (await asSystem(
      (tx) => tx`SELECT op_kind, chat_branch_id,
                        (SELECT count(*) FROM module_snapshots WHERE site_snapshot_id = s.id)::int AS modules,
                        (SELECT count(*) FROM content_instance_snapshots WHERE site_snapshot_id = s.id)::int AS instances,
                        (SELECT count(*) FROM structured_set_snapshots WHERE site_snapshot_id = s.id)::int AS sets,
                        (SELECT count(*) FROM plugin_row_snapshots WHERE site_snapshot_id = s.id)::int AS plugin_rows
                   FROM site_snapshots s WHERE id = ${out.run.siteSnapshotId}::uuid`,
    )) as {
      op_kind: string;
      chat_branch_id: string | null;
      modules: number;
      instances: number;
      sets: number;
      plugin_rows: number;
    }[];
    expect(snap[0]).toMatchObject({ op_kind: "links.migrate_to_references", chat_branch_id: null });
    expect(snap[0]?.modules).toBeGreaterThanOrEqual(1);
    expect(snap[0]?.instances).toBeGreaterThanOrEqual(1);
    expect(snap[0]?.sets).toBeGreaterThanOrEqual(1);
    expect(snap[0]?.plugin_rows).toBe(1);
  });

  it("converts a chat's pending work by appending a pending snapshot of the same chat task", async () => {
    const ai: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "link-migration-ai-read",
      chatBranchId: ids.branch,
    };
    const rows = (await asSystem(
      (tx) => tx`SELECT cis.state, ss.op_kind, ss.chat_task_id
                   FROM content_instance_snapshots cis
                   JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
                  WHERE cis.content_instance_id = ${ids.branchInstance}::uuid
                  ORDER BY ss.created_at`,
    )) as { state: unknown; op_kind: string; chat_task_id: string | null }[];
    expect(rows.map((r) => r.op_kind)).toEqual([
      "content_instances.create",
      "links.migrate_to_references",
    ]);
    expect(rows[1]?.chat_task_id).toBe(rows[0]?.chat_task_id ?? null);
    expect(json<{ values: { cta_href: string } }>(rows[1]?.state).values.cta_href).toBe(
      `caelo:page/${ids.about}`,
    );
    // The chat reads its converted state; reads humanise the reference
    // back into the path the author wrote.
    const live = await run<{ instance: { values: Record<string, unknown> } }>(
      "content_instances.get",
      { id: ids.branchInstance },
      ai,
    );
    expect(live.instance.values.cta_href).toBe(ABOUT); // reads humanise references back to paths
  });

  it("is idempotent: a re-run converts nothing; the boot guard skips", async () => {
    const again = await run<MigrateOut>("links.migrate_to_references", {});
    expect(again.run.counts).toEqual({});
    expect(again.run.siteSnapshotId).toBeNull();
    expect(again.unresolved.filter((u) => u.value === GONE)).toHaveLength(2);
    const boot = await run<MigrateOut>("links.migrate_to_references", {
      trigger: "boot",
      onlyIfNeverApplied: true,
    });
    expect(boot.skipped).toBe(true);
  });

  it("the report op serves the latest run, filterable", async () => {
    const report = await run<{
      run: { runId: string; mode: string };
      unresolved: { value: string }[];
      unresolvedTotal: number;
      recentRuns: unknown[];
    }>("links.get_migration_report", { runId: applyRunId, search: `${PFX}-gone` });
    expect(report.run.mode).toBe("apply");
    expect(report.unresolvedTotal).toBe(2);
    expect(report.recentRuns.length).toBeGreaterThanOrEqual(3);
    // The AI may read it, but not run the migration.
    const ai: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "x",
    };
    expect((await execute(registry, adapter, ai, "links.get_migration_report", {})).ok).toBe(true);
    expect((await execute(registry, adapter, ai, "links.migrate_to_references", {})).ok).toBe(
      false,
    );
  });

  it("revert refuses while a converted part was edited since, then restores the rest on request", async () => {
    await run("structured_sets.set", {
      kind: "nav-menu",
      slug: `${PFX}-menu`,
      displayName: `${PFX} menu`,
      items: [{ label: "About only", href: ABOUT }],
    });
    const msg = await failure("links.revert_migration", { runId: applyRunId });
    expect(msg).toContain("changed since the migration");
    expect(msg).toContain("skipConflicts");
    expect((await moduleRow(ids.nav)).html).toContain(`caelo:page/${ids.about}`); // nothing reverted

    const out = await run<{ restored: number; skippedConflicts: number; siteSnapshotId: string }>(
      "links.revert_migration",
      { runId: applyRunId, skipConflicts: true },
    );
    expect(out.skippedConflicts).toBe(1);
    expect((await moduleRow(ids.nav)).html).toContain(`href="${ABOUT}"`);
    expect((await moduleRow(ids.nav)).fields[0]?.default).toEqual([
      { label: "Pricing", href: `${PRICING}#plans` },
    ]);
    expect((await instanceValues(ids.instance)).cta_href).toBe(PRICING);
    expect((await setItems(ids.setId))[0]?.label).toBe("About only"); // the edit was kept
    const row = (await pluginRows()).find((r) => r.id === ids.pluginRow);
    expect(row?.payload.cta_href).toBe(PRICING);
    const branchState = (await asSystem(
      (tx) => tx`SELECT cis.state FROM content_instance_snapshots cis
                   JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
                  WHERE cis.content_instance_id = ${ids.branchInstance}::uuid
                  ORDER BY ss.created_at DESC LIMIT 1`,
    )) as { state: unknown }[];
    expect(json<{ values: { cta_href: string } }>(branchState[0]?.state).values.cta_href).toBe(
      ABOUT,
    );
    expect(await failure("links.revert_migration", { runId: applyRunId })).toContain(
      "already reverted",
    );
  });
});
