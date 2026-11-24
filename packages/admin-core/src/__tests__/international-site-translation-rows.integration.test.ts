// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1659 — international-site keeps one stored translation per key,
 * end to end against a real Postgres and the real plugin host:
 *
 *   - a chat translates a language version's page property before the
 *     change consumer has given the key its `missing` placeholder; the
 *     placeholder the consumer then writes on the main line takes over the
 *     chat's row instead of adding a second one, the chat's next write of
 *     the key goes through (it used to refuse: "holds two rows … a write
 *     race; delete one and retry", a step no tool can take), and its Stage
 *     leaves one translated row;
 *   - an install whose key already holds a translation AND a placeholder
 *     reads it as translated (it read as missing and rendered the source
 *     text), also through the change consumer's reconcile, and the refused
 *     write goes through and folds the rows.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  drainChangeConsumers,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t1659" };
const MAIN: PluginInvocation = { origin: "system", actorId: HUMAN };
const PFX = "t1659";
const SCHEMA = "plugin_international_site";
/** The AI actor a chat call runs as; the Owner below is the person it acts for. */
const AI_ACTOR_ID = "00000000-0000-0000-0000-000000000a1a";
/** apply_translations needs content.write of the person a chat acts for. */
const OWNER = "00000000-0000-4000-8000-000000001659";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
const ids = { en: "", de: "", template: "" };

/** No AI call happens here: translations come by address. */
const noProvider = {
  resolve: async () => ({ provider: "anthropic", model: "scripted-model" }),
  complete: async () => {
    throw new Error("no AI call expected");
  },
  generateObject: async () => {
    throw new Error("no AI call expected");
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

/** SQL as the plugin: its schema is FORCE RLS-scoped to the plugin's id. */
async function sqlAsPlugin<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  return sqlSystem(async (tx) => {
    await tx`SELECT set_config('caelo.plugin_id', (SELECT id::text FROM plugins WHERE slug = 'international-site'), true)`;
    return fn(tx);
  });
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await tx.unsafe(
      "DELETE FROM plugin_event_cursors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'international-site')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM redirects WHERE from_path LIKE '%${PFX}-%'`);
    await tx.unsafe(`DELETE FROM chat_sessions WHERE title LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM page_types WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx`DELETE FROM user_roles WHERE user_id = ${OWNER}::uuid`;
    await tx`DELETE FROM users WHERE id = ${OWNER}::uuid`;
    await tx`DELETE FROM actors WHERE id = ${OWNER}::uuid`;
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function call(invocation: PluginInvocation, operationName: string, args: unknown = {}) {
  return runPluginOperation({
    invocation,
    pluginSlug: "international-site",
    operationName,
    args,
  });
}

async function op<T>(invocation: PluginInvocation, operationName: string, args: unknown = {}) {
  const r = await call(invocation, operationName, args);
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** What an instance woken by the change journal does: run the consumers to the end. */
async function tick(): Promise<void> {
  const reports = await drainChangeConsumers({ adapter, registry });
  for (const r of reports) if (r.error) throw new Error(`${r.slug}: ${r.error}`);
}

/** A new chat on the site's shared draft, as the AI acting in it. */
async function draftChat(name: string): Promise<{ id: string; invocation: PluginInvocation }> {
  const r = await sysOp<{ chatSessionId: string; chatBranchId: string }>("chat.create_session", {
    title: `${PFX}-${name}`,
  });
  return {
    id: r.chatSessionId,
    invocation: {
      origin: "chat",
      actorId: AI_ACTOR_ID,
      operatorActorId: OWNER,
      chatBranchId: r.chatBranchId,
      chatTaskId: r.chatSessionId,
    },
  };
}

const propAddress = (field: string) => `page/${ids.de}/props/${field}`;

function translate(field: string, value: string) {
  return {
    items: [
      {
        kind: "addresses",
        localeCode: "de",
        translations: [{ address: propAddress(field), value }],
      },
    ],
  };
}

interface PropRow {
  id: string;
  value: string | null;
  status: string;
  branch: string | null;
}

/** The live German rows of one property of the German version, as stored. */
async function propRows(field: string): Promise<PropRow[]> {
  return sqlAsPlugin(
    (tx) =>
      tx`
        SELECT id::text AS id, value, status, caelo_chat_branch_id::text AS branch
        FROM plugin_international_site.page_prop_translations
        WHERE locale_code = 'de' AND page_id = ${ids.de}::uuid AND field = ${field}
          AND caelo_deleted_at IS NULL
        ORDER BY id
      ` as Promise<PropRow[]>,
  );
}

/** The German version's property counts, as `invocation` sees them. */
async function propStatus(invocation: PluginInvocation) {
  const r = await op<{
    lists: { target: string; locales: Record<string, Record<string, number>> }[];
  }>(invocation, "list_translation_status");
  return r.lists.find((t) => t.target === `page:${ids.de}`)?.locales.de;
}

async function stage(chatId: string): Promise<void> {
  await sysOp("chat.merge_draft_to_main", { chatSessionIds: [chatId] });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  const report = await bootstrap({
    infra: { adapter, registry, aiProvider: noProvider, lockPluginRow },
    pluginsRoot: "/dev/null/unused",
    systemActorId: HUMAN,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  await op(MAIN, "set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER}::uuid, 'human', 'Owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER}::uuid, ${`${PFX}-owner@t1659.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER}::uuid, id FROM roles WHERE name = 'owner'`;
    const tpl = (await tx`
      INSERT INTO templates (slug, display_name, html, layout_id)
      VALUES (${`${PFX}-tpl`}, 'T', '<body><caelo-slot name="content">_</caelo-slot></body>',
              (SELECT id FROM layouts WHERE slug = 'site-default'))
      RETURNING id::text AS id`) as unknown as { id: string }[];
    ids.template = tpl[0]?.id ?? "";
    await adoptTemplateIntoHomePageType(tx, ids.template);
    await tx`INSERT INTO template_blocks (template_id, name, display_name, position)
             VALUES (${ids.template}::uuid, 'content', 'Content', 0)`;
    const p = (await tx`
      INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed)
      VALUES (${`${PFX}-guide`}, 'Guide', 'Guide', ${ids.template}::uuid, 'published', true)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    ids.en = p[0]?.id ?? "";
  });
  await sysOp("pages.refresh_current_path", { pageId: ids.en });
  await sysOp("page_types.upsert_many", {
    pageTypes: [
      {
        slug: `${PFX}-guide`,
        name: "Guide",
        purpose: "Test guides with a teaser and a reading time",
        collection: true,
        templates: [ids.template],
        defaultTemplate: ids.template,
        properties: [
          { name: "teaser", label: "Teaser", type: "text" },
          { name: "reading", label: "Reading time", type: "text" },
          { name: "level", label: "Level", type: "text" },
        ],
        vocabularies: [],
      },
    ],
  });
  await sysOp("pages.update", {
    pageId: ids.en,
    pageType: `${PFX}-guide`,
    properties: { teaser: "Three more domains" },
  });
  const de = await op<{ pageId: string }>(MAIN, "create_variant", {
    sourcePageId: ids.en,
    localeCode: "de",
    slug: `${PFX}-leitfaden`,
  });
  ids.de = de.pageId;
  await sysOp("pages.set_status", { pageId: ids.de, status: "published" });
  await sysOp("pages.update", { pageId: ids.de, pageType: `${PFX}-guide` });
  await tick();
});

