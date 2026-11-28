// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway's warm-up of a collection release (#1745). searchVIU's
 * first search on a cold gateway took 11 s, and one lost its instance: it
 * opened the release, read about 130 index files one by one from object
 * storage and loaded the query model inside the visitor's search, because
 * the warm-up `/release` started ran after its answer, on a CPU Cloud Run
 * gives an instance only while a request is open.
 *
 * {@link GatewayCollections.warm} now does all of it and resolves only when
 * it is done, so `/release` can hold its request for it (server.ts): the
 * index files are in memory afterwards (a query reads nothing from the
 * store), the model is loaded when the profile searches by meaning, and a
 * failure never rejects.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  directoryStore,
  FileCache,
  parseRelease,
  releaseFiles,
  scopedStore,
  searchText,
} from "@caelo-cms/collection-index";
import type { WarmableQueryEmbedder } from "@caelo-cms/plugin-host/gateway";
import { GatewayCollections, settlesWithin } from "./collections.js";

const SLUG = "t-warm";
const SCHEMA: CollectionSchema = {
  fields: {
    title: { kind: "text", prefix: true },
    sections: { kind: "passages", vector: true },
    url: { kind: "keyword" },
  },
};
const MODEL = { id: "fake-model@000000000001", dims: 8 };

const docs: CollectionDoc[] = Array.from({ length: 60 }, (_v, i) => ({
  id: `p${i}`,
  lang: "de",
  values: {
    title: `Seite ${i}`,
    sections: [{ anchor: "a", heading: `Thema ${i % 7}`, text: `Logfile Analyse Nummer ${i}.` }],
    url: `/p${i}/`,
  },
}));

const profile = (semantic: boolean) => ({
  weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
  boosts: [],
  synonyms: {},
  bestBets: {},
  protectedTerms: [],
  typos: true,
  compounds: true,
  prefix: true,
  crossLanguage: false,
  semantic: semantic ? { weight: 1, minSimilarity: 0.2 } : null,
  suggestions: {},
});

let root = "";
let semanticKey = "";
let wordsKey = "";

async function build(collection: string, semantic: boolean): Promise<string> {
  const target = scopedStore(directoryStore(join(root, "store")), `${SLUG}/${collection}`);
  const writes: Promise<void>[] = [];
  const built = await buildRelease(docs, {
    schema: SCHEMA,
    sink: (name, data) => void writes.push(target.write(name, data, { immutable: true })),
    embed: async (texts) => texts.map(() => Float32Array.from({ length: 8 }, (_x, j) => j + 1)),
    vectorModel: MODEL,
    profile: profile(semantic),
  });
  await Promise.all(writes);
  return built.file;
}

function collections(): GatewayCollections {
  return new GatewayCollections("live", {
    CAELO_COLLECTIONS_LIVE_STORE: `file://${join(root, "store")}`,
  });
}

