// SPDX-License-Identifier: MPL-2.0

/**
 * #605 — plugin output reaches the PUBLISHED site.
 *
 * Runs the real deploy path: `deploy.trigger` spawns the static generator
 * subprocess (apps/static-generator/src/cli.ts). The plugin host lives in
 * this process (the admin's role); the subprocess asks it for every
 * plugin answer over its stdio. Before #605 the subprocess consulted its
 * own empty plugin registries, so published pages had no hreflang, no
 * language switcher, raw `{{#consent_categories}}` markers, no consent
 * runtime and un-withheld embeds — while the editor preview (in-process)
 * showed all of it.
 *
 * With international-site and consent-manager active, the production
 * build must carry: hreflang + x-default and the per-language document
 * language (head contributions), the language switcher (data list AND
 * staticRender), the consent categories (data list), the consent runtime
 * (client assets) and the withheld YouTube embed (module deferral). And a
 * build that would still ship a raw plugin data-list marker fails loudly.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import {
  bootstrap,
  deregisterPlugin,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { openQualityGate } from "./fixtures/quality-gate.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t605" };
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t605" };
const BASE = "https://example.com";
const PFX = "t605-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot = "";
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let prevEnv: Record<string, string | undefined> = {};
let homeId = "";
let aboutId = "";
let homeDeId = "";
let aboutDeId = "";
let styleBefore: string | null = null;
let homeBefore: string | null = null;

async function sqlSystem<T>(
  fn: (tx: Bun.SQL) => Promise<T>,
  url = ADMIN_URL as string,
): Promise<T> {
  const sql = new SQL(url);
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
  const pluginActors = (slug: string) =>
    `SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${slug}')`;
  const ourModules = `SELECT id FROM modules WHERE slug LIKE '${PFX}%' OR slug = 'consent-placeholder'`;
  await sqlSystem(async (tx) => {
    // Site data first: plugin actors wrote some of it (variants, redirects).
    await tx.unsafe("DELETE FROM quality_audit_runs");
    await tx.unsafe("DELETE FROM deploy_runs");
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}%'`);
    await tx.unsafe(`DELETE FROM content_instance_snapshots WHERE content_instance_id IN (
      SELECT id FROM content_instances WHERE module_id IN (${ourModules}))`);
    await tx.unsafe(`DELETE FROM content_instances WHERE module_id IN (${ourModules})`);
    await tx.unsafe(`DELETE FROM module_snapshots WHERE module_id IN (${ourModules})`);
    await tx.unsafe(`DELETE FROM modules WHERE id IN (${ourModules})`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}%'`);
    for (const slug of ["international-site", "consent-manager"]) {
      await tx.unsafe(`DROP SCHEMA IF EXISTS "plugin_${slug.replace("-", "_")}" CASCADE`);
      await tx.unsafe(
        `DELETE FROM static_bakes WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${slug}')`,
      );
      await tx.unsafe(`DELETE FROM redirects WHERE created_by IN (${pluginActors(slug)})`);
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (${pluginActors(slug)})`);
      await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (${pluginActors(slug)})`);
      await tx.unsafe(`DELETE FROM actors WHERE id IN (${pluginActors(slug)})`);
      await tx.unsafe(`DELETE FROM plugins WHERE slug = '${slug}'`);
    }
    await tx.unsafe(`DELETE FROM user_roles WHERE user_id = '${OWNER_ID}'::uuid`);
    await tx.unsafe(`DELETE FROM users WHERE id = '${OWNER_ID}'::uuid`);
  });
  await sqlSystem(async (tx) => {
    for (const slug of ["international_site", "consent_manager"]) {
      await tx.unsafe(`DROP SCHEMA IF EXISTS "plugin_${slug}" CASCADE`);
    }
  }, PUBLIC_URL as string);
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function pluginOp<T>(pluginSlug: string, operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug,
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function module(slug: string, html: string, fields: unknown[] = []): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug,
      displayName: slug,
      html,
      css: "",
      js: "",
      fields,
    })
  ).moduleId;
}

/** The language-switcher placeholder staticRender fills, one per page. */
const switcherPlaceholder = (pageId: string) =>
  `<div data-caelo-plugin="international-site" data-page-id="${pageId}"><!-- loads here --></div>`;

