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
 *     layouts' own HTML, plugin storage via the plugin hook;
 *   - a dry run reports and writes nothing;
 *   - apply converts, emits ONE main-line snapshot, reports unresolved
 *     links with where they are, and is listed by the report op;
 *   - unresolvable links stay literal (never guessed);
 *   - idempotency: a second run converts nothing; the boot guard skips;
 *   - chat branches: a chat's pending state is converted by appending a
 *     pending snapshot owned by the same chat task;
 *   - revert restores exactly what changed, and refuses (names) a part
 *     edited since unless told to keep it;
 *   - the report's revert target is the latest unreverted conversion
 *     that changed something (not a later dry run or no-op re-run);
 *   - an edit committed while the migration runs is not overwritten;
 *   - a media literal becomes `caelo:media/<id>`.
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
import { TEST_MEDIA_DIGEST } from "./fixtures/media-digest.js";

/** The chrome nav's one list entry (epic #1107), linking `href`. */
const navEntry = (href: string) => ({
  id: "00000000-0000-4000-9000-000000000001",
  node: "link",
  values: { label: "Pricing", link: { href } },
});
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
const SHA = `1e3a${"9".repeat(60)}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
const ids = {
  about: "",
  pricing: "",
  nav: "",
  card: "",
  instance: "",
  branch: "",
  branchInstance: "",
  pluginRow: "",
  media: "",
  layout: "",
};

/** The layout frame as an Owner rewrote it after the migration (a revert conflict). */
const EDITED_LAYOUT =
  '<body><a class="frame" href="https://example.com/edited">x</a><caelo-slot name="content">_</caelo-slot></body>';

async function layoutHtml(id: string): Promise<string> {
  const rows = (await asSystem((tx) => tx`SELECT html FROM layouts WHERE id = ${id}::uuid`)) as {
    html: string;
  }[];
  return rows[0]?.html ?? "";
}
let mediaSlug = "";

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
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}%`} OR display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`} OR display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    await tx`DELETE FROM layout_blocks WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM layouts WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE sha256 = ${SHA})`;
    await tx`DELETE FROM media_assets WHERE sha256 = ${SHA}`;
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
      pageType: "home",
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
  const media = await run<{ assetId: string; slug: string }>("media.upload", {
    sha256: SHA,
    originalName: `${PFX}-logo.png`,
    name: `${PFX} logo`,
    mime: "image/png",
    sizeBytes: 4,
    width: 4,
    height: 4,
    alt: "",
    storageKey: `${SHA}/orig.png`,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: 4,
        height: 4,
        sizeBytes: 4,
        storageKey: `${SHA}/orig.png`,
        digest: TEST_MEDIA_DIGEST,
      },
    ],
  });
  ids.media = media.assetId;
  mediaSlug = media.slug;

  // Layout chrome: links in the HTML and in a list field default.
  ids.nav = (
    await run<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-nav`,
      displayName: `${PFX} Nav`,
      html: '<nav><a href="https://example.com/">Home</a>{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}</nav>',
      fields: [{ name: "links", kind: "list", listType: "links", label: "Links", default: [] }],
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
  const put = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR },
    pluginSlug: PLUGIN_SLUG,
    operationName: "put",
    args: { payload: { cta_href: "https://example.com/y" } },
  });
  if (!put.ok) throw new Error(`put: ${put.error.message}`);
  ids.pluginRow = (put.value as { id: string }).id;
  ids.layout = (
    await run<{ layoutId: string }>("layouts.create", {
      slug: `${PFX}-layout`,
      displayName: `${PFX} frame`,
      html: '<body><a class="frame" href="https://example.com/">x</a><caelo-slot name="content">_</caelo-slot></body>',
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    })
  ).layoutId;

  // The pre-#724 state: literal paths everywhere.
  await asSystem(async (tx) => {
    await tx`UPDATE modules SET html = ${`<nav><img src="/_caelo/media/${mediaSlug}" alt=""><a href="${ABOUT}">About</a><a href="${GONE}">Old</a>{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}</nav>`},
             fields = (${JSON.stringify([{ name: "links", kind: "list", listType: "links", label: "Links", default: [navEntry(`${PRICING}#plans`)] }])}::text)::jsonb
             WHERE id = ${ids.nav}::uuid`;
    await tx`UPDATE content_instances SET "values" = (${JSON.stringify({
      cta_label: "Buy",
      cta_href: PRICING,
      price_note: "/month",
      body_html: `<p>See <a href="${ABOUT}">about</a> and <a href="https://example.com/ext">ext</a></p>`,
    })}::text)::jsonb WHERE id = ${ids.instance}::uuid`;
    await tx`UPDATE layouts SET html = ${`<body><a class="frame" href="${ABOUT}">About</a><caelo-slot name="content">_</caelo-slot></body>`}
             WHERE id = ${ids.layout}::uuid`;
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
    expect(nav.html).toContain(`<img src="caelo:media/${ids.media}" alt="">`);
    expect(nav.html).toContain(`href="${GONE}"`); // never guessed
    expect(nav.fields[0]?.default).toEqual([navEntry(`caelo:page/${ids.pricing}#plans`)]);

    const values = await instanceValues(ids.instance);
    expect(values.cta_href).toBe(`caelo:page/${ids.pricing}`);
    expect(values.price_note).toBe("/month"); // a text field is not a link
    expect(values.body_html).toBe(
      `<p>See <a href="caelo:page/${ids.about}">about</a> and <a href="https://example.com/ext">ext</a></p>`,
    );

    // A layout's own HTML (the page frame) is converted too: the composer
    // resolves references there (rollout C).
    expect(await layoutHtml(ids.layout)).toContain(
      `<a class="frame" href="caelo:page/${ids.about}">About</a>`,
    );
    expect(out.run.counts.layout_html).toBeGreaterThanOrEqual(1);

    // The plugin hook: core converted the column the plugin named.
    const row = (await pluginRows()).find((r) => r.id === ids.pluginRow);
    expect(row?.payload.cta_href).toBe(`caelo:page/${ids.pricing}`);

    const mine = out.unresolved.filter((u) => u.value === GONE);
    expect(mine.map((u) => u.surface).sort()).toEqual(["module_html"]);
    expect(mine.find((u) => u.surface === "module_html")?.label).toBe(`module "${PFX} Nav"`);

    // ONE main-line snapshot carries every changed entity, plugin row included.
    const snap = (await asSystem(
      (tx) => tx`SELECT op_kind, chat_branch_id,
                        (SELECT count(*) FROM module_snapshots WHERE site_snapshot_id = s.id)::int AS modules,
                        (SELECT count(*) FROM content_instance_snapshots WHERE site_snapshot_id = s.id)::int AS instances,
                        (SELECT count(*) FROM plugin_row_snapshots WHERE site_snapshot_id = s.id)::int AS plugin_rows
                   FROM site_snapshots s WHERE id = ${out.run.siteSnapshotId}::uuid`,
    )) as {
      op_kind: string;
      chat_branch_id: string | null;
      modules: number;
      instances: number;
      plugin_rows: number;
    }[];
    expect(snap[0]).toMatchObject({ op_kind: "links.migrate_to_references", chat_branch_id: null });
    expect(snap[0]?.modules).toBeGreaterThanOrEqual(1);
    expect(snap[0]?.instances).toBeGreaterThanOrEqual(1);
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
    expect(again.unresolved.filter((u) => u.value === GONE)).toHaveLength(1);
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
    expect(report.unresolvedTotal).toBe(1);
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

  it("offers the conversion that changed something for revert, whatever ran after it", async () => {
    interface Report {
      run: { runId: string; mode: string };
      revertableRun: { runId: string } | null;
    }
    // Latest is the no-op re-run: it changed nothing, so it is not offered.
    const afterNoop = await run<Report>("links.get_migration_report", {});
    expect(afterNoop.run.mode).toBe("apply");
    expect(afterNoop.run.runId).not.toBe(applyRunId);
    expect(afterNoop.revertableRun?.runId).toBe(applyRunId);
    // A later dry run is reported, and does not hide the real conversion.
    await run<MigrateOut>("links.migrate_to_references", { dryRun: true });
    const afterDry = await run<Report>("links.get_migration_report", {});
    expect(afterDry.run.mode).toBe("dry_run");
    expect(afterDry.revertableRun?.runId).toBe(applyRunId);
  });

  it("revert refuses while a converted part was edited since, then restores the rest on request", async () => {
    // An Owner edit of the layout frame after the migration.
    await asSystem(
      (tx) => tx`UPDATE layouts SET html = ${EDITED_LAYOUT} WHERE id = ${ids.layout}::uuid`,
    );
    const refused = await run<{
      reverted: boolean;
      conflicts: { entityKind: string; entityId: string }[];
    }>("links.revert_migration", { runId: applyRunId });
    expect(refused.reverted).toBe(false);
    expect(refused.conflicts).toEqual([
      expect.objectContaining({ entityKind: "layout", entityId: ids.layout }),
    ]);
    expect((await moduleRow(ids.nav)).html).toContain(`caelo:page/${ids.about}`); // nothing reverted

    const out = await run<{
      reverted: boolean;
      restored: number;
      skippedConflicts: number;
      siteSnapshotId: string;
    }>("links.revert_migration", { runId: applyRunId, skipConflicts: true });
    expect(out.reverted).toBe(true);
    expect(out.skippedConflicts).toBe(1);
    expect((await moduleRow(ids.nav)).html).toContain(`href="${ABOUT}"`);
    expect((await moduleRow(ids.nav)).html).toContain(`src="/_caelo/media/${mediaSlug}"`);
    expect((await moduleRow(ids.nav)).fields[0]?.default).toEqual([navEntry(`${PRICING}#plans`)]);
    expect((await instanceValues(ids.instance)).cta_href).toBe(PRICING);
    expect(await layoutHtml(ids.layout)).toBe(EDITED_LAYOUT); // the edit was kept
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
    const report = await run<{ revertableRun: unknown }>("links.get_migration_report", {});
    expect(report.revertableRun).toBeNull();
  });

  it("an edit committed while the migration runs is converted, never overwritten", async () => {
    // An editor's transaction holds the module row with an edit when the
    // migration starts; the migration must wait for it and convert the
    // EDITED html, not write the converted old html over it.
    let edited!: () => void;
    const editApplied = new Promise<void>((r) => {
      edited = r;
    });
    let commit!: () => void;
    const released = new Promise<void>((r) => {
      commit = r;
    });
    const editing = asSystem(async (tx) => {
      await tx`UPDATE modules SET html = ${`<nav data-edit="1"><a href="${ABOUT}">About</a></nav>`}
               WHERE id = ${ids.nav}::uuid`;
      edited();
      await released;
    });
    await editApplied;
    const migrating = run<MigrateOut>("links.migrate_to_references", {});
    await new Promise((r) => setTimeout(r, 300));
    commit();
    await editing;
    await migrating;
    expect((await moduleRow(ids.nav)).html).toBe(
      `<nav data-edit="1"><a href="caelo:page/${ids.about}">About</a></nav>`,
    );
  });
});
