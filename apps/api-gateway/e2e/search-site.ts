// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1651) — a site with the site search, for the browser test
 * `apps/admin/e2e/site-search-visitor.browser.ts`.
 *
 * The real gateway, on its own database identity (public_role), answers
 * `/api/plugin/site-search/*` from a release written to a live collection
 * store with the plugin's own document builder; the pages are the markup
 * the plugin's skill teaches the AI to write, with the plugin's runtime
 * inline. One origin, like the load balancer's `/api/*` rule. Prints
 * `READY <port>` when it serves.
 *
 * #1707 — `/start-hash/` and `/suche-hash/` carry the form in hash mode
 * (`data-caelo-search-mode="hash"`, no `name` on the field), and
 * `/__test/requests` lists every page request the server saw, so a test
 * proves the query never reached it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerAdminOps,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "@caelo-cms/admin-core";
import { buildRelease, directoryStore, scopedStore } from "@caelo-cms/collection-index";
import {
  bootstrap,
  bootstrapDispatchOnly,
  releaseManifestDigest,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { manifestFromDefinition } from "@caelo-cms/plugin-sdk";
import siteSearch from "@caelo-cms/plugin-site-search";
import { RUNTIME_CSS, RUNTIME_JS } from "@caelo-cms/plugin-site-search/runtime";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "../src/server.js";
import { publishTestIndex, removeTestIndexes } from "./test-index.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const ADMIN_URL = required("ADMIN_DATABASE_URL");
const PUBLIC_ADMIN_URL = required("PUBLIC_ADMIN_DATABASE_URL");
const PUBLIC_URL = required("PUBLIC_DATABASE_URL");
const STAGING_ADAPTER = stagingPublicAdapter(required("PUBLIC_STAGING_ADMIN_DATABASE_URL"));
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = siteSearch.slug;

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

const root = mkdtempSync(join(tmpdir(), "caelo-e2e-1651-"));
process.env.CAELO_COLLECTIONS_LIVE_STORE = `file://${root}/live`;
process.env.CAELO_GATEWAY_ENVIRONMENT = "live";

// The admin under test discovered the shipped plugin (awaiting activation):
// this fixture is the Owner activating it, approving what it asks for, as
// plugins.activate does. A row a load finds keeps its status, so without
// this the release the gateway attaches from would not hold it.
// An existing row may hold the approval of an earlier build of the plugin:
// a changed manifest is a new artifact (#1332), so approve this one too.
const manifest = manifestFromDefinition(siteSearch);
const before = await onDb(ADMIN_URL, async (tx) => {
  const rows = (await tx`SELECT status, approved_capabilities, approved_manifest_digest
      FROM plugins WHERE slug = ${SLUG}`) as {
    status: string;
    approved_capabilities: string[] | null;
    approved_manifest_digest: string | null;
  }[];
  await tx`UPDATE plugins SET status = 'active',
    approved_capabilities = ARRAY(SELECT jsonb_array_elements_text(
      (${JSON.stringify(manifest.requestedCapabilities ?? [])}::text)::jsonb)),
    approved_manifest_digest = ${releaseManifestDigest(manifest)}
    WHERE slug = ${SLUG}`;
  return rows[0] ?? null;
});

async function restore(): Promise<void> {
  // List types a crashed run left behind belong to no plugin row any more.
  await onDb(ADMIN_URL, async (tx) => {
    await tx`DELETE FROM list_types WHERE slug LIKE 'site-search-%'
             AND (plugin_id IS NULL OR plugin_id NOT IN (SELECT id FROM plugins))`;
  });
  await removeTestIndexes(ADMIN_URL, [SLUG]);
  if (before)
    await onDb(ADMIN_URL, async (tx) => {
      const approved = JSON.stringify(before.approved_capabilities);
      await tx`UPDATE plugins SET status = ${before.status},
        approved_capabilities = CASE WHEN (${approved}::text)::jsonb = 'null'::jsonb THEN NULL
          ELSE ARRAY(SELECT jsonb_array_elements_text((${approved}::text)::jsonb)) END,
        approved_manifest_digest = ${before.approved_manifest_digest}
        WHERE slug = ${SLUG}`;
    });
  else
    await onDb(ADMIN_URL, async (tx) => {
      await tx`DELETE FROM site_snapshots WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM list_types WHERE slug LIKE 'site-search-%'`;
      await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    });
  await onDb(PUBLIC_ADMIN_URL, async (tx) => {
    await tx`DELETE FROM published_collections`;
  });
}

const PAGES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    path: "/preise/",
    title: "Preise",
    sections: [
      { anchor: "pakete", heading: "Pakete", text: "Monatlich kündbar, für Agenturen und Teams." },
      {
        anchor: "rabatte",
        heading: "Rabatte",
        text: "Für Bildungseinrichtungen gibt es Nachlass.",
      },
    ],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    path: "/kontakt/",
    title: "Kontakt",
    sections: [
      { anchor: "schreiben", heading: "Schreiben Sie uns", text: "Wir antworten am selben Tag." },
    ],
  },
];

