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
 * - the staging gateway reads only the staging store;
 * - #1650 semantic search: a release embedded natively (as the index job
 *   does) answers a query with no word in common through the query's
 *   WebAssembly vector, fused with the word ranking; a release embedded
 *   with a model this gateway's catalog lacks answers 503, never a search
 *   without its meaning half. The real-model part runs when the model is
 *   fetched (packages/models testing.ts; CI requires it).
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseProjectionForTests, stagingPublicAdapter } from "@caelo-cms/admin-core";
import { buildRelease, directoryStore, scopedStore } from "@caelo-cms/collection-index";
import { modelsForTests } from "@caelo-cms/models";
import { createNativeEmbedder } from "@caelo-cms/models/native";
import {
  bootstrap,
  bootstrapDispatchOnly,
  resetDispatchOnlyHost,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  type EmbeddingModel,
  embeddingModel,
  GATEWAY_REFRESH_PATH,
  GATEWAY_REFRESH_TOKEN_HEADER,
  gatewayRefreshAudience,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { GatewayCollections, settlesWithin } from "./collections.js";
import {
  idTokenTestKey,
  signIdTokenForTests,
  testRefreshPingVerifier,
} from "./refresh-ping.test-helpers.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
  setRefreshPingVerifier,
} from "./server.js";
import { registerTestLiveOrigin } from "./test-support.js";

const STAGING_ADAPTER = stagingPublicAdapter(process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL ?? "");
const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t1649-search";
const MODEL = embeddingModel(DEFAULT_EMBEDDING_MODEL_ID) as EmbeddingModel;
const MODELS = modelsForTests(MODEL);

