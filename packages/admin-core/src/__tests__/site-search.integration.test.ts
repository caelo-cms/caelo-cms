// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (issue #1651) — the shipped site search plugin end to end on a
 * real Postgres, with the in-process index job and file stores:
 *
 * - a Stage indexes the site; "Kosten" finds the pricing page through the
 *   words another page links it with, and through a synonym, and the
 *   preview says which;
 * - a block on more pages than the plugin counts fully counts only on its
 *   home page; editing it re-writes only that page's document;
 * - the Stage audit runs the test queries: a pinned result that is not
 *   first is an error, an expected page outside the first results a warning;
 * - the learning batch turns counted searches into a popular-query
 *   candidate and an insight; approving the candidate bakes it into the
 *   results page's region.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  MAIN_RENDER,
  renderInvocation,
  resetCollectionStores,
  resetPluginHost,
  resetPluginHostSync,
  runPluginOperation,
  runPluginStaticRender,
  syncPluginHost,
} from "@caelo-cms/plugin-host";
import siteSearch from "@caelo-cms/plugin-site-search";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import type { BatchRun } from "../plugin-batches/ops.js";
import { stagingPublicAdapter } from "../public-projection.js";
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
  requestId: "t1651",
};
const SLUG = "site-search";
const TPL = "t1651-tpl";
const MOD = "t1651-text";
const TEASER = "t1651-teaser";
const PAGES = ["t1651-preise", "t1651-blog", "t1651-kontakt", "t1651-team"] as const;
const HOME = "home";

let adapter: DatabaseAdapter;
let stagingAdapter: DatabaseAdapter;
let registry: OperationRegistry;
let root = "";
let teaserId = "";
let teaserInstance = "";
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

async function plugin<T>(operation: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    pluginSlug: SLUG,
    operationName: operation,
    args,
    invocation: { origin: "owner-panel", actorId: SYSTEM_ACTOR_ID },
  });
  if (!r.ok) throw new Error(`${operation}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function wipe(): Promise<void> {
  resetPluginHost();
  resetPluginHostSync();
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM collection_changes`;
    await tx`DELETE FROM collection_releases`;
    await tx`DELETE FROM plugin_page_observations`;
    await tx`DELETE FROM plugin_page_observers`;
    await tx`DELETE FROM plugin_module_counts`;
    await tx`DELETE FROM plugin_batch_runs`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM reporting_jobs`;
    await tx`DELETE FROM deploy_runs`;
    for (const slug of [...PAGES, HOME]) {
      await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})`;
      await tx`DELETE FROM pages WHERE slug = ${slug}`;
    }
    // The pages and the banner of the site-size test.
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 't1651-x%')`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 't1651-x%')`;
    await tx`DELETE FROM pages WHERE slug LIKE 't1651-x%'`;
    await tx`DELETE FROM modules WHERE slug = 't1651-banner'`;
    await tx`DELETE FROM modules WHERE slug IN (${MOD}, ${TEASER})`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
    await tx`DELETE FROM site_snapshots WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM list_refs WHERE list_id IN (SELECT id FROM lists WHERE slug LIKE 't1651-%')`;
    await tx`DELETE FROM list_snapshots WHERE list_id IN (SELECT id FROM lists WHERE slug LIKE 't1651-%')`;
    await tx`DELETE FROM lists WHERE slug LIKE 't1651-%'`;
    await tx`DELETE FROM list_types WHERE slug LIKE 'site-search-%'`;
    await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    await tx.unsafe("DROP SCHEMA IF EXISTS plugin_site_search CASCADE");
  });
  for (const url of [PUBLIC_URL, STAGING_URL])
    await sqlSystem(async (tx) => {
      await tx.unsafe("DROP SCHEMA IF EXISTS plugin_site_search CASCADE");
    }, url as string);
}

