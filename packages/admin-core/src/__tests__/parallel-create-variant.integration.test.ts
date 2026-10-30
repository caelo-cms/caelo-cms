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
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoDefaultPageType } from "./_template-page-type.js";

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
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't1254-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't1254-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't1254-%'");
  });
}

async function seedTemplate(): Promise<string> {
  return sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t1254-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, html, css, layout_id) VALUES ('t1254-tpl', 'T', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    await adoptTemplateIntoDefaultPageType(tx, tpl[0]?.id ?? "");
    const id = tpl[0]?.id;
    if (!id) throw new Error("seed failed");
    return id;
  });
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
  await cleanup();
  await adapter.close();
});

describe("#1254 — parallel create_variant on a small pool", () => {
  it(`${AGENTS} create_variant calls at once complete on a pool of ${POOL_MAX}, with no pool timeout`, async () => {
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

    const templateId = await seedTemplate();
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
