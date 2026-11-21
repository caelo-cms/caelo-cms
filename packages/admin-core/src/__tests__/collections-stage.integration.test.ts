// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R1 #1647, R2 #1648) — page output and collections through a
 * real Stage and Publish live (self-hosted publisher, the generator, the
 * plugin host, the in-process collection_index job, real Postgres):
 *
 * - the first Stage delivers every page's facts to the observer, which
 *   writes documents; the index job builds the release in the staging
 *   store, and Publish live copies its files to the live store and
 *   publishes the release key into cms_public;
 * - a second Stage after one page changed delivers that page only, and the
 *   job writes a delta release that finds the new text;
 * - a page taken offline reaches the observer as removed, and the index
 *   drops it;
 * - an observer that fails marks the Stage's index failed, and Publish live
 *   refuses it with the reason;
 * - an observer cannot write a public table (visitors would see staged work).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directoryStore,
  FileCache,
  openRelease,
  parseRelease,
  scopedStore,
  searchText,
} from "@caelo-cms/collection-index";
import {
  bootstrap,
  resetCollectionStores,
  resetPluginHost,
  resetPluginHostSync,
  syncPluginHost,
} from "@caelo-cms/plugin-host";
import {
  definePlugin,
  type PageOutputObserverArgs,
  type PluginCollections,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { drainProjectionOnce, stagingPublicAdapter } from "../public-projection.js";
import { registerAdminOps } from "../register.js";
import { inProcessJobLauncher } from "../reporting-jobs/in-process.js";
import { setInProcessJobLauncher } from "../reporting-jobs/launcher.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const HUMAN: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "human",
  requestId: "t1644-stage",
};
const PLUGIN = "t1644-search";
const TPL = "t1644-tpl";
const MOD = "t1644-mod";
const PAGES = ["t1644-preise", "t1644-blog"];
/** The site root: a build refuses a site without one. */
const HOME = "home";

let adapter: DatabaseAdapter;
let stagingAdapter: DatabaseAdapter;
let registry: OperationRegistry;
let root = "";

