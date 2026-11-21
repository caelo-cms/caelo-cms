// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1655) — the site assistant on the admin side, against a
 * real Postgres and a Stage's site-search index in the staging store:
 *
 * - activation waits for site-search and for the visitor AI;
 * - `ctx.chatTools` runs only the conversation's declared tools, on the
 *   Stage's release, as the plugin that owns the collection;
 * - the Stage audit: an answerable test question that finds its page is
 *   quiet, one that misses it and an off-topic one that finds pages are
 *   warnings, an unpublished contact page an error;
 * - the gap batch folds negative ratings into clusters the AI reads as
 *   untrusted data.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease, directoryStore, scopedStore } from "@caelo-cms/collection-index";
import {
  bootstrap,
  hostInfra,
  loadedPlugins,
  makePluginChatTools,
  releaseManifestDigest,
  resetCollectionStores,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { manifestFromDefinition } from "@caelo-cms/plugin-sdk";
import siteAssistant from "@caelo-cms/plugin-site-assistant";
import siteSearch from "@caelo-cms/plugin-site-search";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { stagingPublicAdapter } from "../public-projection.js";
import { registerAdminOps } from "../register.js";
import { inProcessJobLauncher } from "../reporting-jobs/in-process.js";
import { setInProcessJobLauncher } from "../reporting-jobs/launcher.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL as string;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL as string;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL as string;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1655-admin",
};
const PLUGINS = [siteSearch, siteAssistant] as const;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let root = "";
let runId = "";
let contactId = "";
let pricesId = "";
const restore: (() => Promise<void>)[] = [];
const envBefore: Record<string, string | undefined> = {};

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(url);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

async function ok<T>(op: string, input: unknown, ctx: ExecutionContext = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function plugin<T>(operation: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    pluginSlug: "site-assistant",
    operationName: operation,
    args,
    invocation: { origin: "owner-panel", actorId: SYSTEM_ACTOR_ID },
  });
  if (!r.ok) throw new Error(`${operation}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

const pluginId = (slug: string) =>
  onDb(
    ADMIN_URL,
    async (tx) =>
      ((await tx`SELECT id::text AS id FROM plugins WHERE slug = ${slug}`) as { id: string }[])[0]
        ?.id as string,
  );

/** Two published pages (prices, and the contact page the handoff names), built through the page ops. */
async function pages(): Promise<{ prices: string; contact: string }> {
  const tpl = await ok<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: "t1655-tpl",
    displayName: "T1655",
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  await ok("template_blocks.set", {
    templateId: tpl.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const build = async (slug: string, title: string, text: string) =>
    (
      await ok<{ pageId: string }>("pages.build_page", {
        page: { slug, title, templateId: tpl.templateId, status: "published" },
        modules: [
          {
            blockName: "content",
            displayName: `T1655 ${title}`,
            description: `The ${title} page's text.`,
            kind: "content",
            html: `<p>${text}</p>`,
            fields: [],
            content: { source: "inline", values: {} },
          },
        ],
      })
    ).pageId;
  return {
    prices: await build("t1655-preise", "Preise", "Das Starter-Paket kostet 49 Euro."),
    contact: await build("t1655-kontakt", "Kontakt", "Schreiben Sie uns."),
  };
}