afterAll(async () => {
  await cleanup();
  await restoreBase?.();
  await restoreLang?.();
  await adapter.close();
});

describe("international-site — one stored translation per key (#1659)", () => {
  it("a chat's translation and the change consumer's placeholder leave one row at the Stage", async () => {
    // A property the source gains on the main line; the consumer has not run yet.
    await sysOp("pages.update", {
      pageId: ids.en,
      properties: { teaser: "Three more domains", reading: "5 min" },
    });
    expect(await propRows("reading")).toEqual([]);

    const chat = await draftChat("prop");
    await op(chat.invocation, "apply_translations", translate("reading", "5 Min."));
    const [mine] = await propRows("reading");
    expect(mine?.branch).not.toBeNull();

    // The consumer reconciles on the main line, where the chat's row is
    // invisible: its placeholder sits beside it until the Stage. The chat
    // reads the translation (translation-rows.ts).
    await tick();
    const placeholder = (await propRows("reading")).find((r) => r.branch === null);
    expect(placeholder).toMatchObject({ value: null, status: "missing" });
    expect(await propStatus(chat.invocation)).toMatchObject({ translated: 1, missing: 1 });

    // The Stage lands the chat's row on the placeholder.
    await stage(chat.id);
    expect(await propRows("reading")).toEqual([
      { id: placeholder?.id as string, value: "5 Min.", status: "translated", branch: null },
    ]);
    expect(await propStatus(MAIN)).toMatchObject({ translated: 1, missing: 1 });
  });

  it("the chat's next write of such a key goes through and its Stage leaves one row", async () => {
    await sysOp("pages.update", {
      pageId: ids.en,
      properties: { teaser: "Three more domains", reading: "5 min", level: "Beginner" },
    });
    const chat = await draftChat("prop-again");
    await op(chat.invocation, "apply_translations", translate("level", "Einsteiger"));
    await tick();
    expect(await propRows("level")).toHaveLength(2);

    // The write that refused here before ("holds two rows … a write race").
    await op(chat.invocation, "apply_translations", translate("level", "Anfänger"));
    await stage(chat.id);
    expect(
      (await propRows("level")).map((r) => ({
        value: r.value,
        status: r.status,
        branch: r.branch,
      })),
    ).toEqual([{ value: "Anfänger", status: "translated", branch: null }]);
  });

  it("a key that already holds a translation and a placeholder reads as translated and folds", async () => {
    const [translated] = await propRows("reading");
    expect(translated?.status).toBe("translated");
    // What two writers left before #1659: a placeholder beside the
    // translation, its id sorting last (the row the old reads took).
    const placeholderId = "ffffffff-ffff-4fff-8fff-fffffffff659";
    await sqlAsPlugin(
      (tx) => tx`
        INSERT INTO plugin_international_site.page_prop_translations
          (id, locale_code, page_id, field, value, source_hash, status, orphaned_at)
        VALUES (${placeholderId}::uuid, 'de', ${ids.de}::uuid, 'reading', NULL, NULL, 'missing', NULL)
      `,
    );
    expect(await propRows("reading")).toHaveLength(2);
    expect(await propStatus(MAIN)).toMatchObject({ translated: 2, missing: 1 });
    // The consumer's reconcile reads them the same way: nothing to insert.
    const rebuilt = await op<{ lists: { inserted: number } }>(
      MAIN,
      "rebuild_translation_staleness",
    );
    expect(rebuilt.lists.inserted).toBe(0);
    expect(await propStatus(MAIN)).toMatchObject({ translated: 2, missing: 1 });

    // A chat's write of the key goes through and leaves one row.
    const chat = await draftChat("heal");
    await op(chat.invocation, "apply_translations", translate("reading", "fünf Minuten"));
    await stage(chat.id);
    expect(await propRows("reading")).toEqual([
      { id: translated?.id as string, value: "fünf Minuten", status: "translated", branch: null },
    ]);
  });
});
