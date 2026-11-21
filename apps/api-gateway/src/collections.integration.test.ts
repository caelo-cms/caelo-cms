// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R3, issue #1649) — declarative collection operations in the
 * gateway, against its real database identity (public_role), with a
 * dispatch-only plugin host and a release in a live collection store:
 *
 * - search ranks, snippets, highlights, pins best bets, expands synonyms,
 *   corrects typos and filters by language; suggest answers the curated
 *   list for an empty field and documents while typing; read finds a
 *   document by its URL;
 * - an answer for the current release is CDN-cacheable and sets no cookie;
 *   one without a release is uncached; one for another release is a 409
 *   with the current key; `/release` names the key uncached;
 * - limits: too many words is a 400; an unknown operation a 404; no
 *   published release a 503;
 * - the staging gateway reads only the staging store.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseProjectionForTests, stagingPublicAdapter } from "@caelo-cms/admin-core";
import { buildRelease, directoryStore, scopedStore } from "@caelo-cms/collection-index";
import {
  bootstrap,
  bootstrapDispatchOnly,
  resetDispatchOnlyHost,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { GatewayCollections } from "./collections.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "./server.js";
import { registerTestLiveOrigin } from "./test-support.js";

const STAGING_ADAPTER = stagingPublicAdapter(process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL ?? "");
const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t1649-search";

const fixture = definePlugin({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["collections"],
  collections: {
    pages: {
      description: "Pages for the site search.",
      fields: {
        title: { kind: "text", prefix: true },
        sections: { kind: "passages" },
        url: { kind: "keyword" },
        page_type: { kind: "keyword", facet: true },
      },
      maxDocuments: 1000,
      maxDocumentBytes: 100_000,
    },
  },
  collectionOperations: [
    {
      name: "search",
      kind: "search",
      collection: "pages",
      description: "Site search.",
      returns: ["url", "title"],
      snippet: "sections",
      filters: ["page_type"],
      facets: ["page_type"],
    },
    {
      name: "suggest",
      kind: "suggest",
      collection: "pages",
      description: "Suggestions.",
      returns: ["url", "title"],
    },
    {
      name: "read",
      kind: "read",
      collection: "pages",
      description: "A page by URL.",
      by: "url",
      returns: ["url", "title"],
      passages: "sections",
    },
  ],
  operations: { noop: async () => ({}) },
});

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let pluginId = "";
let root = "";
let releaseKey = "";
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

async function cleanup(): Promise<void> {
  resetPluginHost();
  resetDispatchOnlyHost();
  await onDb(ADMIN_URL as string, async (tx) => {
    await tx`DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
  });
  await onDb(PUBLIC_ADMIN_URL as string, async (tx) => {
    await tx`DELETE FROM published_collections`;
  });
}

const page = (id: string, title: string, url: string, text: string, pageType = "page") => ({
  id,
  lang: id.startsWith("en") ? "en" : "de",
  values: {
    title,
    sections: [{ anchor: "inhalt", heading: title, text }],
    url,
    page_type: pageType,
  },
});

let ip = 0;
function get(path: string): Request {
  ip++;
  return new Request(`http://localhost${path}`, {
    headers: { "X-Forwarded-For": `198.51.100.${ip % 250}, 34.120.0.1` },
  });
}

async function json(
  path: string,
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const response = await handleRequest(get(path));
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    response,
  };
}