async function prepare(): Promise<DatabaseAdapter> {
  const adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const adminRegistry = new OperationRegistry();
  registerAdminOps(adminRegistry);
  const report = await bootstrap({
    infra: { adapter: adminAdapter, registry: adminRegistry, stagingAdapter: STAGING_ADAPTER },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: siteSearch }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  const pluginId = await onDb(
    ADMIN_URL,
    async (tx) =>
      ((await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as { id: string }[])[0]
        ?.id as string,
  );
  // Release the main line as a Stage plus Publish live does, as loaded.
  await releaseProjectionForTests(adminAdapter, STAGING_ADAPTER, undefined, "as-loaded");

  // The release the index job would have built and Publish live copied.
  const live = scopedStore(directoryStore(join(root, "live")), `${SLUG}/pages`);
  const writes: Promise<void>[] = [];
  const built = await buildRelease(
    PAGES.map((p) => ({
      id: p.id,
      lang: "de",
      values: {
        title: p.title,
        short_title: "",
        description: "",
        breadcrumb: "",
        sections: p.sections,
        reduced: [],
        url: p.path,
        page_type: "",
        terms: [],
      },
    })),
    {
      schema: { fields: siteSearch.collections?.pages?.fields as never },
      sink: (name, data) => void writes.push(live.write(name, data, { immutable: true })),
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
        suggestions: { de: [{ text: "Was kostet es?", source: "curated" }] },
      },
    },
  );
  await Promise.all(writes);
  await publishTestIndex(
    { admin: ADMIN_URL, publicAdmin: PUBLIC_ADMIN_URL },
    adminAdapter,
    STAGING_ADAPTER,
    {
      pluginId,
      collection: "pages",
      releaseKey: built.file,
    },
  );
  resetPluginHost();
  await adminAdapter.close();

  const urls = gatewayDatabaseUrls({
    PUBLIC_DATABASE_URL: PUBLIC_URL,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  });
  const gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  const gw = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: siteSearch }],
  });
  if (gw.loaded.length !== 1)
    throw new Error(`the gateway did not attach site-search: ${JSON.stringify(gw)}`);
  return gatewayAdapter;
}

const FORM = `<form data-caelo-search action="/suche/" role="search">
  <input type="search" name="q" data-caelo-search-input aria-label="Suche">
  <ul data-caelo-search-suggestions hidden></ul>
  <button type="submit">Suchen</button>
</form>`;

/** #1707 — the same form in hash mode: the query travels in the fragment only. */
const HASH_FORM = `<form data-caelo-search data-caelo-search-mode="hash" action="/suche-hash/" role="search">
  <input type="search" data-caelo-search-input aria-label="Suche">
  <ul data-caelo-search-suggestions hidden></ul>
  <button type="submit">Suchen</button>
</form>`;

function page(body: string, form = FORM): Response {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fixture</title><style>${RUNTIME_CSS}</style></head><body>${form}${body}<script>${RUNTIME_JS}</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Every page request the server answered, as path and query (#1707). */
const pageRequests: string[] = [];

const RESULTS = `<main><section data-caelo-search-results>
  <p data-caelo-search-summary></p>
  <ol data-caelo-search-list></ol>
  <template data-caelo-search-hit><li><a data-field="link"><span data-field="title"></span></a><p data-field="snippet"></p></li></template>
  <button type="button" data-caelo-search-more hidden>Mehr</button>
</section>
<div data-caelo-plugin="site-search" data-page-id="x"><div data-caelo-search-popular data-counting="off" data-queries="{}" hidden></div></div></main>`;

function routes(pathname: string): Response {
  if (pathname === "/__test/requests") return Response.json(pageRequests);
  if (pathname === "/suche/") return page(RESULTS);
  if (pathname === "/suche-hash/")
    return page(`<a href="#main">Zum Inhalt</a>${RESULTS}`, HASH_FORM);
  if (pathname === "/start-hash/") return page("<main><h1>Start</h1></main>", HASH_FORM);
  const p = PAGES.find((x) => x.path === pathname);
  if (p)
    return page(
      `<main><h1>${p.title}</h1>${p.sections.map((s) => `<section id="${s.anchor}"><h2>${s.heading}</h2><p>${s.text}</p></section>`).join("")}</main>`,
    );
  if (pathname === "/") return page("<main><h1>Start</h1></main>");
  return new Response("not found", { status: 404 });
}

let gatewayAdapter: DatabaseAdapter;
try {
  // What a crashed run left behind (orphaned list types, a published index).
  await removeTestIndexes(ADMIN_URL, [SLUG]);
  await onDb(ADMIN_URL, async (tx) => {
    await tx`DELETE FROM list_types WHERE slug LIKE 'site-search-%'
             AND (plugin_id IS NULL OR plugin_id NOT IN (SELECT id FROM plugins))`;
  });
  await onDb(PUBLIC_ADMIN_URL, async (tx) => {
    await tx`DELETE FROM published_collections`;
  });
  gatewayAdapter = await prepare();
} catch (e) {
  await restore();
  rmSync(root, { recursive: true, force: true });
  throw e;
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req, srv) => {
    const { pathname, search } = new URL(req.url);
    if (!pathname.startsWith("/api/")) {
      if (!pathname.startsWith("/__test/")) pageRequests.push(pathname + search);
      return routes(pathname);
    }
    return handleRequest(req, { peerAddress: srv.requestIP(req)?.address ?? null });
  },
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await gatewayAdapter.close();
  await restore();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

console.log(`READY ${server.port}`);