/** An embedder whose model loads when the test says so. */
function deferredEmbedder(): {
  embedder: WarmableQueryEmbedder;
  asked: string[];
  finish: () => void;
} {
  const asked: string[] = [];
  let finish = () => {};
  const loaded = new Promise<void>((done) => {
    finish = done;
  });
  const embed = async () => new Float32Array(8);
  return {
    embedder: Object.assign(embed, {
      ready: async (fingerprint: string) => {
        asked.push(fingerprint);
        await loaded;
      },
    }),
    asked,
    finish: () => finish(),
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "caelo-warm-"));
  semanticKey = await build("pages", true);
  wordsKey = await build("words", false);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GatewayCollections.warm", () => {
  it("resolves only once the index is in memory and the query model has loaded", async () => {
    const c = collections();
    const model = deferredEmbedder();
    const warm = c.warm(SLUG, "pages", semanticKey, { embedder: model.embedder });
    expect(await settlesWithin(warm, 300)).toBe(false);
    expect(model.asked).toEqual([MODEL.id]);
    model.finish();
    expect(await settlesWithin(warm, 5_000)).toBe(true);

    // Every file a query needs is in memory: with the store gone, a search
    // still answers.
    await rename(join(root, "store"), join(root, "store-away"));
    try {
      const entry = await c.release(SLUG, "pages", semanticKey);
      const r = await searchText(entry.release, {
        text: "Logfile Analyse",
        lang: "de",
        weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
        limit: 10,
        typos: true,
      });
      expect(r.hits.length).toBe(10);
      const stored = await entry.release.segments[0]?.reader.stored(r.hits.map((h) => h.key));
      expect(stored?.size).toBe(10);
    } finally {
      await rename(join(root, "store-away"), join(root, "store"));
    }
  });

  // #1778 — the files wait on the network, the model on the CPU: the load
  // starts with the prefetch, not after it.
  it("starts loading the query model while the prefetch is still reading", async () => {
    const c = collections();
    const log = spyOn(console, "log").mockImplementation(() => {});
    let prefetchedBeforeModel: boolean | null = null;
    const ready = async (): Promise<void> => {
      prefetchedBeforeModel = log.mock.calls.some((a) =>
        String(a[0]).includes("index files in memory"),
      );
    };
    try {
      const embedder = Object.assign(async () => new Float32Array(8), { ready });
      await c.warm(SLUG, "pages", semanticKey, { embedder });
      expect(prefetchedBeforeModel).toBe(false);
      expect(log.mock.calls.some((a) => String(a[0]).includes("index files in memory"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("shares one prefetch between callers and logs it once", async () => {
    const c = collections();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await Promise.all([c.warm(SLUG, "words", wordsKey), c.warm(SLUG, "words", wordsKey)]);
      await c.warm(SLUG, "words", wordsKey);
      const lines = log.mock.calls.map((a) => String(a[0])).filter((l) => l.includes(wordsKey));
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/: \d+ index files in memory after \d+ ms \(cache \d+ MiB\)$/);
    } finally {
      log.mockRestore();
    }
  });

  // A full LRU cache (a large index, a few Publish lives later) must not
  // stop the next release's prefetch: the budget is what one prefetch
  // loads, not what the cache holds.
  it("prefetches a new release into a cache that is already full", async () => {
    // A cache exactly as large as the first release: its prefetch fills it.
    const store = scopedStore(directoryStore(join(root, "store")), `${SLUG}/words`);
    const manifest = parseRelease(await store.read(wordsKey));
    const files = await releaseFiles(manifest, new FileCache(store, 1 << 26));
    let bytes = 0;
    for (const f of files) bytes += (await store.read(f)).length;
    const c = new GatewayCollections("live", {
      CAELO_COLLECTIONS_LIVE_STORE: `file://${join(root, "store")}`,
      CAELO_COLLECTIONS_CACHE_MB: String(bytes / 1048576),
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await c.warm(SLUG, "words", wordsKey);
      await c.warm(SLUG, "pages", semanticKey);
      const loaded = log.mock.calls
        .map((a) => String(a[0]))
        .filter((l) => l.includes(semanticKey))
        .map((l) => Number(/: (\d+) index files/.exec(l)?.[1]));
      expect(loaded.length).toBe(1);
      expect(loaded[0]).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
    }
  });

  it("loads no model without an embedder, nor for a profile that does not search by meaning", async () => {
    const c = collections();
    const model = deferredEmbedder();
    await c.warm(SLUG, "pages", semanticKey);
    await c.warm(SLUG, "words", wordsKey, { embedder: model.embedder });
    expect(model.asked).toEqual([]);
  });

  it("never rejects: a release that cannot be opened is logged and left to the query", async () => {
    const c = collections();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await c.warm(SLUG, "pages", "release-000000000000000000000000.json");
      expect(String(error.mock.calls[0]?.[0])).toContain("could not be opened");
    } finally {
      error.mockRestore();
    }
  });
});

describe("settlesWithin", () => {
  it("says whether the work settled before the bound", async () => {
    expect(await settlesWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settlesWithin(new Promise(() => {}), 20)).toBe(false);
  });
});
