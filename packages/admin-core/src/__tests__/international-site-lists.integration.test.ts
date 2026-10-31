// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G (#1114) — international-site translates LISTS by
 * value address, end to end against a real Postgres, the real plugin host
 * and a scripted AI: every row of the change-handling table (plugin
 * README "Lists"), the visibility tool, answers by address, the
 * vocabulary slug rule, the Stage-audit findings, and — with the plugin
 * not running — no variants: the stored values render.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  drainChangeConsumers,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1114i",
};
const PFX = "t1114i";
const TYPE = `${PFX}-nav`;
const VOCAB_TYPE = `${PFX}-tags`;
const E = (n: number) => `00000000-0000-4000-9000-0000000114${String(n).padStart(2, "0")}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
const ids = { list: "", vocab: "", en: "", de: "", about: "", target: "" };

/** Scripted translator: "DE:<source>" for every offered path (see international-site-chrome). */
type Schema = {
  properties: {
    targets: {
      items: {
        anyOf: Array<{
          properties: { target: { enum: string[] }; strings: { required: string[] } };
        }>;
      };
    };
  };
};
const scriptedProvider = {
  complete: async () => {
    throw new Error("translations use generateObject");
  },
  generateObject: async (opts: {
    messages: ReadonlyArray<{ content: string }>;
    jsonSchema: Record<string, unknown>;
  }) => {
    const user = opts.messages[0]?.content ?? "";
    const source = new Map<string, string>();
    for (const section of user.split("### Target ").slice(1)) {
      const id = section.slice(0, section.indexOf(" "));
      for (const m of section.matchAll(/([^\n]+):\n```\n([\s\S]*?)\n```/g)) {
        if (m[1] && m[2] !== undefined) source.set(`${id}|${m[1]}`, m[2]);
      }
    }
    const targets = (opts.jsonSchema as Schema).properties.targets.items.anyOf.map((v) => {
      const id = v.properties.target.enum[0] ?? "";
      const strings: Record<string, string> = {};
      for (const path of v.properties.strings.required) {
        // Slugs stay slugs: a unique, url-safe answer per entry.
        const text = source.get(`${id}|${path}`) ?? "";
        strings[path] = path.endsWith("/slug") ? `de-${text}` : `DE:${text}`;
      }
      return { target: id, strings };
    });
    return { object: { targets }, inputTokens: 1, outputTokens: 1 };
  },
};

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

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe(
      "DELETE FROM plugin_event_cursors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'international-site')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM redirects WHERE from_path LIKE '%${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM list_snapshots WHERE list_id IN (SELECT id FROM lists WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM lists WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM list_type_snapshots WHERE list_type_id IN (SELECT id FROM list_types WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM list_types WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM deploy_runs WHERE target_id IN (SELECT id FROM deploy_targets WHERE name LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM deploy_targets WHERE name LIKE '${PFX}-%'`);
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function op<T>(operationName: string, args: unknown = {}): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function opError(operationName: string, args: unknown): Promise<string> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (r.ok) throw new Error(`${operationName} unexpectedly succeeded`);
  return r.error.message;
}

/** The labels a page's menu shows, in order. */
async function menu(pageId: string): Promise<string[]> {
  const r = await sysOp<{ html: string }>("pages.render_preview", { pageId });
  const nav = /<nav class="t1114i"[^>]*>([\s\S]*?)<\/nav>/.exec(r.html)?.[1] ?? "";
  return [...nav.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => m[1] ?? "");
}

/** The stored rows of one table, by address-ish key. */
async function rows(table: string): Promise<Record<string, unknown>[]> {
  return (await sqlSystem(async (tx) => {
    // The plugin's schema is FORCE RLS-scoped to the plugin's id.
    await tx`SELECT set_config('caelo.plugin_id', (SELECT id::text FROM plugins WHERE slug = 'international-site'), true)`;
    // Deleted rows stay as tombstones (branch-aware storage, #508).
    return tx.unsafe(
      `SELECT * FROM plugin_international_site.${table} WHERE caelo_deleted_at IS NULL ORDER BY created_at`,
    );
  })) as unknown as Record<string, unknown>[];
}

/**
 * What an instance woken by the change journal does (#1267): run the
 * plugin's change consumer to the end of the journal.
 */
async function tick(): Promise<void> {
  const reports = await drainChangeConsumers({ adapter, registry });
  for (const r of reports) if (r.error) throw new Error(`${r.slug}: ${r.error}`);
}

async function patch(patches: unknown[]): Promise<void> {
  await sysOp("lists.patch_items_many", { lists: [{ slug: `${PFX}-menu`, patches }] });
}

const labelAddr = (n: number) => `list/${ids.list}/item/${E(n)}/label`;