let writePublic = false;
/** The plugin sets its profile when it changes: here, once. */
let profileSet = false;
const calls: PageOutputObserverArgs[] = [];
const pageIds = new Map<string, string>();
const instances = new Map<string, string>();
const restore: (() => Promise<void>)[] = [];
const envBefore: Record<string, string | undefined> = {};

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

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, HUMAN, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function wipe(): Promise<void> {
  resetPluginHost();
  resetPluginHostSync();
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM collection_changes`;
    await tx`DELETE FROM collection_releases`;
    await tx`DELETE FROM plugin_page_observations`;
    await tx`DELETE FROM plugin_module_counts`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM reporting_jobs WHERE kind = 'collection_index'`;
    await tx`DELETE FROM deploy_runs`;
    for (const slug of [...PAGES, HOME]) {
      await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})`;
      await tx`DELETE FROM pages WHERE slug = ${slug}`;
    }
    await tx`DELETE FROM modules WHERE slug = ${MOD}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN})`;
    await tx`DELETE FROM plugins WHERE slug = ${PLUGIN}`;
  });
}

async function markAudited(runId: string): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
             VALUES (${runId}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'passed', '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
  });
}

async function setText(slug: string, text: string): Promise<void> {
  await ok("content_instances.set_values", { id: instances.get(slug), values: { body: text } });
}

async function seed(): Promise<void> {
  const { templateId } = await ok<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: TPL,
    displayName: "T",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { moduleId } = await ok<{ moduleId: string }>("modules.create", {
    slug: MOD,
    displayName: "Text",
    html: `<section id="text"><h2>Abschnitt</h2><p>{{body}}</p></section>`,
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  for (const slug of [...PAGES, HOME]) {
    const title = slug === PAGES[0] ? "Preise" : slug === PAGES[1] ? "Blog" : "Start";
    const { pageId } = await ok<{ pageId: string }>("pages.create", { slug, title, templateId });
    pageIds.set(slug, pageId);
    await ok("pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    const placed = await sqlSystem(
      async (tx) =>
        (await tx`SELECT content_instance_id::text AS id FROM page_modules WHERE page_id = ${pageId}::uuid`) as {
          id: string;
        }[],
    );
    instances.set(slug, placed[0]?.id as string);
    await ok("pages.update", { pageId, status: "published" });
    await ok("pages_seo.autofill", { pageId, metaDescription: `About ${slug}.` });
  }
  await setText(PAGES[0] as string, "Pakete für Agenturen, monatlich kündbar.");
  await setText(PAGES[1] as string, "Ein Artikel über Rabatte im Handel.");
  await setText(HOME, "Willkommen.");
}

async function stage(): Promise<string> {
  calls.length = 0;
  const staged = await ok<{ runId: string }>("deploy.trigger", {
    targetName: "staging",
    repoRoot: root,
  });
  await markAudited(staged.runId);
  return staged.runId;
}

async function indexState(runId: string): Promise<{
  state: string;
  releaseKey: string | null;
  error: string | null;
  stats: Record<string, unknown>;
}> {
  // The index job runs in-process, started by the Stage; wait for it.
  for (let i = 0; i < 200; i++) {
    const s = await ok<{
      collections: {
        state: string;
        releaseKey: string | null;
        error: string | null;
        stats: Record<string, unknown>;
      }[];
    }>("collections.run_state", { runId });
    const c = s.collections[0];
    if (c && c.state !== "pending") return c;
    await Bun.sleep(50);
  }
  throw new Error("the index job did not finish");
}

async function searchStore(storeDir: string, releaseKey: string, text: string): Promise<string[]> {
  const store = scopedStore(directoryStore(storeDir), `${PLUGIN}/pages`);
  const cache = new FileCache({ read: (f) => store.read(f) }, 1 << 26);
  const release = await openRelease(parseRelease(await store.read(releaseKey)), cache);
  const r = await searchText(release, {
    text,
    lang: "de",
    weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
    limit: 10,
  });
  const out: string[] = [];
  for (const h of r.hits)
    for (const s of release.segments) {
      const d = (await s.reader.stored([h.key])).get(h.key);
      if (d && !s.removed.has(h.key)) out.push(String(d.values.url));
    }
  return out;
}

beforeAll(async () => {
  await wipe();
  restore.push(await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com"));
  restore.push(await pinSiteLanguage(ADMIN_URL as string, "de"));
  root = await mkdtemp(join(tmpdir(), "caelo-t1644-"));
  for (const [k, v] of Object.entries({
    CAELO_SKIP_STAGING_SERVE_CHECK: "1",
    CAELO_OUTPUT_ROOT: root,
    CAELO_COLLECTIONS_STAGING_STORE: `file://${root}/collections-staging`,
    CAELO_COLLECTIONS_LIVE_STORE: `file://${root}/collections-live`,
  })) {
    envBefore[k] = process.env[k];
    process.env[k] = v;
  }
  resetCollectionStores();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  stagingAdapter = stagingPublicAdapter(STAGING_URL);
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  setInProcessJobLauncher((kind) => inProcessJobLauncher({ adapter, registry }, kind));
  await seed();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [
      {
        definition: definePlugin({
          slug: PLUGIN,
          version: "0.1.0",
          tier: 1,
          schema: { hits: { query: "text" } },
          tableKinds: { hits: "published" },
          requestedCapabilities: ["collections", "page_output"],
          collections: {
            pages: {
              description: "Every published page, for the site search.",
              fields: {
                title: { kind: "text", prefix: true },
                sections: { kind: "passages" },
                url: { kind: "keyword" },
              },
              maxDocuments: 1000,
              maxDocumentBytes: 100_000,
            },
          },
          // A rule that shapes every document, and a per-page setting.
          config: {
            title_only: {
              type: "bool",
              label: "Titles only",
              description: "Index only the page titles.",
              effect: "rebuild",
              default: false,
            },
          },
          entityConfig: {
            page: {
              excluded: {
                type: "bool",
                label: "Leave out of the search",
                description: "The page does not appear in the site search.",
                effect: "pages",
                default: false,
              },
            },
          },
          pageOutputObserver: { operation: "observe" },
          operations: {
            observe: async (ctx, args) => {
              const a = args as PageOutputObserverArgs;
              calls.push(a);
              const config = ctx.config;
              if (!config) throw new Error("ctx.config missing");
              const titleOnly = (await config.get()).title_only === true;
              const settings = await config.entities(
                "page",
                a.pages.map((p) => p.pageId),
              );
              const excluded = a.pages
                .filter((p) => settings.get(p.pageId)?.excluded === true)
                .map((p) => p.pageId);

              if (writePublic) await ctx.query.insert("hits", { query: "staged" });
              const pages = (ctx as { collections?: PluginCollections }).collections?.pages;
              if (!pages) throw new Error("ctx.collections.pages missing");
              const docs = a.pages
                .filter((p) => !excluded.includes(p.pageId))
                .map((p) => ({
                  id: p.pageId,
                  lang: p.lang || "de",
                  values: {
                    title: p.title,
                    sections: [
                      {
                        anchor: p.texts.find((t) => t.anchor)?.anchor ?? "",
                        heading: "",
                        text: titleOnly ? "" : p.texts.map((t) => t.text).join(" "),
                      },
                    ],
                    url: p.path,
                  },
                }));
              if (docs.length > 0) await pages.upsert(docs);
              if (a.removed.length > 0 || excluded.length > 0)
                await pages.delete([...a.removed, ...excluded]);
              if (a.final && !profileSet) {
                profileSet = true;
                await pages.setProfile({
                  weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
                  typos: true,
                  compounds: true,
                  prefix: true,
                  crossLanguage: false,
                  semantic: null,
                });
              }
              return {};
            },
          },
        }),
      },
    ],
  });
  expect(report.failed).toEqual([]);
  await syncPluginHost(true);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetCollectionStores();
  await wipe();
  for (const r of restore) await r();
  await rm(root, { recursive: true, force: true });
  await adapter.close();
  await stagingAdapter.close();
});

