// SPDX-License-Identifier: MPL-2.0

/**
 * #1254 — 20 translation agents at once on a pool of 4 connections.
 *
 * searchVIU production, 2026-10-29: five agents running
 * `international-site.create_variant` filled the admin pool and the log
 * filled with `PoolAcquireTimeoutError`. Each variant took 2–3 connections:
 * `pages.duplicate` held its transaction while composing paths, the URL
 * plugin's annotation op read its storage through ops of their own (the
 * `plugins.render_hook` nested-checkout allowlist entry), and a plugin
 * failure record opened a third. With those calls joining the holder's
 * transaction as savepoints, a variant holds one connection at a time, so
 * 20 at once on `CAELO_DB_POOL_MAX=4` only queue for the pool — no request
 * waits for a connection that its own call chain is holding.
 *
 * searchVIU, 2026-10-30: a Stage running next to the agents failed the
 * same way — the static build's plugin calls (link_resolve → plugin
 * storage) each took admin connections and timed out. A Stage now answers
 * every plugin call of the build on one transaction, so it runs here, at
 * the same time as the 20 variants, on the same pool of 4.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, resetPluginHost, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1254",
};
const AGENTS = 20;
const POOL_MAX = 4;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let repoRoot: string;
let prevSkipServeCheck: string | undefined;
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
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
    await tx.unsafe("DELETE FROM redirects WHERE from_path LIKE '%t1254-%'");
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM deploy_runs");
    await tx.unsafe(
      "DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 't1254-%' OR slug = 'home')",
    );
    await tx.unsafe(
      "DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 't1254-%' OR slug = 'home')",
    );
    await tx.unsafe("UPDATE site_defaults SET home_page_id = NULL WHERE id = 1");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't1254-%' OR slug = 'home'");
    await tx.unsafe("DELETE FROM modules WHERE slug LIKE 't1254-%'");
    await tx.unsafe(
      "DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE 't1254-%')",
    );
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't1254-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't1254-%'");
  });
}

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS_CTX, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A buildable template, and a published home page the Stage builds. */
async function seedSite(): Promise<string> {
  const { templateId } = await ok<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: "t1254-tpl",
    displayName: "T",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { moduleId } = await ok<{ moduleId: string }>("modules.create", {
    slug: "t1254-mod",
    displayName: "M",
    html: '<p>t1254 <a href="/">home</a></p>',
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  const { pageId } = await ok<{ pageId: string }>("pages.create", {
    slug: "home",
    title: "Home",
    templateId,
  });
  await ok("pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
  await ok("pages.update", { pageId, status: "published" });
  await ok("pages_seo.autofill", { pageId, metaDescription: "The t1254 home page." });
  return templateId;
}

beforeAll(async () => {
  // The production failure mode at a quarter of the production pool.
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
    poolMax: POOL_MAX,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL, "https://t1254.example.com");
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  repoRoot = await mkdtemp(join(tmpdir(), "caelo-t1254-"));
  // No staging vhost in this harness — see deploy.trigger's serve check.
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  if (prevSkipServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkipServeCheck;
  await cleanup();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await rm(repoRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1254 — parallel create_variant on a small pool", () => {
  it(`${AGENTS} create_variant calls and a Stage at once complete on a pool of ${POOL_MAX}, with no pool timeout`, async () => {
    const set = await runPluginOperation({
      invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
      pluginSlug: "international-site",
      operationName: "set_locales",
      args: {
        locales: [
          { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
          { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
        ],
      },
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));

    const templateId = await seedSite();
    const sources: string[] = [];
    for (let i = 0; i < AGENTS; i++) {
      const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
        slug: `t1254-source-${i}`,
        title: `Source ${i}`,
        templateId,
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      sources.push((created.value as { pageId: string }).pageId);
    }

    const started = performance.now();
    // The Stage builds the site while the agents write: its plugin calls
    // (the international site answers link_resolve) share the pool with them.
    const stage = execute(registry, adapter, SYS_CTX, "deploy.trigger", {
      targetName: "staging",
      repoRoot,
    });
    const results = await Promise.all(
      sources.map((sourcePageId, i) =>
        runPluginOperation({
          invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
          pluginSlug: "international-site",
          operationName: "create_variant",
          args: { sourcePageId, localeCode: "de", slug: `t1254-variante-${i}`, title: `V ${i}` },
        }),
      ),
    );
    const elapsedMs = Math.round(performance.now() - started);
    console.info(
      `[#1254] ${AGENTS} parallel create_variant on poolMax=${POOL_MAX}: ${elapsedMs} ms`,
    );
    const staged = await stage;
    console.info(
      `[#1254] the concurrent Stage finished after ${Math.round(performance.now() - started)} ms`,
    );
    expect(staged.ok ? null : JSON.stringify(staged.error)).toBeNull();
    expect(existsSync(join(repoRoot, "output", "staging", "current", "index.html"))).toBe(true);

    const failures = results.filter((r) => !r.ok);
    expect(failures.map((f) => (f.ok ? "" : f.error.message))).toEqual([]);
    const paths = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT current_path FROM pages WHERE slug LIKE 't1254-variante-%' ORDER BY current_path`,
        )) as { current_path: string }[],
    );
    expect(paths).toHaveLength(AGENTS);
    for (const p of paths) expect(p.current_path).toMatch(/^\/de\/t1254-variante-\d+$/);
  }, 120_000);
});
