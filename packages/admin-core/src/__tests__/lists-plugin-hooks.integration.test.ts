// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G (#1114) — the plugin hooks of the lists model, against
 * the real plugin host and Postgres:
 *   - list sources: a valid answer reaches the page; malformed entries,
 *     foreign page ids, undeclared names, duplicate or invalid ids,
 *     undeclared keys and oversized answers are refused loudly; a source
 *     without its grant is refused at registration;
 *   - plugin list types: stored owned by the plugin, refused to edit by a
 *     person or the AI, archived with the plugin and back with it;
 *   - definition extensions: validated against the RUNNING plugin's
 *     schema, inert while it is off (kept unchanged, never added or
 *     changed), and marked inert by list_types.list;
 *   - list-resolve: an overlay replaces values in the rendering page's
 *     variant; it cannot add an entry or change structure — the refused
 *     entries reach the plugin's error channel (plugin_errors).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  applyPluginLifecycle,
  bootstrap,
  LIST_SOURCE_ANSWER_MAX_BYTES,
  MAIN_RENDER,
  resetPluginHost,
  resetPluginHostSync,
  resolveListSources,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoDefaultPageType } from "./_template-page-type.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1114-hooks",
};
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "human",
  requestId: "t1114-hooks-human",
};
const PLUGIN = "t1114-hooks";
const NOGRANT = "t1114-nogrant";
const TYPE = `${PLUGIN}-badges`;
const SITE_TYPE = "t1114-site-type";
const LIST_SLUG = "t1114-menu";
const TPL_SLUG = "t1114-tpl";
const MOD_SLUG = "t1114-mod";
const PAGE_SLUG = "t1114-page";
const E1 = "00000000-0000-4000-9000-000000001141";
const E2 = "00000000-0000-4000-9000-000000001142";
const GHOST = "00000000-0000-4000-9000-000000001149";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let listId = "";
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;

/** What the test plugin answers, set per test. */
let sourceAnswer: (pageIds: string[]) => unknown = () => ({ sources: {} });
let overlayAnswer: () => unknown = () => ({ overlays: {} });

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
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
  resetPluginHostSync();
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
    await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
    await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    await tx`DELETE FROM list_snapshots WHERE list_id IN (SELECT id FROM lists WHERE slug = ${LIST_SLUG})`;
    await tx`DELETE FROM lists WHERE slug = ${LIST_SLUG}`;
    await tx`DELETE FROM list_type_snapshots WHERE list_type_id IN (SELECT id FROM list_types WHERE slug IN (${TYPE}, ${SITE_TYPE}))`;
    await tx`DELETE FROM list_types WHERE slug IN (${TYPE}, ${SITE_TYPE})`;
    for (const slug of [PLUGIN, NOGRANT]) {
      await tx`DELETE FROM plugin_runtime WHERE plugin_slug = ${slug}`;
      await tx`DELETE FROM plugin_errors WHERE plugin_slug = ${slug}`;
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
      await tx`DELETE FROM plugins WHERE slug = ${slug}`;
    }
  });
}

async function run(ctx: ExecutionContext, op: string, input: unknown) {
  return execute(registry, adapter, ctx, op, input);
}