/** This file's pages, modules and template (also what a crashed run left). */
async function removeSite(): Promise<void> {
  await onDb(ADMIN_URL, async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 't1655-%')`;
    await tx`DELETE FROM pages WHERE slug LIKE 't1655-%'`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE 'T1655 %')`;
    await tx`DELETE FROM modules WHERE display_name LIKE 'T1655 %'`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = 't1655-tpl')`;
    await tx`DELETE FROM templates WHERE slug = 't1655-tpl'`;
  });
}

beforeAll(async () => {
  await removeSite();
  restore.push(await pinSiteLanguage(ADMIN_URL, "de"));
  root = await mkdtemp(join(tmpdir(), "caelo-t1655-admin-"));
  for (const [k, v] of Object.entries({
    CAELO_COLLECTIONS_STAGING_STORE: `file://${root}/staging`,
    CAELO_COLLECTIONS_LIVE_STORE: `file://${root}/live`,
  })) {
    envBefore[k] = process.env[k];
    process.env[k] = v;
  }
  resetCollectionStores();
  await onDb(ADMIN_URL, async (tx) => {
    for (const p of PLUGINS) {
      const m = manifestFromDefinition(p);
      await tx`UPDATE plugins SET status = 'active',
        approved_capabilities = ARRAY(SELECT jsonb_array_elements_text(
          (${JSON.stringify(m.requestedCapabilities ?? [])}::text)::jsonb)),
        approved_manifest_digest = ${releaseManifestDigest(m)} WHERE slug = ${p.slug}`;
    }
  });
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setInProcessJobLauncher((kind) => inProcessJobLauncher({ adapter, registry }, kind));
  const report = await bootstrap({
    infra: { adapter, registry, stagingAdapter: stagingPublicAdapter(STAGING_URL) },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: PLUGINS.map((definition) => ({ definition })),
  });
  expect(report.failed).toEqual([]);
  ({ prices: pricesId, contact: contactId } = await pages());

  // A Stage's site-search index: its run and its ready release in the staging store.
  const store = scopedStore(directoryStore(join(root, "staging")), "site-search/pages");
  const writes: Promise<void>[] = [];
  const built = await buildRelease(
    [
      {
        id: pricesId,
        title: "Preise",
        path: "/preise/",
        text: "Das Starter-Paket kostet 49 Euro im Monat.",
      },
      {
        id: contactId,
        title: "Kontakt",
        path: "/t1655-kontakt/",
        text: "Wir antworten am selben Tag.",
      },
    ].map((p) => ({
      id: p.id,
      lang: "de",
      values: {
        title: p.title,
        short_title: "",
        description: "",
        breadcrumb: "",
        sections: [{ anchor: "a", heading: p.title, text: p.text }],
        reduced: [],
        url: p.path,
        page_type: "",
        terms: [],
      },
    })),
    {
      schema: { fields: siteSearch.collections?.pages?.fields as never },
      sink: (name, data) => void writes.push(store.write(name, data, { immutable: true })),
      profile: {
        weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
        boosts: [],
        synonyms: {},
        bestBets: {},
        protectedTerms: [],
        typos: true,
        compounds: true,
        prefix: true,
        crossLanguage: false,
        semantic: null,
        suggestions: {},
      },
    },
  );
  await Promise.all(writes);
  runId = crypto.randomUUID();
  const searchId = await pluginId("site-search");
  await onDb(ADMIN_URL, async (tx) => {
    await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at)
             SELECT ${runId}::uuid, t.id, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded', now(), now()
             FROM deploy_targets t WHERE t.name = 'staging'`;
    await tx`INSERT INTO collection_releases (run_id, plugin_id, collection, state, release_key, finished_at)
             VALUES (${runId}::uuid, ${searchId}::uuid, 'pages', 'ready', ${built.file}, now())`;
  });
}, 120_000);

afterAll(async () => {
  if (runId)
    await onDb(ADMIN_URL, async (tx) => {
      await tx`DELETE FROM collection_releases WHERE run_id = ${runId}::uuid`;
      await tx`DELETE FROM deploy_runs WHERE id = ${runId}::uuid`;
    });
  await removeSite();
  for (const r of restore.reverse()) await r();
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetCollectionStores();
  resetPluginHost();
  await adapter.close();
  await rm(root, { recursive: true, force: true });
});

describe("the site assistant on the admin side (#1655)", () => {
  it("is activated only after site-search and while the visitor AI can run", async () => {
    await onDb(ADMIN_URL, async (tx) => {
      await tx`UPDATE plugins SET status = 'awaiting_activation' WHERE slug = 'site-assistant'`;
      await tx`UPDATE plugins SET status = 'disabled' WHERE slug = 'site-search'`;
    });
    try {
      const noSearch = await execute(registry, adapter, SYSTEM, "plugins.prepare_activation", {
        slug: "site-assistant",
      });
      expect(noSearch.ok).toBe(false);
      expect(JSON.stringify(noSearch.ok ? null : noSearch.error)).toContain("site-search");
      await onDb(
        ADMIN_URL,
        (tx) => tx`UPDATE plugins SET status = 'active' WHERE slug = 'site-search'`,
      );
      const settings = await onDb(
        ADMIN_URL,
        async (tx) =>
          (
            (await tx`SELECT enabled FROM visitor_ai_settings WHERE id = 1`) as {
              enabled: boolean;
            }[]
          )[0],
      );
      expect(settings?.enabled).toBe(false);
      const noAi = await execute(registry, adapter, SYSTEM, "plugins.prepare_activation", {
        slug: "site-assistant",
      });
      expect(noAi.ok).toBe(false);
      expect(JSON.stringify(noAi.ok ? null : noAi.error)).toContain("propose_set_visitor_ai");
    } finally {
      await onDb(
        ADMIN_URL,
        (tx) =>
          tx`UPDATE plugins SET status = 'active' WHERE slug IN ('site-search', 'site-assistant')`,
      );
    }
  });

  it("runs only the conversation's declared tools, on the Stage's release", async () => {
    const assistant = loadedPlugins.bySlug("site-assistant");
    if (!assistant) throw new Error("site-assistant is not loaded");
    const tools = makePluginChatTools(assistant, hostInfra());
    const found = await tools.run(
      "ask",
      { plugin: "site-search", operation: "search" },
      { query: "Starter-Paket" },
      { lang: "de", runId },
    );
    expect(found.state).toBe("ready");
    expect(found.hits.map((h) => h.id)).toEqual([pricesId]);
    expect(found.hits[0]).toMatchObject({ url: "/preise/", title: "Preise" });
    const read = await tools.run(
      "ask",
      { plugin: "site-search", operation: "read" },
      { url: "/preise/" },
      { lang: "de", runId },
    );
    expect(read.hits.map((h) => h.id)).toEqual([pricesId]);
    // Not a tool of the conversation: site-search's suggest, another conversation.
    await expect(
      tools.run(
        "ask",
        { plugin: "site-search", operation: "suggest" },
        { query: "x" },
        { lang: "de", runId },
      ),
    ).rejects.toThrow("only the tools a conversation declares run");
    await expect(
      tools.run(
        "chat",
        { plugin: "site-search", operation: "search" },
        { query: "x" },
        { lang: "de", runId },
      ),
    ).rejects.toThrow('declares no conversation "chat"');
    // Another run's index is not there.
    const other = await tools.run(
      "ask",
      { plugin: "site-search", operation: "search" },
      { query: "Starter" },
      { lang: "de", runId: crypto.randomUUID() },
    );
    expect(other.state).toBe("none");
  });

  it("audits the test questions and the contact page against the Stage's index", async () => {
    const [list] = (
      await ok<{ lists: { id: string }[] }>("lists.upsert_many", {
        lists: [
          {
            slug: "t1655-tests",
            name: "T1655 tests",
            purpose: "The site assistant's test questions.",
            type: "site-assistant-test-questions",
            items: [
              {
                node: "question",
                values: {
                  question: "Was kostet das Starter-Paket?",
                  expect: { href: `caelo:page/${pricesId}` },
                },
              },
              {
                node: "question",
                values: {
                  question: "Gibt es Rabatte für Schulen?",
                  expect: { href: `caelo:page/${pricesId}` },
                },
              },
              { node: "question", values: { question: "Was kostet das Paket?" } },
              { node: "question", values: { question: "Wann ist Weihnachten?" } },
            ],
          },
        ],
      })
    ).lists;
    await ok("plugin_config.update", {
      pluginSlug: "site-assistant",
      patch: { lists: { test_questions: list?.id }, assistant: { handoff_page: null } },
    });
    const quiet = await plugin<{ findings: { rule: string; message: string }[] }>("audit", {
      runId,
    });
    expect(quiet.findings.map((f) => f.rule).sort()).toEqual([
      "assistant-off-topic-found",
      "assistant-test-missed",
    ]);
    expect(quiet.findings.find((f) => f.rule === "assistant-test-missed")?.message).toContain(
      "Rabatte",
    );
    expect(quiet.findings.find((f) => f.rule === "assistant-off-topic-found")?.message).toContain(
      "Was kostet das Paket?",
    );

    // The contact page: found while published, an error once it is not.
    await ok("plugin_config.update", {
      pluginSlug: "site-assistant",
      patch: { assistant: { handoff_page: contactId } },
    });
    const withContact = await plugin<{ findings: { rule: string }[] }>("audit", { runId });
    expect(withContact.findings.map((f) => f.rule)).not.toContain("assistant-handoff-unfindable");
    expect(withContact.findings.map((f) => f.rule)).not.toContain("assistant-handoff-missing");
    await ok("plugin_config.update", {
      pluginSlug: "site-assistant",
      patch: { assistant: { handoff_page: crypto.randomUUID() } },
    });
    const missing = await plugin<{ findings: { rule: string; severity: string }[] }>("audit", {
      runId,
    });
    expect(missing.findings.find((f) => f.rule === "assistant-handoff-missing")?.severity).toBe(
      "error",
    );
  });

  it("folds negative ratings into gaps the AI reads as untrusted data", async () => {
    const id = await pluginId("site-assistant");
    const day = new Date().toISOString().slice(0, 10);
    // The plugin's own storage outlives a run: start from none.
    await onDb(ADMIN_URL, async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
      await tx`SELECT set_config('caelo.plugin_id', ${id}, true)`;
      await tx`DELETE FROM plugin_site_assistant.gaps`;
    });
    await onDb(PUBLIC_URL, async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
      await tx`SELECT set_config('caelo.plugin_id', ${id}, true)`;
      await tx`DELETE FROM plugin_site_assistant.feedback`;
      for (const [kind, question] of [
        ["unanswered", "Liefert ihr in die Schweiz?"],
        ["unanswered", "Versand in die Schweiz?"],
        ["not_helpful", "Was kostet der Versand in die Schweiz"],
        ["unanswered", "Versandkosten Schweiz?"],
        ["helpful", "Was kostet das Starter-Paket?"],
      ] as const)
        await tx`INSERT INTO plugin_site_assistant.feedback (kind, question, lang, day)
                 VALUES (${kind}, ${question}, 'de', ${day})`;
    });
    const { run } = await ok<{ run: { id: string } }>("plugin_batches.start", {
      pluginSlug: "site-assistant",
      operation: "gaps",
    });
    let done: { state: string; result: unknown; error: string | null } | undefined;
    for (let i = 0; i < 600 && !done; i++) {
      const r = await ok<{
        runs: { id: string; state: string; result: unknown; error: string | null }[];
      }>("plugin_batches.list", { pluginSlug: "site-assistant" });
      const mine = r.runs.find((x) => x.id === run.id);
      if (mine && !["queued", "running"].includes(mine.state)) done = mine;
      else await Bun.sleep(50);
    }
    expect({ state: done?.state, error: done?.error }).toEqual({ state: "completed", error: null });
    expect(done?.result).toMatchObject({ ratings: 5, gaps: 1, added: 1 });
    const gaps = await plugin<{
      untrusted: boolean;
      gaps: { words: string[]; samples: string[]; unanswered: number }[];
    }>("list_gaps", {});
    expect(gaps.untrusted).toBe(true);
    expect(gaps.gaps).toHaveLength(1);
    expect(gaps.gaps[0]?.words).toContain("schweiz");
    expect(gaps.gaps[0]?.samples.length).toBeGreaterThan(0);
    await onDb(PUBLIC_URL, async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
      await tx`SELECT set_config('caelo.plugin_id', ${id}, true)`;
      await tx`DELETE FROM plugin_site_assistant.feedback`;
    });
  });
});