async function published(url: string): Promise<string[]> {
  await drainProjectionOnce(adapter, stagingAdapter);
  return sqlSystem(
    async (tx) =>
      (
        (await tx`SELECT release_key FROM published_collections WHERE collection = 'pages'`) as {
          release_key: string;
        }[]
      ).map((r) => r.release_key),
    url,
  );
}

describe("page output and collections through Stage and Publish live", () => {
  let first = "";

  it("delivers every page to the observer and indexes them", async () => {
    first = await stage();
    const delivered = calls.flatMap((c) => c.pages.map((p) => p.path)).sort();
    expect(delivered).toEqual(["/", ...PAGES.map((s) => `/${s}`)].sort());
    const page = calls.flatMap((c) => c.pages).find((p) => p.title === "Preise");
    expect(page?.modules.find((m) => m.zone === "page")?.placementCount).toBe(3);
    expect(page?.texts.find((t) => t.text === "Abschnitt")?.heading).toBe(2);
    expect(calls.at(-1)?.final).toBe(true);
    const index = await indexState(first);
    expect(index.state).toBe("ready");
    expect(index.stats.docCount).toBe(3);
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "Preis"),
    ).toEqual([`/${PAGES[0]}`]);
    // The staging gateway learns the Stage's index; the live one still has none.
    expect(await published(STAGING_URL as string)).toEqual([index.releaseKey as string]);
    expect(await published(PUBLIC_URL as string)).toEqual([]);
  });

  it("Publish live copies the index to the live store and publishes its release", async () => {
    await ok("deploy.promote", { fromTarget: "staging", toTarget: "production", repoRoot: root });
    const index = await indexState(first);
    expect(
      await searchStore(join(root, "collections-live"), index.releaseKey as string, "Agenturen"),
    ).toEqual([`/${PAGES[0]}`]);
    expect(await published(PUBLIC_URL as string)).toEqual([index.releaseKey as string]);
  });

  it("a second Stage delivers only the changed page and writes a delta", async () => {
    await setText(PAGES[1] as string, "Neu: Versand in die Schweiz.");
    const run = await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path))).toEqual([`/${PAGES[1]}`]);
    const index = await indexState(run);
    expect(index.state).toBe("ready");
    expect(index.stats.rebuilt).toBe(false);
    expect(index.stats.segments).toBe(2);
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "Versand"),
    ).toEqual([`/${PAGES[1]}`]);
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "Rabatte"),
    ).toEqual([]);
  });

  it("an unchanged Stage carries the release over without a job", async () => {
    const run = await stage();
    expect(calls.flatMap((c) => c.pages)).toEqual([]);
    const index = await indexState(run);
    expect(index.stats.carried).toBe(true);
  });

  it("a configuration change delivers every page again, once", async () => {
    await ok("plugin_config.update", { pluginSlug: PLUGIN, patch: { title_only: true } });
    const run = await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path)).sort()).toEqual(
      ["/", ...PAGES.map((s) => `/${s}`)].sort(),
    );
    const index = await indexState(run);
    expect(index.state).toBe("ready");
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "Versand"),
    ).toEqual([]);
    await stage();
    expect(calls.flatMap((c) => c.pages)).toEqual([]);
    await ok("plugin_config.update", { pluginSlug: PLUGIN, patch: { title_only: false } });
    await stage();
  });

  it("a page setting delivers that page again", async () => {
    const pageId = pageIds.get(PAGES[0] as string) as string;
    await ok("plugin_config.set_entities", {
      pluginSlug: PLUGIN,
      items: [{ kind: "page", id: pageId, values: { excluded: true } }],
    });
    const run = await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path))).toEqual([`/${PAGES[0]}`]);
    const index = await indexState(run);
    expect(index.stats.docCount).toBe(2);
    await ok("plugin_config.set_entities", {
      pluginSlug: PLUGIN,
      items: [{ kind: "page", id: pageId, values: { excluded: null } }],
    });
    const back = await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path))).toEqual([`/${PAGES[0]}`]);
    expect((await indexState(back)).stats.docCount).toBe(3);
  });

  it("a page taken offline reaches the observer as removed and leaves the index", async () => {
    await ok("pages.update", { pageId: pageIds.get(PAGES[1] as string), status: "draft" });
    const run = await stage();
    expect(calls.at(-1)?.removed).toEqual([pageIds.get(PAGES[1] as string)]);
    const index = await indexState(run);
    expect(index.stats.docCount).toBe(2);
    await ok("pages.update", { pageId: pageIds.get(PAGES[1] as string), status: "published" });
  });

  it("an observer that writes a public table is refused, and a failing observer blocks Publish live", async () => {
    writePublic = true;
    await setText(PAGES[0] as string, "Neue Preise ab Januar.");
    const run = await stage();
    writePublic = false;
    const index = await indexState(run);
    expect(index.state).toBe("failed");
    expect(index.error).toContain("cannot write its public tables");
    const refused = await execute(registry, adapter, HUMAN, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: root,
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused.ok ? null : refused.error)).toContain(
      "search index of this Stage is not ready",
    );
  });

  it("the pages of a failed observer are delivered again by the next Stage", async () => {
    const run = await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path))).toContain(`/${PAGES[0]}`);
    const index = await indexState(run);
    expect(index.state).toBe("ready");
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "Januar"),
    ).toEqual([`/${PAGES[0]}`]);
  });
});
