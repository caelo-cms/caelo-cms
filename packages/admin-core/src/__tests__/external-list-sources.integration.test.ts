// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a runtime-installed plugin offers a list source
 * (docs/dev/external-plugin-brokers.md §6.3), end to end on a real Postgres
 * and the real Deno sandbox: staged, approved by an Owner, activated, then
 * iterated by a module in the editor preview.
 *
 * - The entries come from the `$listSources` reserved entry, read from the
 *   plugin's private storage on render (read-only: a write is refused).
 * - Values are checked for the page (§4.5): a text label carrying markup
 *   renders escaped; a richtext body with `<script>` and a `javascript:`
 *   link are refused, the spot stays raw and the preview lists
 *   `plugin-value-refused`, which blocks Publish live.
 * - A build asks about many pages in chunks below the 1 MB wire line.
 *
 * The preview's cost with an external source is printed (PR measurement).
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  MAIN_RENDER,
  resetPluginHost,
  resolveListSources,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-list-sources-test",
};
const SLUG = "list-probe";
const SCHEMA = "plugin_list_probe";
const PFX = "t1729ls";

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  adminSchema: { items: { label: "text", body: "text", href: "text" } },
  operations: ["entries"],
  hasOnActivate: true,
  listSources: [
    {
      name: "probe_items",
      label: "Probe items",
      description: "Items the probe stores, one entry per row.",
      node: {
        label: "Item",
        fields: [
          { name: "label", label: "Label", type: "text" },
          { name: "body", label: "Body", type: "richtext" },
          { name: "link", label: "Link", type: "link" },
          { name: "note", label: "Note", type: "text" },
        ],
      },
    },
  ],
  requestedCapabilities: ["list_sources", "cms_admin_schema"],
  capabilityReasons: {
    list_sources: "Offer the stored items to modules",
    cms_admin_schema: "Keep the items private",
  },
};
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  listSourcesOperation: "entries",
  onActivate: async (ctx) => {
    if ((await ctx.adminQuery.list("items", { limit: 1 })).length > 0) return;
    await ctx.adminQuery.insert("items", { label: "Safe", body: "<p>Hello <strong>there</strong></p>", href: "https://example.com/a" });
    await ctx.adminQuery.insert("items", { label: "<img src=x onerror=alert(1)>", body: "<p>x</p><script>alert(1)</script>", href: "javascript:alert(1)" });
  },
  operations:{
    entries: async (ctx, args) => {
      const rows = await ctx.adminQuery.list("items", { limit: 10 });
      let note = "no write";
      try { await ctx.adminQuery.insert("items", { label: "from a render", body: "", href: "" }); note = "wrote"; }
      catch (e) { note = String(e.message).includes("cannot write from a render call") ? "write refused" : String(e.message); }
      const entries = rows
        .sort((a, b) => (a.label === "Safe" ? -1 : 1))
        .map((r, i) => ({ id: "item-" + i, values: { label: r.label, body: r.body, link: { href: r.href }, note } }));
      return { sources: Object.fromEntries(args.pageIds.map((id) => [id, { probe_items: entries }])) };
    },
  }};`;

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await dropSchema();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-list-sources-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
});
afterAll(async () => {
  resetPluginHost();
  await dropSchema();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

/** The plugin's schema and the rows this file creates, which outlive the per-file reset. */
const dropSchema = () =>
  adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
    await tx.execute(sql.raw("SET LOCAL caelo.actor_kind = 'system'"));
    await tx.execute(
      sql.raw(
        `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
      ),
    );
    await tx.execute(sql.raw(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`));
    await tx.execute(sql.raw(`DELETE FROM modules WHERE slug LIKE '%${PFX}%'`));
    await tx.execute(
      sql.raw(
        `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
      ),
    );
    await tx.execute(sql.raw(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`));
    await tx.execute(sql.raw(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`));
  });

async function call(
  name: string,
  input: unknown,
  ctx = system as { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string },
) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function owner() {
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

/** Stage, approve as an Owner and activate the probe. */
async function install(): Promise<void> {
  const staged = (await call("plugins.stage_installation", { manifest, source })) as {
    installationId: string;
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
      capabilities: manifest.requestedCapabilities,
    },
    await owner(),
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
}

/** A page whose module iterates the probe's source. */
async function pageWithSource(): Promise<string> {
  const { layoutId } = (await call("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1729 layout",
    html: '<body><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  })) as { layoutId: string };
  const { templateId } = (await call("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1729",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  })) as { templateId: string };
  await call("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { pageId } = (await call("pages.build_page", {
    page: { slug: `${PFX}-page`, title: "Probe", templateId, status: "draft", pageType: "home" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} Probe list`,
        description: "Lists the probe plugin's items.",
        kind: "content",
        html: '<ul class="probe">{{#probe_items}}<li><b>{{label}}</b><div>{{body}}</div><a href="{{link}}">go</a><i>{{note}}</i></li>{{/probe_items}}</ul>',
        fields: [],
        content: { source: "inline", values: {} },
      },
    ],
  })) as { pageId: string };
  return pageId;
}

it("a runtime-installed plugin's list source renders checked values in the preview", async () => {
  await install();
  const pageId = await pageWithSource();

  const started = performance.now();
  const preview = (await call("pages.render_preview", { pageId })) as {
    html: string;
    missingSlots: string[];
    pluginFailures: { slug: string; reason: string }[];
  };
  const previewMs = performance.now() - started;
  expect(preview.pluginFailures).toEqual([]);
  // Read from private storage on render; the write attempt was refused.
  expect(preview.html).toContain("<b>Safe</b><div><p>Hello <strong>there</strong></p></div>");
  expect(preview.html).toContain('<a href="https://example.com/a">go</a><i>write refused</i>');
  // A label carrying markup is data: escaped, never an element.
  expect(preview.html).toContain("<b>&lt;img src=x onerror=alert(1)&gt;</b>");
  expect(preview.html).not.toContain("<img src=x");
  expect(preview.html).not.toContain("<script>");
  expect(preview.html).not.toContain("javascript:");
  // The refused richtext and link stay raw and are listed (they block Publish live).
  expect(preview.html).toContain("<div>{{body}}</div>");
  expect(preview.missingSlots).toContain(
    "plugin-value-refused:list-probe.probe_items.body:element-script",
  );
  expect(preview.missingSlots).toContain(
    "plugin-value-refused:list-probe.probe_items.link:url-scheme",
  );

  // A second preview of the same page, for the cost of one sandboxed point.
  const again = performance.now();
  await call("pages.render_preview", { pageId });
  const secondMs = performance.now() - again;
  console.log(
    `[measure] preview with an external list source: first ${previewMs.toFixed(0)} ms, second ${secondMs.toFixed(0)} ms`,
  );
}, 120_000);

it("a build asks about many pages in chunks below the wire line", async () => {
  const ids = Array.from(
    { length: 30_000 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  const started = performance.now();
  const resolved = await resolveListSources(ids, MAIN_RENDER, "directory");
  const ms = performance.now() - started;
  expect(resolved.size).toBe(ids.length);
  expect(resolved.get(ids[29_999] as string)?.probe_items).toHaveLength(2);
  console.log(
    `[measure] build-style resolve of ${ids.length} pages from an external list source: ${ms.toFixed(0)} ms`,
  );
}, 180_000);