beforeAll(async () => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "2";
  await cleanup();
  root = await mkdtemp(join(tmpdir(), "caelo-t1649-"));
  for (const [k, v] of Object.entries({
    CAELO_COLLECTIONS_LIVE_STORE: `file://${root}/live`,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  })) {
    envBefore[k] = process.env[k];
    process.env[k] = v;
  }
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const adminReport = await bootstrap({
    infra: { adapter: adminAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: fixture }],
  });
  expect(adminReport.failed).toEqual([]);
  pluginId = await onDb(
    ADMIN_URL as string,
    async (tx) =>
      ((await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as { id: string }[])[0]
        ?.id ?? "",
  );
  await registerTestLiveOrigin(ADMIN_URL as string);
  await releaseProjectionForTests(adminAdapter, STAGING_ADAPTER, new Map([[SLUG, null]]));
  resetPluginHost();

  // The release the index job would have written and Publish live copied.
  const live = scopedStore(directoryStore(join(root, "live")), `${SLUG}/pages`);
  const writes: Promise<void>[] = [];
  const built = await buildRelease(
    [
      page(
        "de-preise",
        "Preise",
        "/preise/",
        "Pakete für Agenturen, monatlich kündbar.",
        "product",
      ),
      page("de-blog", "Blog", "/blog/", "Ein Artikel über Rabatte und Angebote im Handel."),
      page(
        "de-logfile",
        "Logfile Analyse",
        "/logfile/",
        "Die Logfile Analyse zeigt, was Crawler sehen.",
        "product",
      ),
      page("en-pricing", "Pricing", "/en/pricing/", "Plans for agencies."),
    ],
    {
      schema: { fields: fixture.collections?.pages?.fields as never },
      sink: (name, data) => void writes.push(live.write(name, data, { immutable: true })),
      profile: {
        weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
        boosts: [],
        synonyms: { de: { kosten: ["Preise"] } },
        bestBets: { de: [{ query: "Angebot", ids: ["de-blog"] }] },
        protectedTerms: [],
        typos: true,
        compounds: true,
        prefix: true,
        crossLanguage: false,
        semantic: null,
        suggestions: {
          de: [
            { text: "Preise", source: "curated" },
            { text: "Logfile Analyse", source: "curated" },
          ],
        },
      },
    },
  );
  await Promise.all(writes);
  releaseKey = built.file;
  await onDb(PUBLIC_ADMIN_URL as string, async (tx) => {
    await tx`INSERT INTO published_collections (plugin_id, collection, release_key) VALUES (${pluginId}::uuid, 'pages', ${releaseKey})`;
  });

  const urls = gatewayDatabaseUrls({
    PUBLIC_DATABASE_URL: PUBLIC_URL,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  });
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  const report = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: fixture }],
  });
  expect(report.failed).toEqual([]);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanup();
  await gatewayAdapter.close();
  await adminAdapter.close();
  await rm(root, { recursive: true, force: true });
});