const SEMANTIC_FIELDS = {
  title: { kind: "text", prefix: true },
  sections: { kind: "passages", vector: true },
  url: { kind: "keyword" },
} as const;
const semanticCollection = {
  description: "Pages with vectors.",
  fields: SEMANTIC_FIELDS,
  vectorModelConfig: "semantic_model",
  maxDocuments: 1000,
  maxDocumentBytes: 100_000,
};
const semanticSearch = (name: string, collection: string) => ({
  name,
  kind: "search" as const,
  collection,
  description: "Search by meaning.",
  returns: ["url", "title"],
  snippet: "sections",
});

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
    semantic: semanticCollection,
    unknown_model: semanticCollection,
    // #1651 — the words other pages link a page with.
    anchors: {
      description: "Link texts and the page each names.",
      fields: {
        text: { kind: "text" },
        target: { kind: "keyword" },
        sources: { kind: "number" },
      },
      maxDocuments: 1000,
      maxDocumentBytes: 10_000,
    },
  },
  config: {
    semantic_model: {
      type: "catalogModel",
      purpose: "embedding",
      label: "Model",
      description: "The model semantic search embeds with.",
      effect: "rebuild",
      default: DEFAULT_EMBEDDING_MODEL_ID,
    },
  },
  collectionOperations: [
    semanticSearch("semantic_search", "semantic"),
    semanticSearch("unknown_search", "unknown_model"),
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
      name: "linked",
      kind: "search",
      collection: "pages",
      description: "Site search with link texts.",
      returns: ["url", "title"],
      anchors: { collection: "anchors", target: "target", sources: "sources" },
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
let semanticKey = "";
let anchorsKey = "";
let unknownKey = "";
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

const semanticPage = (id: string, title: string, url: string, text: string) => ({
  id,
  lang: "de",
  values: { title, sections: [{ anchor: "inhalt", heading: title, text }], url },
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

  // #1650 — releases with vectors: one embedded as the index job does, one
  // stamped with a model no catalog has.
  const semanticProfile = {
    weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
    boosts: [],
    synonyms: {},
    bestBets: {},
    protectedTerms: [],
    typos: true,
    compounds: true,
    prefix: true,
    crossLanguage: false,
    semantic: { weight: 1, minSimilarity: 0.2 },
    suggestions: {},
  };
  const semanticPages = [
    semanticPage(
      "de-preise",
      "Preise",
      "/preise/",
      "Starter für 49 € im Monat, Agentur für 499 €. Monatlich kündbar.",
    ),
    semanticPage(
      "de-versand",
      "Versand",
      "/versand/",
      "Innerhalb Deutschlands liefern wir in zwei bis vier Werktagen.",
    ),
    semanticPage(
      "de-ausweis",
      "Personalausweis",
      "/ausweis/",
      "Ist Ihr Ausweis gestohlen worden, melden Sie das sofort im Bürgerbüro.",
    ),
    semanticPage(
      "de-rueckgabe",
      "Rückgabe",
      "/rueckgabe/",
      "Den Retourenschein drucken Sie im Kundenkonto aus.",
    ),
  ];
  const publish = async (collection: string, built: { file: string }) => {
    await onDb(PUBLIC_ADMIN_URL as string, async (tx) => {
      await tx`INSERT INTO published_collections (plugin_id, collection, release_key) VALUES (${pluginId}::uuid, ${collection}, ${built.file})`;
    });
  };
  const sinkFor = (collection: string, w: Promise<void>[]) => {
    const target = scopedStore(directoryStore(join(root, "live")), `${SLUG}/${collection}`);
    return (name: string, data: Uint8Array) =>
      void w.push(target.write(name, data, { immutable: true }));
  };
  const wa: Promise<void>[] = [];
  const anchors = await buildRelease(
    [{ id: "a1", lang: "de", values: { text: "Kosten", target: "de-logfile", sources: 4 } }],
    {
      schema: { fields: fixture.collections?.anchors?.fields as never },
      sink: sinkFor("anchors", wa),
      profile: {
        weights: { text: 1 },
        boosts: [],
        synonyms: {},
        bestBets: {},
        protectedTerms: [],
        typos: false,
        compounds: false,
        prefix: false,
        crossLanguage: false,
        semantic: null,
        suggestions: {},
      },
    },
  );
  await Promise.all(wa);
  anchorsKey = anchors.file;
  await publish("anchors", anchors);
  if (MODELS.dir) {
    const embedder = await createNativeEmbedder(MODEL, { dir: MODELS.dir, threads: 2 });
    const w: Promise<void>[] = [];
    const semantic = await buildRelease(semanticPages, {
      schema: { fields: SEMANTIC_FIELDS as never },
      sink: sinkFor("semantic", w),
      profile: semanticProfile,
      vectorModel: { id: embedder.fingerprint, dims: MODEL.dims },
      embed: (texts) => embedder.embed(texts, "passage"),
    });
    await Promise.all(w);
    await embedder.release();
    semanticKey = semantic.file;
    await publish("semantic", semantic);
  }
  const w2: Promise<void>[] = [];
  const unknown = await buildRelease(semanticPages, {
    schema: { fields: SEMANTIC_FIELDS as never },
    sink: sinkFor("unknown_model", w2),
    profile: semanticProfile,
    vectorModel: { id: "retired-model@000000000000", dims: MODEL.dims },
    embed: async (texts) => texts.map(() => new Float32Array(MODEL.dims).fill(1)),
  });
  await Promise.all(w2);
  unknownKey = unknown.file;
  await publish("unknown_model", unknown);

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

describe("semantic search in the gateway (#1650)", () => {
  if (MODELS.required) {
    it("the model is fetched (CAELO_MODELS=required)", () => {
      expect(MODELS.dir).not.toBeNull();
    });
  }
  const live = (name: string, fn: () => Promise<void>) =>
    it.skipIf(MODELS.dir === null)(name, fn, 60_000);

  live("finds a page by meaning when no word matches, showing its closest passage", async () => {
    const r = await json(
      `/api/plugin/${SLUG}/semantic_search?q=${encodeURIComponent("Was kostet das?")}&lang=de&release=${semanticKey}`,
    );
    expect(r.status).toBe(200);
    const hits = r.body.hits as { url: string; snippet: { anchor: string } | null }[];
    expect(hits[0]?.url).toBe("/preise/");
    expect(hits[0]?.snippet?.anchor).toBe("inhalt");
    expect(r.response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=3600");
  });

  live("keeps the page its words name first", async () => {
    const r = await json(
      `/api/plugin/${SLUG}/semantic_search?q=Versand&lang=de&release=${semanticKey}`,
    );
    expect((r.body.hits as { url: string }[])[0]?.url).toBe("/versand/");
    const stolen = await json(
      `/api/plugin/${SLUG}/semantic_search?q=${encodeURIComponent("Ausweis geklaut")}&lang=de&release=${semanticKey}`,
    );
    expect((stolen.body.hits as { url: string }[])[0]?.url).toBe("/ausweis/");
  });

  it("refuses a release embedded with a model this gateway's catalog lacks", async () => {
    const r = await json(
      `/api/plugin/${SLUG}/unknown_search?q=Preise&lang=de&release=${unknownKey}`,
    );
    expect(r.status).toBe(503);
    expect((r.body.error as { kind: string; message: string }).kind).toBe("ModelUnavailable");
    expect((r.body.error as { message: string }).message).toMatch(/retired-model@000000000000/);
  });
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

  it("a search over link texts is named by both releases, and caches only under the pair", async () => {
    const named = await json(`/api/plugin/${SLUG}/linked/release`);
    const pair = `${releaseKey}+${anchorsKey}`;
    expect(named.body).toEqual({ release: pair });
    // The pages release alone no longer names the answer: a new anchors
    // release must not be served from a cache entry of the old one.
    const alone = await handleRequest(
      get(`/api/plugin/${SLUG}/linked?q=Kosten&lang=de&release=${releaseKey}`),
    );
    expect(alone.status).toBe(409);
    expect(((await alone.json()) as { release: string }).release).toBe(pair);
    const r = await handleRequest(
      get(`/api/plugin/${SLUG}/linked?q=Kosten&lang=de&release=${encodeURIComponent(pair)}`),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("s-maxage");
    // Only another page's link text says "Kosten" about the logfile page.
    const body = (await r.json()) as { release: string; hits: { url: string }[] };
    expect(body.release).toBe(pair);
    expect(body.hits.map((h) => h.url)).toContain("/logfile/");
  });

  it("the search path writes nothing to the database, answered or failed", async () => {
    const logged = () =>
      onDb(
        PUBLIC_ADMIN_URL as string,
        async (tx) =>
          (
            (await tx`SELECT count(*)::int AS n FROM gateway_request_log WHERE plugin_slug = ${SLUG}`) as {
              n: number;
            }[]
          )[0]?.n ?? 0,
      );
    const before = await logged();
    for (const path of [
      `/api/plugin/${SLUG}/search?q=Preise&lang=de&release=${releaseKey}`,
      `/api/plugin/${SLUG}/suggest?q=Pr&lang=de`,
      `/api/plugin/${SLUG}/search?q=Preise&lang=de&release=another`,
      `/api/plugin/${SLUG}/search/release`,
    ]) {
      const r = await handleRequest(get(path));
      expect(r.status).toBeLessThan(500);
      await r.arrayBuffer();
    }
    expect(await logged()).toBe(before);
  });

  // #1745 — searchVIU's first search on a cold gateway took 11 s, and
  // one lost its instance: the warm-up `/release` started ran after its
  // answer, on request-billed CPU, so the search paid for all of it. The
  // route now holds its request until the warm-up is done
  // (collections-warm.test.ts covers what the warm-up does).
  it("/release answers once the release, its index and (for a search) the query model are loaded", async () => {
    let finish = () => {};
    const done = new Promise<void>((ok) => {
      finish = ok;
    });
    const warm = spyOn(GatewayCollections.prototype, "warm").mockImplementation(() => done);
    try {
      const answer = handleRequest(get(`/api/plugin/${SLUG}/linked/release`));
      expect(await settlesWithin(answer, 300)).toBe(false);
      // The search's collection with the model, its link texts' as well.
      const calls = warm.mock.calls.map(([slug, collection, key, options]) => ({
        slug,
        collection,
        key,
        model: options?.embedder !== undefined,
      }));
      expect(calls).toEqual([
        { slug: SLUG, collection: "pages", key: releaseKey, model: true },
        { slug: SLUG, collection: "anchors", key: anchorsKey, model: true },
      ]);
      finish();
      const r = await answer;
      expect(r.status).toBe(200);
      expect(((await r.json()) as { release: string }).release).toBe(`${releaseKey}+${anchorsKey}`);
      // A read needs no query model.
      warm.mockClear();
      expect((await handleRequest(get(`/api/plugin/${SLUG}/read/release`))).status).toBe(200);
      expect(warm.mock.calls.map(([, c, , o]) => [c, o?.embedder !== undefined])).toEqual([
        ["pages", false],
      ]);
    } finally {
      warm.mockRestore();
    }
  });

  it("the admin's refresh ping opens the published releases, without the query model", async () => {
    const key = idTokenTestKey("google-key-warm");
    const audience = gatewayRefreshAudience("test", "live");
    setRefreshPingVerifier(testRefreshPingVerifier(key, audience));
    const warm = spyOn(GatewayCollections.prototype, "warm").mockImplementation(async () => {});
    try {
      const r = await handleRequest(
        new Request(`http://localhost${GATEWAY_REFRESH_PATH}`, {
          method: "POST",
          headers: { [GATEWAY_REFRESH_TOKEN_HEADER]: signIdTokenForTests(key, { aud: audience }) },
        }),
      );
      expect(r.status).toBe(200);
      const warmed = new Set(warm.mock.calls.map(([, collection, k]) => `${collection}:${k}`));
      // Every published release an operation answers from (the semantic one
      // only where the model is fetched, see above).
      expect(warmed).toEqual(
        new Set([
          `pages:${releaseKey}`,
          `anchors:${anchorsKey}`,
          ...(semanticKey ? [`semantic:${semanticKey}`] : []),
          `unknown_model:${unknownKey}`,
        ]),
      );
      expect(warm.mock.calls.every(([, , , options]) => options?.embedder === undefined)).toBe(
        true,
      );
    } finally {
      warm.mockRestore();
      setRefreshPingVerifier(null);
    }
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
