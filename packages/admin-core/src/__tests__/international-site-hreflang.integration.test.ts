// SPDX-License-Identifier: MPL-2.0

/**
 * #398 — hreflang + sitemap contributions and the language selector.
 *
 * The plugin contributes through the #391 points (collectContributions
 * is the SINGLE code path the generator's seo-pass AND the preview
 * composer consume — parity between them is structural, the
 * #391 parity suite proves the shared path renders byte-identically).
 * Here we assert the plugin's side of the contract: published-only
 * variants, x-default on the default locale, absolute URLs (host swap
 * for host-strategy locales), silence for sub-threshold groups, and
 * the staticRender selector markup.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  collectContributions,
  resetPluginHost,
  runPluginOperation,
  runPluginStaticRender,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t398",
};
const BASE = "https://example.com";

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
    await tx.unsafe(
      "DELETE FROM redirects WHERE from_path LIKE '/t398-%' OR from_path LIKE '/de/t398-%' OR from_path LIKE '/fr/t398-%'",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't398-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't398-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't398-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
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

async function op<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS_CTX, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function seedPage(slug: string): Promise<string> {
  const templateId = await sqlSystem(async (tx) => {
    const existing = (await tx.unsafe(
      `SELECT id::text AS id FROM templates WHERE slug = 't398-tpl'`,
    )) as { id: string }[];
    if (existing[0]) return existing[0].id;
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t398-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, kind, html, css, layout_id) VALUES ('t398-tpl', 'T', 'content', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    const id = tpl[0]?.id;
    if (!id) throw new Error("seed failed");
    return id;
  });
  const created = await sysOp<{ pageId: string }>("pages.create", {
    slug,
    title: slug,
    templateId,
  });
  return created.pageId;
}

describe("#398 — hreflang + sitemap contributions, language selector", () => {
  it("publishes-only hreflang with x-default and absolute URLs; silent below two published variants; selector markup", async () => {
    const sourceId = await seedPage("t398-pricing");
    const soloId = await seedPage("t398-solo");
    await op("set_locales", {
      locales: [
        { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
        { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
        { code: "fr", displayName: "Français", urlStrategy: "subdirectory", isDefault: false },
      ],
    });
    const de = await op<{ pageId: string }>("create_variant", {
      sourcePageId: sourceId,
      localeCode: "de",
      slug: "t398-preise",
    });
    const fr = await op<{ pageId: string }>("create_variant", {
      sourcePageId: sourceId,
      localeCode: "fr",
      slug: "t398-prix",
    });

    // Only source published → group below threshold → NO contributions.
    await sysOp("pages.set_status", { pageId: sourceId, status: "published" });
    const below = await collectContributions([sourceId, soloId], { siteBaseUrl: BASE });
    expect(below.head.size).toBe(0);
    expect(below.sitemap.size).toBe(0);

    // Publish de; fr stays draft → en + de + x-default, never fr.
    await sysOp("pages.set_status", { pageId: de.pageId, status: "published" });
    const collected = await collectContributions([sourceId, de.pageId, fr.pageId, soloId], {
      siteBaseUrl: BASE,
    });
    const sourceHead = collected.head.get(sourceId);
    expect(sourceHead).toBeDefined();
    const links = (sourceHead ?? []).map((e) =>
      e.kind === "link" ? { hreflang: e.hreflang, href: e.href } : e,
    );
    expect(links).toEqual([
      { hreflang: "en", href: `${BASE}/t398-pricing` },
      { hreflang: "de", href: `${BASE}/de/t398-preise` },
      { hreflang: "x-default", href: `${BASE}/t398-pricing` },
    ]);
    // Both published variants carry the SAME alternate set (self-referential).
    expect(collected.head.get(de.pageId)).toEqual(sourceHead);
    // The draft fr page gets head entries too (harmless — drafts never
    // render publicly) but must never APPEAR as a target.
    for (const entries of collected.head.values()) {
      expect(entries.some((e) => e.kind === "link" && e.hreflang === "fr")).toBe(false);
    }
    expect(collected.head.get(soloId)).toBeUndefined();

    const sitemap = collected.sitemap.get(sourceId);
    expect(sitemap?.exclude).toBeUndefined();
    expect(sitemap?.alternates).toEqual([
      { hreflang: "en", href: `${BASE}/t398-pricing` },
      { hreflang: "de", href: `${BASE}/de/t398-preise` },
      { hreflang: "x-default", href: `${BASE}/t398-pricing` },
    ]);

    // Language selector: build-time HTML, links to both published
    // variants, aria-current on self, display names as labels.
    const html = await runPluginStaticRender({
      pluginSlug: "international-site",
      pageId: de.pageId,
    });
    expect(html).toContain('aria-label="Language"');
    expect(html).toContain(`<a href="${BASE}/t398-pricing" hreflang="en">English</a>`);
    expect(html).toContain(
      `<a href="${BASE}/de/t398-preise" hreflang="de" aria-current="page">Deutsch</a>`,
    );
    expect(html).not.toContain("fr");
    expect(html).not.toContain("<script");
    // Below-threshold page renders nothing at all.
    const solo = await runPluginStaticRender({
      pluginSlug: "international-site",
      pageId: soloId,
    });
    expect(solo).toBe("");

    // Host-strategy locale: absolute URL swaps in the locale's host.
    await op("set_locales", {
      locales: [
        { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
        {
          code: "de",
          displayName: "Deutsch",
          urlStrategy: "subdomain",
          urlHost: "de.example.com",
          isDefault: false,
        },
      ],
    });
    await op("refresh_locales", {});
    const hostCollected = await collectContributions([sourceId], { siteBaseUrl: BASE });
    const hostLinks = (hostCollected.head.get(sourceId) ?? []).map((e) =>
      e.kind === "link" ? e.href : "",
    );
    expect(hostLinks.some((h) => h.startsWith("https://de.example.com/"))).toBe(true);
  }, 60_000);
});