async function setText(slug: string, values: Record<string, string>): Promise<void> {
  await ok("content_instances.set_values", { id: instances.get(slug), values });
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
  const text = await ok<{ moduleId: string }>("modules.create", {
    slug: MOD,
    displayName: "Text",
    html: `<section id="inhalt"><h2>{{heading}}</h2><p>{{body}}</p><a href="{{link_href}}">{{link_label}}</a></section>`,
    fields: [
      { name: "heading", kind: "text", label: "Heading" },
      { name: "body", kind: "text", label: "Body" },
      { name: "link_href", kind: "url", label: "Link" },
      { name: "link_label", kind: "text", label: "Link text" },
    ] as never,
  });
  const teaser = await ok<{ moduleId: string }>("modules.create", {
    slug: TEASER,
    displayName: "Teaser",
    html: `<aside><p>{{claim}}</p></aside>`,
    fields: [{ name: "claim", kind: "text", label: "Claim" }] as never,
  });
  teaserId = teaser.moduleId;
  for (const slug of [...PAGES, HOME]) {
    const title =
      {
        "t1651-preise": "Preise",
        "t1651-blog": "Blog",
        "t1651-kontakt": "Kontakt",
        "t1651-team": "Team",
      }[slug as string] ?? "Start";
    const { pageId } = await ok<{ pageId: string }>("pages.create", { slug, title, templateId });
    pageIds.set(slug, pageId);
    await ok("pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [text.moduleId, teaser.moduleId] }],
    });
    const placed = await sqlSystem(
      async (tx) =>
        (await tx`SELECT content_instance_id::text AS id, module_id::text AS module_id FROM page_modules WHERE page_id = ${pageId}::uuid`) as {
          id: string;
          module_id: string;
        }[],
    );
    instances.set(slug, placed.find((p) => p.module_id === text.moduleId)?.id as string);
    instances.set(
      `${slug}#teaser`,
      placed.find((p) => p.module_id === teaser.moduleId)?.id as string,
    );
    await ok("pages.update", { pageId, status: "published" });
    await ok("pages_seo.autofill", { pageId, metaDescription: `About ${slug}.` });
  }
  const ref = (slug: string) => `caelo:page/${pageIds.get(slug)}`;
  await setText("t1651-preise", {
    heading: "Pakete",
    body: "Monatlich kündbar, für Agenturen.",
    link_href: ref(HOME),
    link_label: "Start",
  });
  await setText("t1651-blog", {
    heading: "Neuigkeiten",
    body: "Was wir gelernt haben.",
    link_href: ref("t1651-preise"),
    link_label: "Kosten im Überblick",
  });
  await setText("t1651-kontakt", {
    heading: "Schreiben Sie uns",
    body: "Wir antworten am selben Tag.",
    link_href: ref(HOME),
    link_label: "Start",
  });
  await setText("t1651-team", {
    heading: "Wer wir sind",
    body: "Ein kleines Team.",
    link_href: ref(HOME),
    link_label: "Start",
  });
  await setText(HOME, {
    heading: "Willkommen",
    body: "Software für Suchmaschinen.",
    link_href: ref("t1651-kontakt"),
    link_label: "Kontakt",
  });
  // The teaser is a repeated block: ONE synced content instance on every page.
  const shared = await ok<{ contentInstanceId: string }>("content_instances.create", {
    moduleId: teaser.moduleId,
    purpose: "The trial teaser shown on every page.",
    values: { claim: "Jetzt kostenlos testen" },
  });
  teaserInstance = shared.contentInstanceId;
  for (const slug of [...PAGES, HOME])
    await ok("placement.set_content", {
      pageId: pageIds.get(slug),
      blockName: "content",
      position: 1,
      contentInstanceId: shared.contentInstanceId,
      syncMode: "synced",
    });
}