function navType(noteTranslate: boolean) {
  return {
    slug: TYPE,
    name: "Nav",
    purpose: "Test navigation",
    role: "navigation" as const,
    root: { allow: ["entry"] },
    nodes: {
      entry: {
        label: "Entry",
        fields: [
          { name: "label", label: "Label", type: "text" as const, required: true },
          {
            name: "note",
            label: "Note",
            type: "text" as const,
            ext: { "international-site": { translate: noteTranslate } },
          },
          { name: "link", label: "Link", type: "link" as const },
        ],
      },
    },
  };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  const report = await bootstrap({
    infra: { adapter, registry, aiProvider: scriptedProvider },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  await op("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });

  await sysOp("list_types.upsert_many", {
    listTypes: [
      navType(false),
      {
        slug: VOCAB_TYPE,
        name: "Tags",
        purpose: "Test tags",
        role: "vocabulary",
        root: { allow: ["tag"] },
        nodes: {
          tag: {
            label: "Tag",
            fields: [
              { name: "name", label: "Name", type: "text", required: true },
              { name: "slug", label: "Slug", type: "text", required: true },
            ],
          },
        },
      },
    ],
  });

  // Pages: pricing (with a German version), about (English only).
  await sqlSystem(async (tx) => {
    const tpl = (await tx`
      INSERT INTO templates (slug, display_name, html, layout_id)
      VALUES (${`${PFX}-tpl`}, 'T', '<body><caelo-slot name="content">_</caelo-slot></body>',
              (SELECT id FROM layouts WHERE slug = 'site-default'))
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const templateId = tpl[0]?.id ?? "";
    await adoptTemplateIntoHomePageType(tx, templateId);
    await tx`INSERT INTO template_blocks (template_id, name, display_name, position)
             VALUES (${templateId}::uuid, 'content', 'Content', 0)`;
    for (const slug of ["pricing", "about"]) {
      const p = (await tx`
        INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed)
        VALUES (${`${PFX}-${slug}`}, ${slug}, ${slug}, ${templateId}::uuid, 'published', true)
        RETURNING id::text AS id`) as unknown as { id: string }[];
      if (slug === "pricing") ids.en = p[0]?.id ?? "";
      else ids.about = p[0]?.id ?? "";
    }
  });
  await sysOp("pages.refresh_current_path", { pageId: ids.en });
  await sysOp("pages.refresh_current_path", { pageId: ids.about });

  const lists = await sysOp<{ lists: { id: string; slug: string }[] }>("lists.upsert_many", {
    lists: [
      {
        slug: `${PFX}-menu`,
        name: "Main menu",
        purpose: "Test menu",
        type: TYPE,
        items: [
          {
            id: E(1),
            node: "entry",
            values: { label: "Pricing", note: "SKU-1", link: { href: `caelo:page/${ids.en}` } },
          },
          {
            id: E(2),
            node: "entry",
            values: { label: "About", link: { href: `caelo:page/${ids.about}` } },
          },
          {
            id: E(3),
            node: "entry",
            values: { label: "Status", link: { href: "https://status.example.org/" } },
          },
        ],
      },
      {
        slug: `${PFX}-tags`,
        name: "Tags",
        purpose: "Test tags",
        type: VOCAB_TYPE,
        items: [
          { id: E(11), node: "tag", values: { name: "News", slug: "news" } },
          { id: E(12), node: "tag", values: { name: "Tips", slug: "tips" } },
        ],
      },
    ],
  });
  ids.list = lists.lists.find((l) => l.slug === `${PFX}-menu`)?.id ?? "";
  ids.vocab = lists.lists.find((l) => l.slug === `${PFX}-tags`)?.id ?? "";

  await sqlSystem(async (tx) => {
    const fields = JSON.stringify([
      {
        name: "menu",
        kind: "list",
        listType: TYPE,
        bind: "shared",
        list: `caelo:list/${ids.list}`,
        label: "Menu",
      },
    ]);
    const mod = (await tx`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (${`${PFX}-nav`}, 'Nav', ${`${PFX}-nav`},
              '<nav class="t1114i"><ul>{{#menu}}<li>{{label}}</li>{{/menu}}</ul></nav>', (${fields}::text)::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${mod[0]?.id}::uuid, '{}'::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
             VALUES (${ids.en}::uuid, 'content', 0, ${mod[0]?.id}::uuid, ${ci[0]?.id}::uuid, 'unsynced')`;
  });
  const de = await op<{ pageId: string }>("create_variant", {
    sourcePageId: ids.en,
    localeCode: "de",
    slug: `${PFX}-preise`,
  });
  ids.de = de.pageId;
  await sysOp("pages.set_status", { pageId: ids.de, status: "published" });
  await tick();
});

afterAll(async () => {
  await cleanup();
  await restoreBase?.();
  await restoreLang?.();
  await adapter.close();
});

describe("international-site lists — change handling", () => {
  it("added entries are missing and hidden in German until translated; English is untouched", async () => {
    expect(await menu(ids.en)).toEqual(["Pricing", "About", "Status"]);
    expect(await menu(ids.de)).toEqual([]);
    const missing = (await rows("list_value_translations")).filter(
      (r) => r.locale_code === "de" && String(r.address).startsWith(`list/${ids.list}/`),
    );
    expect(missing.map((r) => [r.address, r.status, r.value]).sort()).toEqual(
      [1, 2, 3].map((n) => [labelAddr(n), "missing", null]).sort(),
    );
  });

  it("translate_chrome translates the list texts by address; a link without a German version hides its entry", async () => {
    await op("translate_chrome", { localeCode: "de" });
    // About links a page with no German version: hidden there, a finding.
    expect(await menu(ids.de)).toEqual(["DE:Pricing", "DE:Status"]);
    const status = await op<{ listFindings: { code: string; address: string }[] }>("intl_status");
    expect(status.listFindings).toContainEqual(
      expect.objectContaining({
        code: "list-link-variant-missing",
        address: `list/${ids.list}/item/${E(2)}`,
      }),
    );
    const audit = await op<{ findings: { rule: string; message: string }[] }>("audit_findings", {
      pages: [{ pageId: ids.de, path: "/de/x" }],
    });
    expect(audit.findings.map((f) => f.rule)).toContain("list-link-target-missing");
    // The SKU note is not translated (translate: false): nothing stored for it.
    const all = await rows("list_value_translations");
    expect(all.some((r) => String(r.address).endsWith("/note"))).toBe(false);
  });

  it("the vocabulary's names and slugs are terms, translated together", async () => {
    const terms = (await rows("term_translations")).filter((r) => r.locale_code === "de");
    expect(terms.map((r) => [r.name, r.slug, r.status]).sort()).toEqual([
      ["DE:News", "de-news", "translated"],
      ["DE:Tips", "de-tips", "translated"],
    ]);
  });

  it("a slug already used by another entry in that language is refused", async () => {
    const msg = await opError("apply_translations", {
      items: [
        {
          kind: "addresses",
          localeCode: "de",
          translations: [{ address: `list/${ids.vocab}/item/${E(12)}/slug`, value: "de-news" }],
        },
      ],
    });
    expect(msg).toContain('slug "de-news" is already used');
  });

  it("source changed → needs_update; the old translation stays visible", async () => {
    await patch([{ op: "update", itemId: E(1), values: { label: "Prices" } }]);
    expect(await menu(ids.de)).toEqual(["DE:Pricing", "DE:Status"]);
    await tick();
    const row = (await rows("list_value_translations")).find(
      (r) => r.address === labelAddr(1) && r.locale_code === "de",
    );
    expect(row?.status).toBe("needs_update");
    const st = await op<{
      lists: { target: string; locales: Record<string, Record<string, number>> }[];
    }>("list_translation_status", { listId: ids.list });
    expect(st.lists[0]?.locales.de).toEqual({ translated: 2, needs_update: 1, missing: 0 });
  });

  it("moved → nothing: the translation follows the entry", async () => {
    await patch([{ op: "move", itemId: E(3), position: 0 }]);
    await tick();
    expect(await menu(ids.de)).toEqual(["DE:Status", "DE:Pricing"]);
    const row = (await rows("list_value_translations")).find(
      (r) => r.address === labelAddr(3) && r.locale_code === "de",
    );
    expect(row?.status).toBe("translated");
  });

  it("removed → orphaned and kept; an undo restores it", async () => {
    await patch([{ op: "remove", itemId: E(3) }]);
    await tick();
    const gone = (await rows("list_value_translations")).find(
      (r) => r.address === labelAddr(3) && r.locale_code === "de",
    );
    expect(gone?.status).toBe("orphaned");
    expect(gone?.value).toBe("DE:Status");
    await patch([
      {
        op: "add",
        position: 0,
        item: {
          id: E(3),
          node: "entry",
          values: { label: "Status", link: { href: "https://status.example.org/" } },
        },
      },
    ]);
    await tick();
    const back = (await rows("list_value_translations")).find(
      (r) => r.address === labelAddr(3) && r.locale_code === "de",
    );
    expect(back?.status).toBe("translated");
    expect(back?.orphaned_at).toBeNull();
    expect(await menu(ids.de)).toEqual(["DE:Status", "DE:Pricing"]);
  });

  it("an orphaned translation is garbage-collected only once the removal is live", async () => {
    await patch([{ op: "remove", itemId: E(3) }]);
    await tick();
    expect((await rows("list_value_translations")).some((r) => r.address === labelAddr(3))).toBe(
      true,
    );
    // A production build that started after the removal succeeded.
    await sqlSystem(async (tx) => {
      const t = (await tx`INSERT INTO deploy_targets (name, env, out_dir)
        VALUES (${`${PFX}-prod`}, 'production', '/tmp/t1114i') RETURNING id::text AS id`) as unknown as {
        id: string;
      }[];
      await tx`INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at)
        VALUES (${t[0]?.id}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded', now() + interval '1 second', now() + interval '2 seconds')`;
    });
    // Any live change wakes the worker.
    await patch([{ op: "update", itemId: E(2), values: { label: "About us" } }]);
    await tick();
    expect((await rows("list_value_translations")).some((r) => r.address === labelAddr(3))).toBe(
      false,
    );
  });

  it("translate switched on → missing; off → kept but not applied", async () => {
    await sysOp("list_types.upsert_many", { listTypes: [navType(true)] });
    await tick();
    const note = (await rows("list_value_translations")).find(
      (r) => r.address === `list/${ids.list}/item/${E(1)}/note` && r.locale_code === "de",
    );
    expect(note?.status).toBe("missing");
    // The label is translatable by default; switch it off: the German page
    // shows the stored label, the translation stays stored.
    const off = navType(true);
    const labelField = off.nodes.entry.fields[0] as Record<string, unknown>;
    labelField.ext = { "international-site": { translate: false } };
    await sysOp("list_types.upsert_many", { listTypes: [off] });
    await tick();
    expect(await menu(ids.de)).toEqual(["Prices"]);
    const kept = (await rows("list_value_translations")).find(
      (r) => r.address === labelAddr(1) && r.locale_code === "de",
    );
    expect(kept?.value).toBe("DE:Pricing");
    expect(kept?.status).toBe("needs_update");
    await sysOp("list_types.upsert_many", { listTypes: [navType(false)] });
  });
});

describe("international-site lists — tools", () => {
  it("apply_translations by address writes a dictated wording and refuses unknown addresses", async () => {
    await op("apply_translations", {
      items: [
        {
          kind: "addresses",
          localeCode: "de",
          translations: [{ address: labelAddr(1), value: "Preise" }],
        },
      ],
    });
    expect(await menu(ids.de)).toEqual(["Preise"]);
    const msg = await opError("apply_translations", {
      items: [
        {
          kind: "addresses",
          localeCode: "de",
          translations: [{ address: `list/${ids.list}/item/${E(99)}/label`, value: "x" }],
        },
      ],
    });
    expect(msg).toContain("nothing was written");
  });

  it("set_list_item_visibility hides an entry in one language and shows it again", async () => {
    await op("set_list_item_visibility", {
      items: [{ localeCode: "de", address: `list/${ids.list}/item/${E(1)}`, hidden: true }],
    });
    expect(await menu(ids.de)).toEqual([]);
    expect(await menu(ids.en)).toEqual(["Prices", "About us"]);
    await op("set_list_item_visibility", {
      items: [{ localeCode: "de", address: `list/${ids.list}/item/${E(1)}`, hidden: false }],
    });
    expect(await menu(ids.de)).toEqual(["Preise"]);
    const bad = await opError("set_list_item_visibility", {
      items: [{ localeCode: "en", address: `list/${ids.list}/item/${E(1)}`, hidden: true }],
    });
    expect(bad).toContain("default language");
  });

  it("offers a German version's page properties for translation", async () => {
    // page_types.list returns each definition's fields on the row itself;
    // reading `.definition` found no property and offered nothing.
    const tpl = (await sqlSystem(
      (tx) => tx`SELECT template_id::text AS id FROM pages WHERE id = ${ids.en}::uuid`,
    )) as unknown as { id: string }[];
    const templateId = tpl[0]?.id ?? "";
    await sysOp("page_types.upsert_many", {
      pageTypes: [
        {
          slug: `${PFX}-article`,
          name: "Article",
          purpose: "Test articles with an author line",
          collection: true,
          templates: [templateId],
          defaultTemplate: templateId,
          properties: [{ name: "author", label: "Author", type: "text" }],
          vocabularies: [],
        },
      ],
    });
    await sysOp("pages.update", {
      pageId: ids.en,
      pageType: `${PFX}-article`,
      properties: { author: "Ann" },
    });
    await sysOp("pages.update", { pageId: ids.de, pageType: `${PFX}-article` });
    await tick();
    await op("translate_chrome", { localeCode: "de" });
    const props = (await rows("page_prop_translations")).filter(
      (r) => r.locale_code === "de" && r.page_id === ids.de,
    );
    expect(props.map((r) => r.field)).toEqual(["author"]);
  });

  it("with the plugin not running there are no variants: the stored values render", async () => {
    resetPluginHost();
    expect(await menu(ids.de)).toEqual(["Prices", "About us"]);
  });
});