async function ok<T>(op: string, input: unknown, ctx: ExecutionContext = SYSTEM): Promise<T> {
  const r = await run(ctx, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

const badgeType = {
  slug: TYPE,
  name: "Badges",
  purpose: "Badges the plugin ships",
  role: "content" as const,
  root: { allow: ["badge"] },
  nodes: {
    badge: { label: "Badge", fields: [{ name: "text", label: "Text", type: "text" as const }] },
  },
};

function siteType(ext?: Record<string, unknown>) {
  return {
    slug: SITE_TYPE,
    name: "Site type",
    purpose: "A type the site owns",
    role: "content" as const,
    root: { allow: ["row"] },
    nodes: {
      row: {
        label: "Row",
        fields: [{ name: "label", label: "Label", type: "text" as const, ...(ext ? { ext } : {}) }],
      },
    },
  };
}

beforeAll(async () => {
  await wipe();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const menu = await ok<{ lists: { id: string }[] }>("lists.upsert_many", {
    lists: [
      {
        slug: LIST_SLUG,
        name: "Menu",
        purpose: "Test menu",
        type: "links",
        items: [
          {
            id: E1,
            node: "link",
            values: { label: "Docs", link: { href: "https://example.org/docs" } },
          },
          {
            id: E2,
            node: "link",
            values: { label: "Blog", link: { href: "https://example.org/blog" } },
          },
        ],
      },
    ],
  });
  listId = menu.lists[0]?.id ?? "";

  await sqlSystem(async (tx) => {
    const tpl = (await tx`
      INSERT INTO templates (slug, display_name, html, layout_id)
      VALUES (${TPL_SLUG}, 'T', '<body><caelo-slot name="content">_</caelo-slot></body>',
              (SELECT id FROM layouts WHERE slug = 'site-default'))
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const templateId = tpl[0]?.id ?? "";
    await adoptTemplateIntoDefaultPageType(tx, templateId);
    await tx`INSERT INTO template_blocks (template_id, name, display_name, position)
             VALUES (${templateId}::uuid, 'content', 'Content', 0)`;
    const fields = JSON.stringify([
      {
        name: "menu",
        kind: "list",
        listType: "links",
        bind: "shared",
        list: `caelo:list/${listId}`,
        label: "Menu",
      },
    ]);
    const mod = (await tx`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (${MOD_SLUG}, 'Menu', ${MOD_SLUG},
              '<nav>{{#menu}}<a>{{label}}</a>{{/menu}}</nav>', ${fields}::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${mod[0]?.id}::uuid, '{}'::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const page = (await tx`
      INSERT INTO pages (slug, name, title, template_id, status)
      VALUES (${PAGE_SLUG}, 'P', 'P', ${templateId}::uuid, 'published')
      RETURNING id::text AS id`) as unknown as { id: string }[];
    pageId = page[0]?.id ?? "";
    await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
             VALUES (${pageId}::uuid, 'content', 0, ${mod[0]?.id}::uuid, ${ci[0]?.id}::uuid, 'unsynced')`;
  });

  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM.actorId,
    testPlugins: [
      {
        definition: definePlugin({
          slug: PLUGIN,
          version: "0.1.0",
          tier: 1,
          schema: {},
          requestedCapabilities: ["list_sources", "list_types", "list_resolve", "link_resolve"],
          listSources: [
            {
              name: "t1114_badges",
              label: "Badges",
              description: "Test badges.",
              node: {
                label: "Badge",
                fields: [
                  { name: "text", label: "Text", type: "text", required: true },
                  { name: "on", label: "On", type: "boolean" },
                ],
              },
            },
          ],
          listSourcesOperation: "badges",
          listTypes: [badgeType],
          listExt: {
            field: {
              type: "object",
              additionalProperties: false,
              properties: { translate: { type: "boolean" } },
            },
          },
          linkResolveOperation: "link_resolve",
          listResolveOperation: "list_resolve",
          operations: {
            badges: async (_ctx, args) => sourceAnswer((args as { pageIds: string[] }).pageIds),
            link_resolve: async () => ({ pages: { [pageId]: { variant: "xx", group: null } } }),
            list_resolve: async () => overlayAnswer(),
          },
        }),
      },
    ],
  });
  expect(report.failed).toEqual([]);
});

afterAll(async () => {
  await wipe();
  await restoreBase?.();
  await restoreLang?.();
  await adapter.close();
});

describe("plugin list sources", () => {
  const entries = (pageIds: string[], list: unknown[]) => ({
    sources: Object.fromEntries(pageIds.map((id) => [id, { t1114_badges: list }])),
  });

  it("hands valid entries to the page, typed by the source's node", async () => {
    sourceAnswer = (ids) => entries(ids, [{ id: "a", values: { text: "New", on: true } }]);
    const r = await resolveListSources([pageId], MAIN_RENDER, "directory");
    expect(r.get(pageId)?.t1114_badges).toEqual([{ id: "a", values: { text: "New", on: true } }]);
  });

  const refused: [string, (ids: string[]) => unknown, RegExp][] = [
    [
      "a value of the wrong type",
      (ids) => entries(ids, [{ id: "a", values: { text: 7 } }]),
      /must be a string/,
    ],
    ["a missing required value", (ids) => entries(ids, [{ id: "a", values: {} }]), /is required/],
    [
      "a key the node does not declare",
      (ids) => entries(ids, [{ id: "a", values: { text: "x", html: "<b>" } }]),
      /declares no field "html"/,
    ],
    [
      "a duplicate id",
      (ids) =>
        entries(ids, [
          { id: "a", values: { text: "x" } },
          { id: "a", values: { text: "y" } },
        ]),
      /appears twice/,
    ],
    [
      "an id that is not a stable token",
      (ids) => entries(ids, [{ id: "a b/../c", values: { text: "x" } }]),
      /entry ids/,
    ],
    [
      "an entry without the { id, values } shape",
      (ids) => entries(ids, ["<script>"]),
      /expected \{ id, values \}/,
    ],
    [
      "a page that was not asked about",
      () => ({ sources: { [GHOST]: { t1114_badges: [] } } }),
      /not part of this render/,
    ],
    [
      "a name the plugin did not declare",
      (ids) => ({ sources: { [ids[0] as string]: { language_links: [] } } }),
      /did not declare/,
    ],
    [
      "more entries than a list holds",
      (ids) =>
        entries(
          ids,
          Array.from({ length: 501 }, (_, i) => ({ id: `e${i}`, values: { text: "x" } })),
        ),
      /at most 500/,
    ],
    [
      "an oversized answer",
      (ids) =>
        entries(ids, [{ id: "a", values: { text: "x".repeat(LIST_SOURCE_ANSWER_MAX_BYTES) } }]),
      /bytes, more than/,
    ],
    ["a non-object answer", () => "lists", /expected \{ sources/],
  ];
  for (const [what, answer, message] of refused) {
    it(`refuses ${what} loudly`, async () => {
      sourceAnswer = answer;
      await expect(resolveListSources([pageId], MAIN_RENDER, "directory")).rejects.toThrow(message);
    });
  }

  it("refuses a plugin that declares a source without the list_sources grant", async () => {
    const report = await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM.actorId,
      testPlugins: [
        {
          definition: definePlugin({
            slug: NOGRANT,
            version: "0.1.0",
            tier: 1,
            schema: {},
            listSources: [
              {
                name: "t1114_nogrant",
                label: "X",
                description: "x",
                node: { label: "X", fields: [{ name: "text", label: "T", type: "text" }] },
              },
            ],
            listSourcesOperation: "x",
            operations: { x: async () => ({ sources: {} }) },
          }),
        },
      ],
    });
    // The manifest validator refuses it first; the registration seam would too.
    expect(report.failed.map((f) => f.slug)).toEqual([NOGRANT]);
    expect(JSON.stringify(report.failed)).toContain("manifest-cap-missing");
  });
});

describe("plugin list types", () => {
  it("are stored owned by the plugin and refuse edits by a person", async () => {
    const listed = await ok<{ listTypes: { slug: string; ownerPlugin: string | null }[] }>(
      "list_types.list",
      {},
    );
    expect(listed.listTypes.find((t) => t.slug === TYPE)?.ownerPlugin).toBe(PLUGIN);
    const edit = await run(HUMAN, "list_types.upsert_many", {
      listTypes: [{ ...badgeType, name: "Mine now" }],
    });
    expect(edit.ok).toBe(false);
    expect(JSON.stringify(edit)).toContain(`ships with plugin \\"${PLUGIN}\\"`);
    const del = await run(HUMAN, "list_types.delete_many", { slugs: [TYPE] });
    expect(JSON.stringify(del)).toContain("ships with plugin");
  });

  it("are archived while the plugin is off and back when it runs", async () => {
    const slugs = async () =>
      (await ok<{ listTypes: { slug: string }[] }>("list_types.list", {})).listTypes.map(
        (t) => t.slug,
      );
    await sqlSystem((tx) => tx`UPDATE plugins SET status = 'disabled' WHERE slug = ${PLUGIN}`);
    expect(await slugs()).not.toContain(TYPE);
    await sqlSystem((tx) => tx`UPDATE plugins SET status = 'active' WHERE slug = ${PLUGIN}`);
    expect(await slugs()).toContain(TYPE);
  });
});

describe("definition extensions", () => {
  it("validate ext.<plugin> against the running plugin's schema", async () => {
    const bad = await run(SYSTEM, "list_types.upsert_many", {
      listTypes: [siteType({ [PLUGIN]: { translate: "yes" } })],
    });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain(`nodes.row.fields.label.ext.${PLUGIN}`);
    const unknown = await run(SYSTEM, "list_types.upsert_many", {
      listTypes: [siteType({ "t1114-nobody": { translate: true } })],
    });
    expect(JSON.stringify(unknown)).toContain("is not running");
    await ok("list_types.upsert_many", {
      listTypes: [siteType({ [PLUGIN]: { translate: false } })],
    });
  });

  it("stay inert while the plugin is off: kept unchanged, never added or changed", async () => {
    applyPluginLifecycle(PLUGIN, "disable");
    try {
      const listed = await ok<{ listTypes: { slug: string; inertExt: string[] }[] }>(
        "list_types.list",
        {},
      );
      expect(listed.listTypes.find((t) => t.slug === SITE_TYPE)?.inertExt).toEqual([
        `nodes.row.fields.label.ext.${PLUGIN}`,
      ]);
      // Unchanged (another edit of the type) passes.
      await ok("list_types.upsert_many", {
        listTypes: [{ ...siteType({ [PLUGIN]: { translate: false } }), name: "Renamed" }],
      });
      const changed = await run(SYSTEM, "list_types.upsert_many", {
        listTypes: [siteType({ [PLUGIN]: { translate: true } })],
      });
      expect(changed.ok).toBe(false);
      expect(JSON.stringify(changed)).toContain("Activate the plugin first");
    } finally {
      applyPluginLifecycle(PLUGIN, "enable");
    }
  });
});

describe("list-resolve", () => {
  beforeAll(() => {
    sourceAnswer = () => ({ sources: {} });
  });
  async function preview(): Promise<string> {
    const r = await ok<{ html: string }>("pages.render_preview", { pageId });
    return r.html;
  }
  const errors = async () =>
    (await sqlSystem(
      (tx) =>
        tx`SELECT message FROM plugin_errors WHERE plugin_slug = ${PLUGIN} AND phase = 'render'`,
    )) as unknown as { message: string }[];

  it("replaces values and hides entries in the rendering page's variant", async () => {
    overlayAnswer = () => ({
      overlays: {
        xx: {
          values: { [`list/${listId}/item/${E1}/label`]: "Doku" },
          hidden: [`list/${listId}/item/${E2}`],
        },
      },
    });
    const html = await preview();
    expect(html).toContain(">Doku</a>");
    expect(html).not.toContain("Blog");
    expect(await errors()).toEqual([]);
  });

  it("cannot add an entry or change structure; the refusal reaches the plugin's error channel", async () => {
    overlayAnswer = () => ({
      overlays: {
        xx: {
          values: {
            // An entry the list does not have — an overlay may not add one.
            [`list/${listId}/item/${GHOST}/label`]: "Injected",
            // A field the node does not declare.
            [`list/${listId}/item/${E1}/html`]: "<script>",
            // A link is not text; a value that fails its field is refused.
            [`list/${listId}/item/${E2}/link`]: { nope: true },
          },
          hidden: [`list/${listId}/item/${GHOST}`],
        },
      },
    });
    const html = await preview();
    expect(html).not.toContain("Injected");
    expect(html).not.toContain("<script>");
    expect(html).toContain(">Docs</a>");
    expect(html).toContain(">Blog</a>");
    const rows = await errors();
    expect(rows.length).toBe(1);
    expect(rows[0]?.message).toContain("list-resolve: the render refused 4 overlay entries");
    expect(rows[0]?.message).toContain(`list/${listId}/item/${GHOST}/label: no such list entry`);
  });

  it("refuses an overlay for a variant the render does not have", async () => {
    overlayAnswer = () => ({ overlays: { zz: { values: {}, hidden: [] } } });
    const r = await run(SYSTEM, "pages.render_preview", { pageId });
    expect(JSON.stringify(r)).toContain('answered for variant \\"zz\\"');
  });
});
