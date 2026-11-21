// SPDX-License-Identifier: MPL-2.0

/**
 * A real build and the live record (docs/dev/search-engine-feed.md): the
 * build writes /feed.xml, the IndexNow key file, the feed's robots.txt line
 * and link on every page; a page's date moves when the text of its own body
 * changes, never when only the layout around it does; and the sitemap shows
 * the same date as the feed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry, SYSTEM_ACTOR_ID } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type GenerateResult, generateSite } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { applyLiveChanges } from "../search-feed/live-versions.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "search-feed-build-test",
};
const BASE = "https://feed-build.example.org";
const PFX = `sfb-${Date.now().toString(36)}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let saved: {
  site_base_url: string | null;
  site_language: string | null;
  feed_enabled: boolean;
  indexnow_enabled: boolean;
  indexnow_key: string;
};
let pageId = "";
let instanceId = "";
let layoutId = "";
let layoutHtmlBefore = "";
const runs: string[] = [];

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM search_engine_notifications`;
    await tx`DELETE FROM live_page_versions`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
  });
}

/** Build every page (a dev build renders drafts too); `publishAt` dates its changes. */
async function build(publishAt: string): Promise<{ dir: string; result: GenerateResult }> {
  const runId = crypto.randomUUID();
  const root = mkdtempSync(join(tmpdir(), "caelo-search-feed-build-"));
  const result = await adapter.withAdminTransaction(SYSTEM, (tx) =>
    generateSite({
      publishAt,
      tx,
      plugins: localBuildPluginServices,
      target: {
        id: "00000000-0000-0000-0000-0000000000a9",
        name: "dev",
        env: "dev",
        outDir: "out",
        baseUrl: BASE,
        robotsDefault: "index",
      },
      runId,
      repoRoot: root,
    }),
  );
  return { dir: join(root, "out", "builds", runId), result };
}

/** What a Publish live of `result` records (the build is not uploaded anywhere). */
async function publishLive(result: GenerateResult, at: string): Promise<void> {
  const runId = crypto.randomUUID();
  runs.push(runId);
  await asSystem(
    (tx) => tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at)
               SELECT ${runId}::uuid, id, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded', ${at}::timestamptz
               FROM deploy_targets WHERE name = 'production'`,
  );
  await adapter.withAdminTransaction(SYSTEM, (tx) =>
    applyLiveChanges(tx, { runId, feed: result.searchFeed, shippedAt: at }),
  );
}

const pageUrl = () => `${BASE}/${PFX}-a/`;
const mine = (result: GenerateResult) =>
  result.searchFeed.changes.filter((c) => c.pageId === pageId);

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  saved = (
    (await asSystem(
      (tx) => tx`SELECT site_base_url, site_language, feed_enabled, indexnow_enabled, indexnow_key
                 FROM site_defaults WHERE id = 1`,
    )) as (typeof saved)[]
  )[0] as typeof saved;
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${BASE}, site_language = 'en',
           feed_enabled = true, indexnow_enabled = true WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug: `${PFX}-a`, title: `${PFX} A`, templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} Body`,
        description: "Page body text.",
        kind: "content",
        html: '<div class="sfb"><p>{{body_text}}</p></div>',
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: "Prices from 10 EUR" } },
      },
    ],
  });
  if (!page.ok) throw new Error(`build_page: ${JSON.stringify(page.error)}`);
  const [row] = (await asSystem(
    (tx) => tx`SELECT p.id::text AS page_id, pm.content_instance_id::text AS instance_id,
                      t.layout_id::text AS layout_id, l.html AS layout_html
               FROM pages p
               JOIN page_modules pm ON pm.page_id = p.id
               JOIN templates t ON t.id = p.template_id
               JOIN layouts l ON l.id = t.layout_id
               WHERE p.slug = ${`${PFX}-a`}`,
  )) as { page_id: string; instance_id: string; layout_id: string; layout_html: string }[];
  if (!row) throw new Error("seeded page not found");
  pageId = row.page_id;
  instanceId = row.instance_id;
  layoutId = row.layout_id;
  layoutHtmlBefore = row.layout_html;
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`UPDATE layouts SET html = ${layoutHtmlBefore} WHERE id = ${layoutId}::uuid`;
    await tx`UPDATE site_defaults SET site_base_url = ${saved.site_base_url},
               site_language = ${saved.site_language}, feed_enabled = ${saved.feed_enabled},
               indexnow_enabled = ${saved.indexnow_enabled} WHERE id = 1`;
  });
  await wipe();
  await asSystem((tx) => tx`DELETE FROM deploy_runs WHERE id = ANY(${runs}::uuid[])`);
  await adapter.close();
});

