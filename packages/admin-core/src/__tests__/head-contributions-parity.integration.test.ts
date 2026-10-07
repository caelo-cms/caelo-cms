// SPDX-License-Identifier: MPL-2.0

/**
 * #391 — the parity guarantee, end to end: the admin preview and the
 * static generator's seo-pass compose plugin head contributions through
 * the SAME code path (collectContributions + composeHeadBlock), so the
 * contributed block in the preview HTML is byte-identical to what the
 * generator injects — and the sitemap carries contributed alternates
 * and honours exclusions. The document language (`<html lang>`) rides
 * the same contributions: a plugin-contributed per-page language wins,
 * every other page carries the stored site language — on both surfaces.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, renderHeadEntries, resetPluginHost } from "@caelo-cms/plugin-host";
import { definePlugin, type HeadEntry } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { runSeoPass } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t391p",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let plainPageId = "";
let buildDir = "";
let siteLanguageBefore = "";
/** Stored site language for the run; distinct from the seeded `en` so
 *  a hard-coded default could not pass the assertions. */
const SITE_LANGUAGE = "fr";
/** What the test plugin contributes for `pageId` only. */
const CONTRIBUTED_LANGUAGE = "de-AT";

const ENTRIES: HeadEntry[] = [
  { kind: "link", rel: "alternate", hreflang: "de", href: "https://example.com/de/t391p-page" },
  { kind: "link", rel: "alternate", hreflang: "x-default", href: "https://example.com/t391p-page" },
];

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
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't391p-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't391p-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't391p-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't391p-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't391p-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't391p-%'");
  });
}

let restoreSiteBaseUrl: (() => Promise<void>) | null = null;

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  buildDir = mkdtempSync(join(tmpdir(), "t391p-build-"));

  // Site base URL + page through the real ops (default layout resolves
  // from the seeded site_defaults).
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  const tpl = await execute(registry, adapter, SYS_CTX, "templates.create", {
    slug: "t391p-tpl",
    displayName: "T391P",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYS_CTX, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: "t391p-page",
    title: "Parity",
    templateId,
  });
  if (!created.ok) throw new Error(`page seed failed: ${JSON.stringify(created.error)}`);
  pageId = (created.value as { pageId: string }).pageId;
  const pub = await execute(registry, adapter, SYS_CTX, "pages.set_status", {
    pageId,
    status: "published",
  });
  if (!pub.ok) throw new Error("publish failed");
  const plain = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: "t391p-plain",
    title: "Plain",
    templateId,
  });
  if (!plain.ok) throw new Error(`page seed failed: ${JSON.stringify(plain.error)}`);
  plainPageId = (plain.value as { pageId: string }).pageId;
  const pubPlain = await execute(registry, adapter, SYS_CTX, "pages.set_status", {
    pageId: plainPageId,
    status: "published",
  });
  if (!pubPlain.ok) throw new Error("publish failed");

  const defaults = await execute(registry, adapter, SYS_CTX, "site_defaults.get", {});
  if (!defaults.ok) throw new Error(JSON.stringify(defaults.error));
  siteLanguageBefore = (defaults.value as { defaults: { siteLanguage: string } }).defaults
    .siteLanguage;
  const setLang = await execute(registry, adapter, SYS_CTX, "site_defaults.set_identity", {
    siteLanguage: SITE_LANGUAGE,
  });
  if (!setLang.ok) throw new Error(JSON.stringify(setLang.error));

  const contributorDef = definePlugin({
    slug: "t391p-intl",
    version: "0.1.0",
    tier: 1,
    schema: {},
    requestedCapabilities: ["head_contributions"],
    contributes: ["head", "sitemap"],
    contributionsOperation: "contribute",
    operations: {
      contribute: async (_ctx, args) => {
        const { pageIds } = args as { pageIds: string[] };
        const head: Record<string, HeadEntry[]> = {};
        const sitemap: Record<string, unknown> = {};
        const lang: Record<string, string> = {};
        for (const id of pageIds) {
          if (id !== pageId) continue;
          head[id] = ENTRIES;
          lang[id] = CONTRIBUTED_LANGUAGE;
          sitemap[id] = {
            alternates: [
              { hreflang: "de", href: "https://example.com/de/t391p-page" },
              { hreflang: "x-default", href: "https://example.com/t391p-page" },
            ],
          };
        }
        return { head, sitemap, lang };
      },
    },
  });
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: contributorDef }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  if (siteLanguageBefore) {
    await execute(registry, adapter, SYS_CTX, "site_defaults.set_identity", {
      siteLanguage: siteLanguageBefore,
    });
  }
  await cleanup();
  await restoreSiteBaseUrl?.();
  rmSync(buildDir, { recursive: true, force: true });
  await adapter.close();
});

describe("#391 — generator/preview parity + sitemap contributions", () => {
  it("preview head contains exactly the serialized contributed block", async () => {
    const composed = await execute(registry, adapter, SYS_CTX, "pages.render_preview", {
      pageId,
    });
    if (!composed.ok) throw new Error(JSON.stringify(composed.error));
    const html = (composed.value as { html: string }).html;
    const expectedBlock = renderHeadEntries(ENTRIES);
    expect(html).toContain(expectedBlock);
  });

  it("preview <html lang>: contributed per-page language wins, else the stored site language", async () => {
    const contributed = await execute(registry, adapter, SYS_CTX, "pages.render_preview", {
      pageId,
    });
    if (!contributed.ok) throw new Error(JSON.stringify(contributed.error));
    const contributedHtml = (contributed.value as { html: string }).html;
    expect(contributedHtml).toContain(`<html lang="${CONTRIBUTED_LANGUAGE}"`);
    expect(contributedHtml.match(/<html\b/gi)?.length).toBe(1);

    const plain = await execute(registry, adapter, SYS_CTX, "pages.render_preview", {
      pageId: plainPageId,
    });
    if (!plain.ok) throw new Error(JSON.stringify(plain.error));
    expect((plain.value as { html: string }).html).toContain(`<html lang="${SITE_LANGUAGE}"`);
  });

  it("seo-pass injects the SAME block and the sitemap carries alternates", async () => {
    const page = {
      pageSlug: "t391p-page",
      html: "<html><head><title>x</title></head><body>b</body></html>",
    };
    // A layout-authored lang is replaced by the resolved one.
    const plainPage = {
      pageSlug: "t391p-plain",
      html: '<!doctype html><html lang="xx"><head><title>x</title></head><body>b</body></html>',
    };
    await adapter.withAdminTransaction(SYS_CTX, async (tx) => {
      await runSeoPass({
        tx,
        buildDir,
        pages: [page, plainPage],
        settings: {
          siteBaseUrl: "https://example.com",
          sitemapEnabled: true,
          siteLanguage: SITE_LANGUAGE,
          organization: {},
        },
        envIsNoindex: false,
      });
    });
    const expectedBlock = renderHeadEntries(ENTRIES);
    expect(page.html).toContain(expectedBlock);
    expect(page.html).toStartWith(`<html lang="${CONTRIBUTED_LANGUAGE}">`);
    expect(plainPage.html).toStartWith(`<!doctype html><html lang="${SITE_LANGUAGE}">`);

    const sitemap = readFileSync(join(buildDir, "sitemap.xml"), "utf8");
    expect(sitemap).toContain(
      '<xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/t391p-page" />',
    );
    expect(sitemap).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
  });
});
