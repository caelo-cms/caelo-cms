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
 * - an observer cannot write a public table (visitors would see staged work);
 * - #1650: a collection whose configuration names a catalog model is
 *   embedded by the index job (only changed passages in a delta), finds a
 *   page by meaning, and a model change rebuilds it (here: semantic search
 *   turned off). Runs with the real model when it is fetched
 *   (packages/models testing.ts; CI requires it).
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
  searchVectors,
} from "@caelo-cms/collection-index";
import { modelsForTests } from "@caelo-cms/models";
import { createNativeEmbedder } from "@caelo-cms/models/native";
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
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  type EmbeddingModel,
  type ExecutionContext,
  embeddingModel,
  embeddingModelFingerprint,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { runCollectionsGc } from "../collections/gc.js";
import { afterFailedStage } from "../collections/stage.js";
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
const MODEL = embeddingModel(DEFAULT_EMBEDDING_MODEL_ID) as EmbeddingModel;
/** Without the fetched model the `semantic` collection has no model, and the rest still runs. */
const MODELS = modelsForTests(MODEL);

let adapter: DatabaseAdapter;
let stagingAdapter: DatabaseAdapter;
let registry: OperationRegistry;
let root = "";

let writePublic = false;
/** The observer fails after it wrote its documents (a partial delivery). */
let failAfterWrite = false;
/** Only the observer's final call fails, after it applied the removals. */
let failOnFinal = false;
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
    // The plugin's private tables hold its configuration: a run that changed
    // the model must not leave it for the next run's activation to keep.
    await tx.unsafe(`DROP SCHEMA IF EXISTS plugin_${PLUGIN.replace(/-/g, "_")} CASCADE`);
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

interface IndexState {
  collection: string;
  state: string;
  releaseKey: string | null;
  error: string | null;
  stats: Record<string, unknown>;
  vectorModel: string | null;
}

async function indexState(runId: string, collection = "pages"): Promise<IndexState> {
  // The index job runs in-process, started by the Stage; wait until it built every collection.
  for (let i = 0; i < 1200; i++) {
    const s = await ok<{ collections: IndexState[] }>("collections.run_state", { runId });
    const c = s.collections.find((x) => x.collection === collection);
    if (c && s.collections.every((x) => x.state !== "pending")) return c;
    await Bun.sleep(50);
  }
  throw new Error("the index job did not finish");
}