async function stage(): Promise<string> {
  const staged = await ok<{ runId: string }>("deploy.trigger", {
    targetName: "staging",
    repoRoot: root,
  });
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
             VALUES (${staged.runId}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'passed', '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
  });
  for (let i = 0; i < 1200; i++) {
    const s = await ok<{ collections: { state: string }[] }>("collections.run_state", {
      runId: staged.runId,
    });
    if (s.collections.length > 0 && s.collections.every((c) => c.state !== "pending")) {
      if (s.collections.some((c) => c.state === "failed")) throw new Error(JSON.stringify(s));
      return staged.runId;
    }
    await Bun.sleep(50);
  }
  throw new Error("the index job did not finish");
}

interface Hit {
  readonly id: string;
  readonly url: string;
  readonly pinned?: boolean;
  readonly why: {
    readonly via: readonly string[];
    readonly anchors: { readonly texts: readonly string[] } | null;
    readonly fields: readonly { readonly field: string }[];
  };
}

async function preview(query: string): Promise<Hit[]> {
  const r = await plugin<{ state: string; hits: Hit[] }>("preview", { query, lang: "de" });
  expect(r.state).toBe("ready");
  return r.hits;
}

async function list(slug: string, type: string, items: unknown[]): Promise<string> {
  const r = await ok<{ lists: { id: string }[] }>("lists.upsert_many", {
    lists: [{ slug, name: slug, purpose: "Site search test list.", type, items }],
  });
  return r.lists[0]?.id as string;
}

beforeAll(async () => {
  await wipe();
  restore.push(await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com"));
  restore.push(await pinSiteLanguage(ADMIN_URL as string, "de"));
  root = await mkdtemp(join(tmpdir(), "caelo-t1651-"));
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
    infra: { adapter, registry, stagingAdapter },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: siteSearch }],
  });
  expect(report.failed).toEqual([]);
  await syncPluginHost(true);
  // A small site: blocks on more than 2 pages count reduced, on more than 3 only on their home page.
  await ok("plugin_config.update", {
    pluginSlug: SLUG,
    patch: { counting: { full_max: 2, reduced_max: 3 } },
  });
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

