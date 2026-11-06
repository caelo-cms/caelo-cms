// SPDX-License-Identifier: MPL-2.0

/**
 * #1323 — a consent banner in the page language. consent-manager and
 * international-site know nothing of each other; this runs both for real
 * (real Postgres, real plugin host, a scripted translator): the category
 * texts reach `translate_chrome`, the banner on the other language's page
 * reads the translation, the choice underneath stays the same, and a text
 * that changed in the source language stops showing its old translation.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import {
  bootstrap,
  localBuildPluginServices,
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
  requestId: "t1323",
};
const PFX = "t1323";
const NECESSARY_LABEL = "source/consent_categories/item/necessary/label";
const NECESSARY_TEXT = "source/consent_categories/item/necessary/description";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
const ids = { de: "", en: "" };
/** The prompts the translator saw. */
const prompts: string[] = [];

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
    system?: string;
    messages: ReadonlyArray<{ content: string }>;
    jsonSchema: Record<string, unknown>;
  }) => {
    const user = opts.messages[0]?.content ?? "";
    prompts.push(`${opts.system ?? ""}\n${user}`);
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
        strings[path] = `EN:${source.get(`${id}|${path}`) ?? ""}`;
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
    // Last: the plugins' actors own the content rows above.
    for (const slug of ["international-site", "consent-manager"]) {
      await tx.unsafe(`DROP SCHEMA IF EXISTS "plugin_${slug.replace("-", "_")}" CASCADE`);
      await tx`DELETE FROM plugin_event_cursors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
      await tx`DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug}))`;
      await tx`DELETE FROM site_snapshots WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug}))`;
      await tx`DELETE FROM redirects WHERE created_by IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
      await tx`DELETE FROM plugins WHERE slug = ${slug}`;
    }
  });
  const pub = new SQL(PUBLIC_URL as string);
  try {
    await pub.unsafe('DROP SCHEMA IF EXISTS "plugin_consent_manager" CASCADE');
    await pub.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
  } finally {
    await pub.end();
  }
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function plugin<T>(slug: string, operationName: string, args: unknown = {}): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: slug,
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** What the page's banner shows: `<key>|<label>|<description>` per category. */
async function banner(pageId: string): Promise<string[]> {
  const r = await sysOp<{ html: string }>("pages.render_preview", { pageId });
  return [...r.html.matchAll(/data-t1323="([^"]*)"/g)].map((m) => m[1] ?? "");
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "de");
  const report = await bootstrap({
    infra: { adapter, registry, aiProvider: scriptedProvider },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }, { definition: consentPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  await plugin("international-site", "set_locales", {
    locales: [
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: true },
      { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
  await plugin("consent-manager", "describe_categories", {
    categories: [
      { key: "necessary", displayName: "Notwendig", description: "Hält die Seite am Laufen." },
    ],
  });

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
    const page = (await tx`
      INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed)
      VALUES (${`${PFX}-start`}, 'Start', 'Start', ${templateId}::uuid, 'published', true)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    ids.de = page[0]?.id ?? "";
    const mod = (await tx`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (${`${PFX}-banner`}, 'Banner', ${`${PFX}-banner`},
              '<div data-consent-banner>{{#consent_categories}}<label data-t1323="{{key}}|{{label}}|{{description}}"><input type="checkbox" data-consent-category="{{key}}"></label>{{/consent_categories}}</div>',
              '[]'::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${mod[0]?.id}::uuid, '{}'::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
             VALUES (${ids.de}::uuid, 'content', 0, ${mod[0]?.id}::uuid, ${ci[0]?.id}::uuid, 'unsynced')`;
  });
  await sysOp("pages.refresh_current_path", { pageId: ids.de });
  const en = await plugin<{ pageId: string }>("international-site", "create_variant", {
    sourcePageId: ids.de,
    localeCode: "en",
    slug: `${PFX}-home`,
  });
  ids.en = en.pageId;
  await sysOp("pages.set_status", { pageId: ids.en, status: "published" });
});

afterAll(async () => {
  await cleanup();
  await restoreBase?.();
  await restoreLang?.();
  await adapter.close();
});

describe("#1323 consent categories in the page language", () => {
  it("before a translation the source text shows and the category stays on the banner", async () => {
    expect(await banner(ids.en)).toEqual(["necessary|Notwendig|Hält die Seite am Laufen."]);
    const status = await plugin<{ listFindings: { message: string }[] }>(
      "international-site",
      "intl_status",
    );
    expect(JSON.stringify(status.listFindings)).toContain("Consent categories");
  });

  it("translate_chrome offers the texts as exact-meaning targets; the banner reads them", async () => {
    await plugin("international-site", "translate_chrome", { localeCode: "en" });
    const prompt = prompts.at(-1) ?? "";
    expect(prompt).toContain(NECESSARY_LABEL);
    expect(prompt).toContain(NECESSARY_TEXT);
    expect(prompt).toContain("(exact meaning)");
    expect(prompt).toContain("Do not soften");
    // The wording changed, the key the choice is stored under did not.
    expect(await banner(ids.en)).toEqual(["necessary|EN:Notwendig|EN:Hält die Seite am Laufen."]);
    expect(await banner(ids.de)).toEqual(["necessary|Notwendig|Hält die Seite am Laufen."]);
    // A build asks the same way the preview does.
    const built = await localBuildPluginServices.resolveListSources([ids.en, ids.de], {
      siteBaseUrl: "https://example.com",
      pageUrlStyle: "directory",
    });
    expect(built.get(ids.en)?.consent_categories?.[0]?.values.label).toBe("EN:Notwendig");
    expect(built.get(ids.de)?.consent_categories?.[0]?.values.label).toBe("Notwendig");
  });

  it("a source text changed: its old translation stops showing until it is redone", async () => {
    await plugin("consent-manager", "describe_categories", {
      categories: [{ key: "necessary", description: "Sichert die Seite und merkt sich die Wahl." }],
    });
    expect(await banner(ids.en)).toEqual([
      "necessary|EN:Notwendig|Sichert die Seite und merkt sich die Wahl.",
    ]);
    await plugin("international-site", "translate_chrome", { localeCode: "en" });
    expect(await banner(ids.en)).toEqual([
      "necessary|EN:Notwendig|EN:Sichert die Seite und merkt sich die Wahl.",
    ]);
  });

  it("an empty translation of a text a visitor decides on is refused", async () => {
    const r = await runPluginOperation({
      invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
      pluginSlug: "international-site",
      operationName: "apply_translations",
      args: {
        items: [
          {
            kind: "addresses",
            localeCode: "en",
            translations: [{ address: NECESSARY_TEXT, value: "  " }],
          },
        ],
      },
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("cannot be left empty");
  });
});