/** Every file under a store directory, recursively. */
async function listFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
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
            semantic: {
              description: "The same pages with vectors.",
              fields: {
                title: { kind: "text", prefix: true },
                sections: { kind: "passages", vector: true },
                url: { kind: "keyword" },
              },
              vectorModelConfig: "semantic_model",
              maxDocuments: 1000,
              maxDocumentBytes: 100_000,
            },
          },
          // A rule that shapes every document, the semantic model, and a per-page setting.
          config: {
            semantic_model: {
              type: "catalogModel",
              purpose: "embedding",
              label: "Model",
              description: "The model the semantic collection embeds with.",
              effect: "rebuild",
              default: MODELS.dir ? DEFAULT_EMBEDDING_MODEL_ID : null,
            },
            full_max: {
              type: "int",
              label: "Pages a module counts fully on",
              description: "Above this, a module counts differently (placement step).",
              effect: "rebuild",
              min: 1,
              max: 1000,
              default: 2,
            },
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
            contentInstance: {
              mode: {
                type: "enum",
                options: [
                  { value: "full", label: "Fully" },
                  { value: "never", label: "Not at all" },
                ],
                label: "Counts as",
                description: "Whether a shared content block's text counts on the pages it is on.",
                effect: "pages",
                default: "full",
              },
            },
          },
          pageOutputObserver: {
            operation: "observe",
            placementSteps: { thresholds: ["full_max"] },
          },
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
              const collections = (ctx as { collections?: PluginCollections }).collections;
              const pages = collections?.pages;
              const semantic = collections?.semantic;
              if (!pages || !semantic) throw new Error("ctx.collections.pages/semantic missing");
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
              for (const c of [pages, semantic]) {
                if (docs.length > 0) await c.upsert(docs);
                if (a.removed.length > 0 || excluded.length > 0)
                  await c.delete([...a.removed, ...excluded]);
              }
              if (failAfterWrite || (failOnFinal && a.final))
                throw new Error("t1644: the observer fails after writing");
              if (a.final && !profileSet) {
                profileSet = true;
                const profile = {
                  weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
                  typos: true,
                  compounds: true,
                  prefix: true,
                  crossLanguage: false,
                };
                await pages.setProfile({ ...profile, semantic: null });
                await semantic.setProfile({
                  ...profile,
                  semantic: { weight: 1, minSimilarity: 0.2 },
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
    // The observer tells placements apart by their content instance ...
    expect(page?.texts.find((t) => t.text === "Abschnitt")?.contentInstanceId).toBe(
      instances.get(PAGES[0] as string),
    );
    // ... from a stamp no published file carries.
    const { readFile } = await import("node:fs/promises");
    const built = (await listFiles(root)).filter((f) => f.endsWith(".html"));
    expect(built.length).toBeGreaterThan(0);
    for (const f of built)
      expect([f, (await readFile(f, "utf8")).includes("data-caelo-content-instance")]).toEqual([
        f,
        false,
      ]);
    expect(calls.at(-1)?.final).toBe(true);
    const index = await indexState(first);
    expect(index.state).toBe("ready");
    expect(index.stats.docCount).toBe(3);
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "Preis"),
    ).toEqual([`/${PAGES[0]}`]);
    // The Stage status says the index is ready (the AI reads it in get_stage_status).
    const status = await ok<{
      runs: { searchIndexes?: { collection: string; state: string }[] }[];
    }>("deploy.stage_status", { deployRunId: first });
    expect(status.runs[0]?.searchIndexes).toEqual([
      { plugin: PLUGIN, collection: "pages", state: "ready", error: null },
      { plugin: PLUGIN, collection: "semantic", state: "ready", error: null },
    ] as never);
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

  it("a plugin reads its own index releases, never another plugin's", async () => {
    const releasesAs = async (kind: string, pluginId: string) => {
      const conn = new SQL(ADMIN_URL as string);
      try {
        return (await conn.begin(async (tx) => {
          await tx`SELECT set_config('caelo.actor_kind', ${kind}, true),
                          set_config('caelo.plugin_id', ${pluginId}, true)`;
          return tx`SELECT DISTINCT plugin_id::text AS id FROM collection_releases`;
        })) as { id: string }[];
      } finally {
        await conn.end();
      }
    };
    const [own] = (await releasesAs("system", "")).map((r) => r.id);
    expect(own).toBeDefined();
    expect((await releasesAs("human", "")).map((r) => r.id)).toContain(own as string);
    expect((await releasesAs("plugin", own as string)).map((r) => r.id)).toEqual([own as string]);
    expect(await releasesAs("plugin", crypto.randomUUID())).toEqual([]);
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

  it("a page's data the HTML does not show (short title) delivers that page again", async () => {
    const pageId = pageIds.get(PAGES[0] as string) as string;
    await ok("pages.update", { pageId, shortTitle: "Preise kurz" });
    await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path))).toEqual([`/${PAGES[0]}`]);
    expect(calls.flatMap((c) => c.pages.map((p) => p.shortTitle))).toEqual(["Preise kurz"]);
    await stage();
    expect(calls.flatMap((c) => c.pages)).toEqual([]);
  });

  it("a content block's setting delivers every page again, once", async () => {
    const id = instances.get(PAGES[0] as string) as string;
    await ok("plugin_config.set_entities", {
      pluginSlug: PLUGIN,
      items: [{ kind: "contentInstance", id, values: { mode: "never" } }],
    });
    await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path)).sort()).toEqual(
      ["/", ...PAGES.map((s) => `/${s}`)].sort(),
    );
    await stage();
    expect(calls.flatMap((c) => c.pages)).toEqual([]);
    await ok("plugin_config.set_entities", {
      pluginSlug: PLUGIN,
      items: [{ kind: "contentInstance", id, values: { mode: null } }],
    });
    await stage();
  });

  it("a page taken offline reaches the observer as removed and leaves the index", async () => {
    await ok("pages.update", { pageId: pageIds.get(PAGES[1] as string), status: "draft" });
    const run = await stage();
    expect(calls.at(-1)?.removed).toEqual([pageIds.get(PAGES[1] as string)]);
    // The text module shows each page's own content (one instance per
    // page), so no placement step moves and no other page comes again; a
    // shared block crossing a step is the site search test's (#1651).
    expect(calls.flatMap((c) => c.pages.map((p) => p.path))).toEqual([]);
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

  it("what an observer wrote before it failed is discarded, its pages delivered again", async () => {
    failAfterWrite = true;
    await setText(PAGES[0] as string, "Neue Preise ab März.");
    let run: string;
    try {
      run = await stage();
    } finally {
      failAfterWrite = false;
    }
    expect((await indexState(run)).state).toBe("failed");
    const rows = (await sqlSystem(
      async (tx) =>
        tx`SELECT (discarded_at IS NOT NULL) AS discarded FROM collection_changes
           WHERE run_id = ${run}::uuid AND applied_run_id IS NULL`,
    )) as { discarded: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.discarded)).toBe(true);
    // Nothing of that delivery was recorded: the next Stage delivers the
    // page again, and its index finds the new text.
    const next = await stage();
    expect(calls.flatMap((c) => c.pages.map((p) => p.path))).toContain(`/${PAGES[0]}`);
    const index = await indexState(next);
    expect(index.state).toBe("ready");
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "März"),
    ).toEqual([`/${PAGES[0]}`]);
  });

  it("a page taken offline while the observer's last call fails is removed by the next Stage", async () => {
    const page = pageIds.get(PAGES[1] as string) as string;
    const before = await indexState(await stage());
    expect(before.state).toBe("ready");
    await ok("pages.update", { pageId: page, status: "draft" });
    failOnFinal = true;
    let failedRun: string;
    try {
      failedRun = await stage();
    } finally {
      failOnFinal = false;
    }
    expect(calls.at(-1)?.removed).toEqual([page]);
    expect((await indexState(failedRun)).state).toBe("failed");
    // Nothing of the failed run was recorded: the removal comes again.
    const next = await stage();
    expect(calls.at(-1)?.removed).toEqual([page]);
    const index = await indexState(next);
    expect(index.state).toBe("ready");
    expect(index.stats.docCount).toBe((before.stats.docCount as number) - 1);
    await ok("pages.update", { pageId: page, status: "published" });
  });

  it("what an observer wrote in a failed Stage never reaches a later index", async () => {
    const run = await stage();
    const [plugin] = (await sqlSystem(
      async (tx) => tx`SELECT id::text AS id FROM plugins WHERE slug = ${PLUGIN}`,
    )) as { id: string }[];
    // A write of that Stage's observer, as if the Stage then failed. Its
    // file is not even in the store: a claim of it would fail the index job.
    const [abandoned] = (await sqlSystem(
      async (tx) =>
        tx`INSERT INTO collection_changes (plugin_id, collection, run_id, store_key, upserts, deletes, bytes)
           VALUES (${plugin?.id}::uuid, 'pages', ${run}::uuid, ${`${PLUGIN}/pages/changes/t-abandoned.json`}, 1, 0, 10)
           RETURNING id::text AS id`,
    )) as { id: string }[];
    await afterFailedStage(
      { adapter, registry },
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t1644-failed" },
      run,
    );
    await setText(PAGES[1] as string, "Versand ab sofort auch nach Österreich.");
    const next = await stage();
    expect((await indexState(next)).state).toBe("ready");
    const [row] = (await sqlSystem(
      async (tx) =>
        tx`SELECT applied_run_id::text AS applied, discarded_at IS NOT NULL AS discarded
           FROM collection_changes WHERE id = ${abandoned?.id}::uuid`,
    )) as { applied: string | null; discarded: boolean }[];
    expect(row).toEqual({ applied: null, discarded: true });
  });

  it("the clean-up deletes what no kept release names, keeps the newest index searchable, and drops applied change files", async () => {
    const newest = await stage();
    await setText(PAGES[0] as string, "Neue Preise ab Januar und Februar.");
    const latest = await stage();
    const index = await indexState(latest);
    const before = (await listFiles(join(root, "collections-staging"))).length;
    const indexFiles = async () =>
      (await listFiles(join(root, "collections-staging"))).filter((f) => !f.includes("/changes/"))
        .length;
    const indexBefore = await indexFiles();
    // With the grace window every index file here is too young to go: a
    // writer could still be in flight (gc.ts GC_GRACE_MS). Applied change
    // files have their own rule and may go.
    const spared = await runCollectionsGc(
      { adapter, registry },
      { keepStages: 2, keepPublishes: 1 },
    );
    expect(spared.deletedFiles).toBe(0);
    expect(spared.deletedChanges).toBeGreaterThan(0);
    expect(await indexFiles()).toBe(indexBefore);
    const report = await runCollectionsGc(
      { adapter, registry },
      { keepStages: 2, keepPublishes: 1, graceMs: 0 },
    );
    expect(report.deletedFiles).toBeGreaterThan(0);
    expect((await listFiles(join(root, "collections-staging"))).length).toBeLessThan(before);
    expect(
      await searchStore(join(root, "collections-staging"), index.releaseKey as string, "Februar"),
    ).toEqual([`/${PAGES[0]}`]);
    // The release of the Stage before still serves (kept: the last two).
    expect((await indexState(newest)).state).toBe("ready");
    const left = await sqlSystem(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM collection_changes WHERE applied_run_id IS NOT NULL`) as {
          n: number;
        }[],
    );
    expect(left[0]?.n).toBe(0);
    // A second run finds nothing more to do.
    const again = await runCollectionsGc(
      { adapter, registry },
      { keepStages: 2, keepPublishes: 1, graceMs: 0 },
    );
    expect(again.deletedFiles + again.deletedChanges).toBe(0);
  });
});

describe("semantic search through the Stage (#1650)", () => {
  if (MODELS.required) {
    it("the model is fetched (CAELO_MODELS=required)", () => {
      expect(MODELS.dir).not.toBeNull();
    });
  }
  const live = (name: string, fn: () => Promise<void>) =>
    it.skipIf(MODELS.dir === null)(name, fn, 120_000);

  live("embeds only the changed page's passages and finds it by meaning", async () => {
    await setText(PAGES[0] as string, "Starter für 49 € im Monat, Agentur für 499 €.");
    const run = await stage();
    const index = await indexState(run, "semantic");
    expect(index.state).toBe("ready");
    expect(index.vectorModel).toBe(MODEL.id);
    expect(index.stats).toMatchObject({
      vectorModel: embeddingModelFingerprint(MODEL),
      passagesEmbedded: 1,
      rebuilt: false,
    });
    const store = scopedStore(
      directoryStore(join(root, "collections-staging")),
      `${PLUGIN}/semantic`,
    );
    const release = await openRelease(
      parseRelease(await store.read(index.releaseKey as string)),
      new FileCache({ read: (f) => store.read(f) }, 1 << 26),
    );
    expect(release.manifest.vectorModel?.id).toBe(embeddingModelFingerprint(MODEL));
    const embedder = await createNativeEmbedder(MODEL, { dir: MODELS.dir as string, threads: 2 });
    const [vector] = await embedder.embed(["Was kostet das?"], "query");
    await embedder.release();
    const near = await searchVectors(release, {
      vector: vector as Float32Array,
      limit: 1,
      minSimilarity: 0.2,
    });
    const top = (await release.segments.at(-1)?.reader.stored([near[0]?.key as number]))?.get(
      near[0]?.key as number,
    );
    const found =
      top ??
      (await release.segments[0]?.reader.stored([near[0]?.key as number]))?.get(
        near[0]?.key as number,
      );
    expect(found?.values.url).toBe(`/${PAGES[0]}`);
  });

  live("a model change rebuilds the collection, here without vectors", async () => {
    await ok("plugin_config.update", { pluginSlug: PLUGIN, patch: { semantic_model: null } });
    const run = await stage();
    const semantic = await indexState(run, "semantic");
    expect(semantic.state).toBe("ready");
    expect(semantic.vectorModel).toBeNull();
    expect(semantic.stats).toMatchObject({ rebuilt: true, vectorModel: null, passagesEmbedded: 0 });
    // A configuration change delivers every page again (the observer's
    // digest), so the word collection is written again, the same documents.
    const pages = await indexState(run, "pages");
    expect(pages.state).toBe("ready");
    expect(pages.stats.docCount).toBe(3);
  });
});