describe("a build with the feed and IndexNow on", () => {
  const first = "2026-11-20T08:00:00.000Z";

  it("writes the feed, the key file, the robots.txt line and the link on every page", async () => {
    const { dir, result } = await build(first);
    const xml = await readFile(join(dir, "feed.xml"), "utf8");
    expect(xml).toContain(`<id>${BASE}/feed.xml</id>`);
    expect(xml).toContain("<title>feed-build.example.org</title>");
    expect(xml).toContain('<link rel="hub" href="https://pubsubhubbub.appspot.com/"/>');
    expect(xml).toContain(`<id>urn:uuid:${pageId}</id>`);
    expect(xml).toContain(`href="${pageUrl()}"`);
    expect(await readFile(join(dir, `${saved.indexnow_key}.txt`), "utf8")).toBe(saved.indexnow_key);
    expect(await readFile(join(dir, "robots.txt"), "utf8")).toContain(`Sitemap: ${BASE}/feed.xml`);
    const html = await readFile(join(dir, `${PFX}-a`, "index.html"), "utf8");
    expect(html).toContain(
      `<link rel="alternate" type="application/atom+xml" title="feed-build.example.org" href="${BASE}/feed.xml" />`,
    );
    expect(result.searchFeed.feedUrl).toBe(`${BASE}/feed.xml`);
    expect(result.searchFeed.indexNowKey).toBe(saved.indexnow_key);
    // Never published and the record is empty: a new page, dated by the build.
    expect(mine(result).map((c) => [c.kind, c.url, c.changedAt])).toEqual([
      ["added", pageUrl(), first],
    ]);
    await publishLive(result, first);
  });

  it("a layout change around the page leaves its date alone", async () => {
    await asSystem(
      (tx) => tx`UPDATE layouts SET html = replace(html, '</body>', '<p>Footer 2027</p></body>')
                 WHERE id = ${layoutId}::uuid`,
    );
    const { dir, result } = await build("2026-11-20T09:00:00.000Z");
    expect(await readFile(join(dir, `${PFX}-a`, "index.html"), "utf8")).toContain("Footer 2027");
    expect(mine(result)).toEqual([]);
    const sitemap = await readFile(join(dir, "sitemap.xml"), "utf8");
    expect(sitemap).toContain(`<loc>${pageUrl()}</loc>\n    <lastmod>${first}</lastmod>`);
  });

  it("a text change in the page's own body moves its date in the feed and the sitemap", async () => {
    const edit = await execute(registry, adapter, SYSTEM, "content_instances.set_values", {
      id: instanceId,
      values: { body_text: "Prices from 12 EUR" },
    });
    expect(edit.ok).toBe(true);
    const third = "2026-11-20T10:00:00.000Z";
    const { dir, result } = await build(third);
    expect(mine(result).map((c) => [c.kind, c.prevUrl, c.changedAt])).toEqual([
      ["changed", pageUrl(), third],
    ]);
    const xml = await readFile(join(dir, "feed.xml"), "utf8");
    expect(xml).toContain(`<updated>${third}</updated>`);
    const sitemap = await readFile(join(dir, "sitemap.xml"), "utf8");
    expect(sitemap).toContain(`<loc>${pageUrl()}</loc>\n    <lastmod>${third}</lastmod>`);
  });

  it("with the feed and IndexNow off, writes neither and links nothing", async () => {
    await asSystem(
      (tx) =>
        tx`UPDATE site_defaults SET feed_enabled = false, indexnow_enabled = false WHERE id = 1`,
    );
    const { dir, result } = await build("2026-11-20T11:00:00.000Z");
    expect(existsSync(join(dir, "feed.xml"))).toBe(false);
    expect(existsSync(join(dir, `${saved.indexnow_key}.txt`))).toBe(false);
    expect(await readFile(join(dir, "robots.txt"), "utf8")).not.toContain("feed.xml");
    expect(await readFile(join(dir, `${PFX}-a`, "index.html"), "utf8")).not.toContain(
      "application/atom+xml",
    );
    expect(result.searchFeed.feedUrl).toBeNull();
    expect(result.searchFeed.indexNowKey).toBeNull();
  });
});