function published(rel: string): string {
  const file = join(testRoot, "output", "production", "current", rel);
  if (!existsSync(file)) throw new Error(`not published: ${rel}`);
  return readFileSync(file, "utf8");
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await cleanup();
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t605-"));
  prevEnv = {
    CAELO_OUTPUT_ROOT: process.env.CAELO_OUTPUT_ROOT,
    CAELO_SKIP_STAGING_SERVE_CHECK: process.env.CAELO_SKIP_STAGING_SERVE_CHECK,
  };
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, BASE);
  restoreLanguage = await pinSiteLanguage(ADMIN_URL as string, "en");
  await sqlSystem(async (tx) => {
    const rows =
      (await tx`SELECT page_url_style FROM deploy_targets WHERE name = 'production'`) as {
        page_url_style: string;
      }[];
    styleBefore = rows[0]?.page_url_style ?? null;
    await tx`UPDATE deploy_targets SET page_url_style = 'directory' WHERE name IN ('production', 'staging')`;
    const home = (await tx`SELECT home_page_id::text AS id FROM site_defaults WHERE id = 1`) as {
      id: string | null;
    }[];
    homeBefore = home[0]?.id ?? null;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't605 owner')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'x')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });

  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }, { definition: consentPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    slug: `${PFX}tpl`,
    displayName: "T605",
    html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  // The placeholder consent-manager renders a withheld module with.
  await module(
    "consent-placeholder",
    '<div class="cp"><p>{{notice}}</p><button data-consent-open>Choose</button></div>',
    [
      {
        name: "notice",
        kind: "text",
        label: "Notice",
        default: "This content needs your consent.",
      },
    ],
  );
  const switcherList = await module(
    `${PFX}langs`,
    '<ul class="t605-langs">{{#language_links}}<li><a href="{{href}}" hreflang="{{locale}}">{{label}}</a></li>{{/language_links}}</ul>',
  );
  const banner = await module(
    `${PFX}banner`,
    '<div data-consent-banner>{{#consent_categories}}<label><input type="checkbox" data-consent-category="{{key}}"> {{label}}</label>{{/consent_categories}}<button data-consent-accept-all>Accept</button><button data-consent-reject-all>Reject</button></div>',
  );
  const video = await module(
    `${PFX}video`,
    '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
  );

  homeId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}home`,
      title: "Home",
      templateId,
    })
  ).pageId;
  await op(SYS, "pages.set_home_page", { pageId: homeId });
  aboutId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}about`,
      title: "About",
      templateId,
    })
  ).pageId;
  for (const pageId of [homeId, aboutId]) {
    const placeholder = await module(
      `${PFX}switch-${pageId.slice(0, 8)}`,
      switcherPlaceholder(pageId),
    );
    await op(SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [switcherList, placeholder, banner, video] }],
    });
  }

  await pluginOp("international-site", "set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
  homeDeId = (
    await pluginOp<{ pageId: string }>("international-site", "create_variant", {
      sourcePageId: homeId,
      localeCode: "de",
    })
  ).pageId;
  aboutDeId = (
    await pluginOp<{ pageId: string }>("international-site", "create_variant", {
      sourcePageId: aboutId,
      localeCode: "de",
      slug: `${PFX}ueber-uns`,
    })
  ).pageId;
  for (const pageId of [homeId, aboutId, homeDeId, aboutDeId]) {
    await op(SYS, "pages.set_status", { pageId, status: "published" });
  }
  // consent-manager judges embeds at render time; its scan records them.
  await pluginOp("consent-manager", "scan_modules", {});

  // The real deploy path: a staged build, its (fixture) quality check,
  // then a production build — both through the generator subprocess.
  await op(OWNER, "deploy.trigger", { targetName: "staging", repoRoot: testRoot });
  await openQualityGate(adapter);
  await op(OWNER, "deploy.trigger", { targetName: "production", repoRoot: testRoot });
}, 300_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await sqlSystem(async (tx) => {
    if (styleBefore) {
      await tx`UPDATE deploy_targets SET page_url_style = ${styleBefore} WHERE name IN ('production', 'staging')`;
    }
    await tx`UPDATE site_defaults SET home_page_id = ${homeBefore} WHERE id = 1`;
  });
  await cleanup();
  await restoreBase?.();
  await restoreLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#605 — the published site carries every plugin's output", () => {
  it("hreflang alternates, x-default and the page language (head contributions)", () => {
    const de = published(`de/${PFX}ueber-uns/index.html`);
    expect(de).toContain(`<link rel="alternate" hreflang="en" href="${BASE}/${PFX}about/"`);
    expect(de).toContain(`<link rel="alternate" hreflang="de" href="${BASE}/de/${PFX}ueber-uns/"`);
    expect(de).toContain(`<link rel="alternate" hreflang="x-default" href="${BASE}/${PFX}about/"`);
    expect(de).toMatch(/<html[^>]* lang="de"/);
    const home = published("index.html");
    expect(home).toContain(`<link rel="alternate" hreflang="de" href="${BASE}/de/"`);
    const sitemap = published("sitemap.xml");
    expect(sitemap).toContain(`hreflang="de"`);
  });

  it("the language switcher: the data list and the staticRender placeholder", () => {
    const about = published(`${PFX}about/index.html`);
    expect(about).toContain(`<a href="${BASE}/de/${PFX}ueber-uns/" hreflang="de">Deutsch</a>`);
    expect(about).toContain('<nav class="caelo-language-selector" aria-label="Language">');
    expect(about).toContain(`href="${BASE}/de/${PFX}ueber-uns/" hreflang="de"`);
  });

  it("the consent banner's categories, runtime and withheld embed", () => {
    const home = published("index.html");
    expect(home).toContain('data-consent-category="necessary"');
    expect(home).toContain('data-consent-category="marketing"');
    const runtime = /<script[^>]+src="(\/_caelo\/plugin\/consent-manager\/[^"]+\.js)"/.exec(home);
    expect(runtime?.[1]).toBeDefined();
    const runtimeFile = published((runtime?.[1] ?? "").replace(/^\//, ""));
    expect(runtimeFile).toContain("/api/plugin/consent-manager/record_consent");
    expect(home).toMatch(/<link[^>]+href="\/_caelo\/plugin\/consent-manager\/[^"]+\.css"/);
    expect(home).toContain('data-caelo-deferred="consent-manager"');
    expect(home.indexOf("youtube.com/embed")).toBeGreaterThan(
      home.indexOf("<template data-caelo-deferred-content>"),
    );
  });

  it("no raw plugin data-list marker survives on any published page", () => {
    for (const rel of [
      "index.html",
      `${PFX}about/index.html`,
      "de/index.html",
      `de/${PFX}ueber-uns/index.html`,
    ]) {
      expect(published(rel)).not.toMatch(/\{\{[#^/]\s*(language_links|consent_categories)/);
    }
  });

  it("a build that would ship a switched-off plugin's markers fails loudly", async () => {
    // The Owner switches consent-manager off: its list stays declared
    // (the banner module still iterates it) but nothing answers it.
    deregisterPlugin("consent-manager");
    const r = await execute(registry, adapter, OWNER, "deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("raw plugin data-list markers");
    expect(JSON.stringify(r)).toContain("consent_categories");
  });
});