describe("the site search (#1651)", () => {
  it("finds the pricing page for 'Kosten' through another page's link text", async () => {
    await stage();
    const hits = await preview("Kosten");
    expect(hits[0]?.url).toBe(`/${PAGES[0]}`);
    expect(hits[0]?.why.anchors?.texts).toContain("Kosten im Überblick");
  });

  it("finds it through a synonym, and says so", async () => {
    const synonyms = await list("t1651-synonyms", "site-search-synonyms", [
      { node: "synonym", values: { words: "Gebühren, Pakete", lang: "de" } },
    ]);
    await ok("plugin_config.update", { pluginSlug: SLUG, patch: { lists: { synonyms } } });
    await stage();
    const hits = await preview("Gebühren");
    expect(hits[0]?.url).toBe(`/${PAGES[0]}`);
    expect(hits[0]?.why.via.some((v) => v.includes("synonym"))).toBe(true);
  });

  it("a block on many pages counts only on its home page; editing it writes only that page", async () => {
    // On 5 pages (above reduced_max 3): no page matches its words yet.
    expect(await preview("kostenlos")).toEqual([]);
    await ok("plugin_config.set_entities", {
      pluginSlug: SLUG,
      items: [
        { kind: "module", id: teaserId, values: { home_page: pageIds.get("t1651-kontakt") } },
      ],
    });
    await stage();
    expect((await preview("kostenlos")).map((h) => h.url)).toEqual([`/${PAGES[2]}`]);
    await ok("content_instances.set_values", {
      id: teaserInstance,
      values: { claim: "Jetzt gratis testen" },
    });
    const run = await stage();
    const written = await sqlSystem(
      async (tx) =>
        (await tx`SELECT COALESCE(sum(upserts), 0)::int AS n FROM collection_changes
                  WHERE applied_run_id = ${run}::uuid AND collection = 'pages'`) as { n: number }[],
    );
    expect(written[0]?.n).toBe(1);
    expect((await preview("gratis")).map((h) => h.url)).toEqual([`/${PAGES[2]}`]);
  });

  it("the Stage audit runs the test queries: a pinned result not first is an error", async () => {
    const page = (slug: string) => ({ href: `caelo:page/${pageIds.get(slug)}` });
    const bets = await list("t1651-bets", "site-search-best-bets", [
      { node: "bet", values: { query: "Team", target_page: page("t1651-blog"), lang: "de" } },
    ]);
    const tests = await list("t1651-tests", "site-search-test-queries", [
      { node: "test", values: { query: "Kontakt", expect: page("t1651-kontakt") } },
      { node: "test", values: { query: "Team", expect: page("t1651-team") } },
      { node: "test", values: { query: "Agenturen", expect: page("t1651-team"), within: 1 } },
    ]);
    await ok("plugin_config.update", {
      pluginSlug: SLUG,
      patch: { lists: { best_bets: bets, test_queries: tests } },
    });
    const run = await stage();
    const r = await plugin<{ findings: { rule: string; severity: string }[] }>("audit", {
      pages: [],
      runId: run,
    });
    expect(r.findings.map((f) => [f.rule, f.severity]).sort()).toEqual([
      ["pinned-result-missing", "error"],
      ["test-query-missed", "warning"],
    ]);
    expect((await preview("Team"))[0]).toMatchObject({ url: `/${PAGES[1]}`, pinned: true });
  });

  it("learns from counted searches and bakes an approved popular query into the results page", async () => {
    await ok("plugin_config.update", {
      pluginSlug: SLUG,
      patch: { results_page: pageIds.get("t1651-team") },
    });
    const pluginId = await sqlSystem(
      async (tx) =>
        ((await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as { id: string }[])[0]
          ?.id as string,
    );
    // The rows the gateway's `record` writes, as the plugin's actor on the public database.
    await sqlSystem(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
      await tx`SELECT set_config('caelo.plugin_id', ${pluginId}, true)`;
      const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
      for (const [d, results] of [
        [0, 3],
        [0, 2],
        [1, 3],
        [2, 1],
        [2, 4],
      ] as const)
        await tx.unsafe(
          `INSERT INTO plugin_site_search.search_events (kind, text, lang, day, results, target, previous)
           VALUES ('search', 'Preise Agentur', 'de', '${day(d)}', ${results}, '', '')`,
        );
      for (let i = 0; i < 3; i++)
        await tx.unsafe(
          `INSERT INTO plugin_site_search.search_events (kind, text, lang, day, results, target, previous)
           VALUES ('search', 'Rabattcode', 'de', '${day(i)}', 0, '', '')`,
        );
    }, PUBLIC_URL as string);
    const { run } = await ok<{ run: BatchRun }>("plugin_batches.start", {
      pluginSlug: SLUG,
      operation: "learn",
    });
    let done: BatchRun | null = null;
    for (let i = 0; i < 600 && !done; i++) {
      const r = await ok<{ runs: BatchRun[] }>("plugin_batches.list", { pluginSlug: SLUG });
      const mine = r.runs.find((x) => x.id === run.id);
      if (mine && !["queued", "running"].includes(mine.state)) done = mine;
      else await Bun.sleep(50);
    }
    expect(done?.state).toBe("completed");
    expect(done?.result).toMatchObject({ candidates: 1, insights: 1 });
    const insights = await plugin<{ untrusted: boolean; insights: { query: string }[] }>(
      "list_insights",
      {},
    );
    expect(insights.untrusted).toBe(true);
    expect(insights.insights.map((i) => i.query)).toEqual(["Rabattcode"]);
    const pending = await plugin<{ queries: { id: string; text: string; status: string }[] }>(
      "list_popular",
      {},
    );
    expect(pending.queries.map((q) => [q.text, q.status])).toEqual([["Preise Agentur", "pending"]]);
    // Counting is approval-gated: proposed, then approved (the system acts as the Owner here).
    const proposed = await ok<{ proposalId: string }>("plugin_config.propose_update", {
      pluginSlug: SLUG,
      patch: { popular_suggestions: true },
      reason: "Offer what visitors ask often.",
    });
    const approved = await execute(
      registry,
      adapter,
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t1651-owner" },
      "plugin_config.execute_proposal",
      { proposalId: proposed.proposalId },
    );
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    const decided = await plugin<{ pageIds: string[] }>("decide_popular", {
      id: pending.queries[0]?.id,
      decision: "approved",
    });
    expect(decided.pageIds).toEqual([pageIds.get("t1651-team")]);
    const html = await runPluginStaticRender({
      pluginSlug: SLUG,
      pageId: pageIds.get("t1651-team") as string,
      pageUrlStyle: "directory",
      lang: "de",
      invocation: renderInvocation(MAIN_RENDER),
    } as never);
    expect(String(html)).toContain("Preise Agentur");
  });

  it("a shared block that drops below a step comes back on every page it is on", async () => {
    // The teaser is on 5 pages (above reduced_max 3: only its home page);
    // two pages go offline, it is on 3, and counts reduced on all of them.
    for (const slug of ["t1651-blog", "t1651-team"])
      await ok("pages.update", { pageId: pageIds.get(slug), status: "draft" });
    await stage();
    // Reduced counts the same on every page it is on; a home page matters
    // only in the last step.
    const hits = (await preview("gratis")).map((h) => h.url);
    expect(hits.sort()).toEqual(["/", `/${PAGES[0]}`, `/${PAGES[2]}`].sort());
  });

  it("a block whose step moves with the site's size is delivered again on every page it is on", async () => {
    // The half-of-all-pages rule (halfFrom 11): one shared block on 11 of
    // 21 pages counts only on its home page (it has none here: nowhere);
    // once the site has 22 pages it counts reduced on all 11, although
    // neither the block nor its pages changed.
    await ok("plugin_config.update", {
      pluginSlug: SLUG,
      patch: { counting: { full_max: 2, reduced_max: 30 } },
    });
    const { templateId } = await sqlSystem(
      async (tx) =>
        (
          (await tx`SELECT id::text AS "templateId" FROM templates WHERE slug = ${TPL}`) as {
            templateId: string;
          }[]
        )[0] as { templateId: string },
    );
    const banner = await ok<{ moduleId: string }>("modules.create", {
      slug: "t1651-banner",
      displayName: "Banner",
      html: "<aside><p>{{claim}}</p></aside>",
      fields: [{ name: "claim", kind: "text", label: "Claim" }] as never,
    });
    const shared = await ok<{ contentInstanceId: string }>("content_instances.create", {
      moduleId: banner.moduleId,
      purpose: "The loyalty banner shown on many pages.",
      values: { claim: "Sonderaktion für Stammkunden" },
    });
    let n = 0;
    const addPage = async (withBanner: boolean) => {
      const slug = `t1651-x${n++}`;
      const { pageId } = await ok<{ pageId: string }>("pages.create", {
        slug,
        title: `Seite ${n}`,
        templateId,
      });
      await ok("pages.set_modules", {
        pageId,
        blocks: [{ blockName: "content", moduleIds: withBanner ? [banner.moduleId] : [] }],
      });
      if (withBanner)
        await ok("placement.set_content", {
          pageId,
          blockName: "content",
          position: 0,
          contentInstanceId: shared.contentInstanceId,
          syncMode: "synced",
        });
      await ok("pages.update", { pageId, status: "published" });
      await ok("pages_seo.autofill", { pageId, metaDescription: `About ${slug}.` });
    };
    const [{ published }] = (await sqlSystem(
      async (tx) => tx`SELECT count(*)::int AS published FROM pages WHERE status = 'published'`,
    )) as [{ published: number }];
    for (let i = 0; i < 11; i++) await addPage(true);
    while (published + n < 21) await addPage(false);
    await stage();
    expect(await preview("Sonderaktion")).toEqual([]);
    // One more page without the banner: the site has 22.
    await addPage(false);
    await stage();
    // Reduced on all 11 of its pages (the preview shows ten).
    expect((await preview("Sonderaktion")).length).toBe(10);
  });
});