describe("declarative collection operations in the gateway", () => {
  it("names the current release uncached", async () => {
    const r = await json(`/api/plugin/${SLUG}/search/release`);
    expect(r.status).toBe(200);
    expect(r.body.release).toBe(releaseKey);
    expect(r.response.headers.get("cache-control")).toBe("no-store");
  });

  it("searches with snippets and highlights, cacheable and without a cookie", async () => {
    const r = await json(`/api/plugin/${SLUG}/search?q=Preis&lang=de&release=${releaseKey}`);
    expect(r.status).toBe(200);
    const hits = r.body.hits as {
      url: string;
      snippet: { anchor: string; text: { highlights: unknown[] } };
      titleHighlights: unknown[];
    }[];
    expect(hits[0]?.url).toBe("/preise/");
    expect(hits[0]?.titleHighlights).toEqual([[0, 6]]);
    expect(hits[0]?.snippet.anchor).toBe("inhalt");
    expect(r.response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=3600");
    expect(r.response.headers.get("set-cookie")).toBeNull();
    expect((r.body.facets as { page_type: unknown[] }).page_type).toEqual([
      { value: "product", count: 1 },
    ]);
  });

  it("answers without a release uncached and with another release a 409", async () => {
    const plain = await json(`/api/plugin/${SLUG}/search?q=Preis&lang=de`);
    expect(plain.status).toBe(200);
    expect(plain.response.headers.get("cache-control")).toBe("no-store");
    const moved = await json(
      `/api/plugin/${SLUG}/search?q=Preis&lang=de&release=release-000000000000000000000000.json`,
    );
    expect(moved.status).toBe(409);
    expect(moved.body.release).toBe(releaseKey);
  });

  it("pins best bets, expands synonyms, corrects typos and keeps to the visitor's language", async () => {
    const bet = await json(`/api/plugin/${SLUG}/search?q=angebot&lang=de&release=${releaseKey}`);
    expect((bet.body.hits as { url: string; pinned?: boolean }[])[0]).toMatchObject({
      url: "/blog/",
      pinned: true,
    });
    const syn = await json(`/api/plugin/${SLUG}/search?q=Kosten&lang=de&release=${releaseKey}`);
    expect((syn.body.hits as { url: string }[])[0]?.url).toBe("/preise/");
    const typo = await json(`/api/plugin/${SLUG}/search?q=Logfiel&lang=de&release=${releaseKey}`);
    expect(typo.body.corrections).toEqual([{ from: "logfiel", to: "logfile" }]);
    const en = await json(`/api/plugin/${SLUG}/search?q=Pricing&lang=de&release=${releaseKey}`);
    expect(en.body.hits).toEqual([]);
    const filtered = await json(
      `/api/plugin/${SLUG}/search?q=Logfile&lang=de&f.page_type=page&release=${releaseKey}`,
    );
    expect(filtered.body.hits).toEqual([]);
  });

  it("suggests the curated list for an empty field and documents while typing", async () => {
    const empty = await json(`/api/plugin/${SLUG}/suggest?q=&lang=de&release=${releaseKey}`);
    expect((empty.body.queries as { text: string }[]).map((q) => q.text)).toEqual([
      "Preise",
      "Logfile Analyse",
    ]);
    const typing = await json(`/api/plugin/${SLUG}/suggest?q=Logf&lang=de&release=${releaseKey}`);
    expect((typing.body.docs as { url: string }[])[0]?.url).toBe("/logfile/");
    expect((typing.body.queries as { text: string }[]).map((q) => q.text)).toEqual([
      "Logfile Analyse",
    ]);
  });

  it("reads a document by its URL, one passage when asked", async () => {
    const r = await json(
      `/api/plugin/${SLUG}/read?value=${encodeURIComponent("/preise/")}&passage=inhalt&release=${releaseKey}`,
    );
    const docs = r.body.documents as { title: string; sections: { anchor: string }[] }[];
    expect(docs[0]?.title).toBe("Preise");
    expect(docs[0]?.sections.map((s) => s.anchor)).toEqual(["inhalt"]);
  });

  it("search-as-you-type is not throttled by the write operations' budget", async () => {
    // 400 searches in a burst: past the generic per-operation burst of 300.
    const statuses = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const r = await handleRequest(
        get(`/api/plugin/${SLUG}/suggest?q=Lo&lang=de&release=${releaseKey}`),
      );
      statuses.add(r.status);
      await r.arrayBuffer();
    }
    expect([...statuses]).toEqual([200]);
  });

  it("refuses too many words, an unknown operation, and serves 503 without a release", async () => {
    const long = await json(
      `/api/plugin/${SLUG}/search?q=${encodeURIComponent("eins zwei drei vier fünf sechs sieben acht neun zehn elf")}&lang=de`,
    );
    expect(long.status).toBe(400);
    expect((await handleRequest(get(`/api/plugin/${SLUG}/nope?q=x&lang=de`))).status).toBe(404);
    await onDb(PUBLIC_ADMIN_URL as string, async (tx) => tx`DELETE FROM published_collections`);
    // A publish notification drops the cached key; the test plays it.
    const { dropPublishedState } = await import("./published-changes.js");
    dropPublishedState();
    expect((await handleRequest(get(`/api/plugin/${SLUG}/search?q=Preis&lang=de`))).status).toBe(
      503,
    );
  });

  it("the staging gateway reads only the staging store", async () => {
    const staging = new GatewayCollections("staging", {
      CAELO_COLLECTIONS_LIVE_STORE: `file://${root}/live`,
    });
    await expect(staging.release(SLUG, "pages", releaseKey)).rejects.toThrow(
      /CAELO_COLLECTIONS_STAGING_STORE is not set/,
    );
  });
});
