// SPDX-License-Identifier: MPL-2.0

/**
 * #1650 — the index job and the vector model: it embeds only when the
 * Stage named a model and the profile turns semantic search on, records the
 * model's fingerprint, and rebuilds (never extends) a release built with
 * another model. Embedders are stand-ins here; the real model's behaviour
 * is tested in packages/models and the parity test.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CollectionStore,
  directoryStore,
  FileCache,
  openRelease,
  parseRelease,
  readQueryVectors,
  scopedStore,
  searchVectors,
} from "@caelo-cms/collection-index";
import type { Embedder } from "@caelo-cms/models";
import { encodeChangeFile } from "@caelo-cms/plugin-host";
import type { SearchProfile } from "@caelo-cms/plugin-sdk";
import { DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModel } from "@caelo-cms/shared";
import type { PieceClaim } from "../ops/job_pieces.js";
import type { JobReporter, TaskSlot } from "../reporting-jobs/job-reporter.js";
import {
  type EmbedderSource,
  type IndexOptions,
  indexCollection,
  indexTasks,
  knownQueriesOf,
  type ShardClaims,
} from "./index-job.js";
import type { IndexTask } from "./ops.js";

const FIELDS = {
  title: { kind: "text" },
  sections: { kind: "passages", vector: true },
};

const profile = (semantic: SearchProfile["semantic"]): SearchProfile => ({
  weights: { title: 2, "sections.text": 1 },
  boosts: [],
  synonyms: {},
  bestBets: {},
  protectedTerms: [],
  typos: true,
  compounds: true,
  prefix: true,
  crossLanguage: false,
  semantic,
  knownQueries: {},
  suggestions: {},
});

/** A stand-in embedder: a vector from the text's characters, so similar texts are near. */
function fakeEmbedders(fingerprint: string): { source: EmbedderSource; embedded: string[] } {
  const embedded: string[] = [];
  const source: EmbedderSource = async (model: EmbeddingModel) =>
    ({
      model,
      fingerprint,
      embed: async (texts: readonly string[]) =>
        texts.map((t) => {
          embedded.push(t);
          const v = new Float32Array(model.dims);
          for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % model.dims] += 1;
          return v;
        }),
      release: async () => {},
    }) satisfies Embedder;
  return { source, embedded };
}

let root = "";
let store: CollectionStore;
let n = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caelo-index-job-"));
  store = directoryStore(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function change(c: Parameters<typeof encodeChangeFile>[0]): Promise<string> {
  const key = `t1650/pages/changes/${String(++n).padStart(4, "0")}.bin`;
  await store.write(key, encodeChangeFile(c), { immutable: true });
  return key;
}

function task(over: Partial<IndexTask>): IndexTask {
  return {
    pluginId: "00000000-0000-4000-8000-000000001650",
    slug: "t1650",
    collection: "pages",
    fields: FIELDS,
    schemaDigest: "digest-1",
    maxDocuments: 100,
    previousReleaseKey: null,
    previousSchemaDigest: null,
    vectorModel: DEFAULT_EMBEDDING_MODEL_ID,
    columns: [],
    changeKeys: [],
    ...over,
  };
}

const doc = (id: string, text: string) => ({
  id,
  lang: "de",
  values: { title: id, sections: [{ anchor: "a", heading: "", text }] },
});

/** One task alone, which builds: its release and statistics. */
async function build(t: IndexTask, embedders: EmbedderSource, opts: IndexOptions = {}) {
  const out = await indexCollection(store, t, { embedders, ...opts });
  if (out.kind !== "built") throw new Error(`expected a build, got ${out.kind}`);
  return out;
}

async function open(key: string) {
  const scoped = scopedStore(store, "t1650/pages");
  const manifest = parseRelease(await scoped.read(key));
  return openRelease(
    manifest,
    new FileCache({ read: (f) => scoped.read(f) }, Number.POSITIVE_INFINITY),
  );
}

describe("the index job's known queries (#1785)", () => {
  it("names each query of the profile once: known queries, suggestions, pinned results", () => {
    const p: SearchProfile = {
      ...profile({ weight: 1, minSimilarity: 0.2 }),
      knownQueries: { de: ["was kostet das", " Preise "], en: ["pricing"] },
      suggestions: { de: [{ text: "Preise", source: "curated" }] },
      bestBets: { de: [{ query: "Kontakt", ids: ["p1"] }] },
    };
    expect(knownQueriesOf(p)).toEqual(["Kontakt", "Preise", "pricing", "was kostet das"]);
    expect(knownQueriesOf(null)).toEqual([]);
  });

  it("embeds them as queries into the release, and keeps their vectors in the next one", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const withQueries = {
      ...profile({ weight: 1, minSimilarity: 0.2 }),
      knownQueries: { de: ["was kostet das"] },
    };
    const first = await build(
      task({
        changeKeys: [
          await change({
            upserts: [doc("p1", "Preise")],
            deletes: [],
            replaceAll: false,
            profile: withQueries,
          }),
        ],
      }),
      e.source,
    );
    expect(e.embedded).toContain("was kostet das");
    const scoped = scopedStore(store, "t1650/pages");
    const cache = new FileCache({ read: (f) => scoped.read(f) }, Number.POSITIVE_INFINITY);
    const vectors = await readQueryVectors(first.applied.manifest, cache);
    expect([...vectors.keys()]).toEqual(["was kostet das"]);
    e.embedded.length = 0;
    const second = await build(
      task({
        previousReleaseKey: first.applied.file,
        previousSchemaDigest: "digest-1",
        changeKeys: [
          await change({ upserts: [doc("p2", "Versand")], deletes: [], replaceAll: false }),
        ],
      }),
      e.source,
    );
    expect(e.embedded).not.toContain("was kostet das");
    expect([...(await readQueryVectors(second.applied.manifest, cache)).keys()]).toEqual([
      "was kostet das",
    ]);
  });
});

describe("the index job's vectors (#1650)", () => {
  it("embeds every passage when the Stage named a model and the profile wants it", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const keys = [
      await change({
        upserts: [doc("p1", "Preise und Pakete"), doc("p2", "Versand")],
        deletes: [],
        replaceAll: false,
        profile: profile({ weight: 1, minSimilarity: 0.2 }),
      }),
    ];
    const { applied, stats } = await build(task({ changeKeys: keys }), e.source);
    expect(applied.manifest.vectorModel).toEqual({ id: "granite@aaaaaaaaaaaa", dims: 384 });
    expect(stats).toMatchObject({
      vectorModel: "granite@aaaaaaaaaaaa",
      passagesEmbedded: 2,
      rebuilt: true,
    });
    const release = await open(applied.file);
    const vector = new Float32Array(384);
    for (const ch of "versand") vector[ch.charCodeAt(0) % 384] += 1;
    const hits = await searchVectors(release, { vector, limit: 1, minSimilarity: 0 });
    expect(hits).toHaveLength(1);
  });

  it("builds no vectors when semantic search is off in the profile or no model is named", async () => {
    const off = fakeEmbedders("granite@aaaaaaaaaaaa");
    const keys = [
      await change({
        upserts: [doc("p1", "Preise")],
        deletes: [],
        replaceAll: false,
        profile: profile(null),
      }),
    ];
    const a = await build(task({ changeKeys: keys }), off.source);
    expect(a.applied.manifest.vectorModel).toBeNull();
    expect(off.embedded).toEqual([]);
    const keys2 = [
      await change({
        upserts: [doc("p1", "Preise")],
        deletes: [],
        replaceAll: false,
        profile: profile({ weight: 1, minSimilarity: 0.2 }),
      }),
    ];
    const b = await build(task({ changeKeys: keys2, vectorModel: null }), off.source);
    expect(b.applied.manifest.vectorModel).toBeNull();
    expect(off.embedded).toEqual([]);
  });

  it("extends a release of the same model with only the changed passages", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const first = await build(
      task({
        changeKeys: [
          await change({
            upserts: [doc("p1", "Preise"), doc("p2", "Versand")],
            deletes: [],
            replaceAll: false,
            profile: profile({ weight: 1, minSimilarity: 0.2 }),
          }),
        ],
      }),
      e.source,
    );
    e.embedded.length = 0;
    const second = await build(
      task({
        changeKeys: [
          await change({ upserts: [doc("p3", "Rückgabe")], deletes: [], replaceAll: false }),
        ],
        previousReleaseKey: first.applied.file,
        previousSchemaDigest: "digest-1",
      }),
      e.source,
    );
    expect(second.stats).toMatchObject({ rebuilt: false, passagesEmbedded: 1 });
    expect(e.embedded).toEqual(["Rückgabe"]);
    expect(second.applied.manifest.vectorModel?.id).toBe("granite@aaaaaaaaaaaa");
  });

  it("rebuilds with every passage when the model changed", async () => {
    const a = fakeEmbedders("granite@aaaaaaaaaaaa");
    const first = await build(
      task({
        changeKeys: [
          await change({
            upserts: [doc("p1", "Preise"), doc("p2", "Versand")],
            deletes: [],
            replaceAll: false,
            profile: profile({ weight: 1, minSimilarity: 0.2 }),
          }),
        ],
      }),
      a.source,
    );
    const b = fakeEmbedders("granite@bbbbbbbbbbbb");
    const second = await build(
      task({
        changeKeys: [],
        previousReleaseKey: first.applied.file,
        previousSchemaDigest: "digest-1",
      }),
      b.source,
    );
    expect(second.stats).toMatchObject({
      rebuilt: true,
      passagesEmbedded: 2,
      vectorModel: "granite@bbbbbbbbbbbb",
    });
    expect(b.embedded.sort()).toEqual(["Preise", "Versand"]);
    expect(second.applied.manifest.vectorModel?.id).toBe("granite@bbbbbbbbbbbb");
  });

  it("rebuilds without vectors when semantic search is turned off", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const first = await build(
      task({
        changeKeys: [
          await change({
            upserts: [doc("p1", "Preise")],
            deletes: [],
            replaceAll: false,
            profile: profile({ weight: 1, minSimilarity: 0.2 }),
          }),
        ],
      }),
      e.source,
    );
    const second = await build(
      task({
        changeKeys: [],
        previousReleaseKey: first.applied.file,
        previousSchemaDigest: "digest-1",
        vectorModel: null,
      }),
      e.source,
    );
    expect(second.stats).toMatchObject({ rebuilt: true, vectorModel: null });
    expect(second.applied.manifest.vectorModel).toBeNull();
  });

  it("refuses a model the catalog does not have, naming the fix", async () => {
    const keys = [
      await change({
        upserts: [doc("p1", "Preise")],
        deletes: [],
        replaceAll: false,
        profile: profile({ weight: 1, minSimilarity: 0.2 }),
      }),
    ];
    await expect(
      build(task({ changeKeys: keys, vectorModel: "no-such-model" }), fakeEmbedders("x@y").source),
    ).rejects.toThrow(
      /no-such-model, which this release's catalog does not have: pick a model in Settings → Plugin settings/,
    );
  });
});

/**
 * Vector reuse and wide attempts. Before, every rebuild embedded every
 * passage and a changed page all of its passages; and one task embedded a
 * whole build, which for a 50,000-page site's first index (about 800,000
 * passages) runs past the job's hour.
 */
describe("the index job at scale", () => {
  const semantic = profile({ weight: 1, minSimilarity: 0.2 });
  const page = (id: string, texts: readonly string[]) => ({
    id,
    lang: "de",
    values: {
      title: id,
      sections: texts.map((text, i) => ({ anchor: `a${i}`, heading: "", text })),
    },
  });

  it("keeps every vector under the same model when a rebuild is for another reason", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const first = await build(
      task({
        changeKeys: [
          await change({
            upserts: [doc("p1", "Preise"), doc("p2", "Versand")],
            deletes: [],
            replaceAll: false,
            profile: semantic,
          }),
        ],
      }),
      e.source,
    );
    e.embedded.length = 0;
    // A plugin update changed the collection's fields: rebuilt from the documents.
    const second = await build(
      task({
        changeKeys: [],
        previousReleaseKey: first.applied.file,
        previousSchemaDigest: "digest-0",
      }),
      e.source,
    );
    expect(second.stats).toMatchObject({ rebuilt: true, passagesEmbedded: 0, passagesReused: 2 });
    expect(e.embedded).toEqual([]);
  });

  it("a changed page keeps the vectors of its unchanged passages", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const first = await build(
      task({
        changeKeys: [
          await change({
            upserts: [page("p1", ["Preise", "Pakete", "Kontakt"])],
            deletes: [],
            replaceAll: false,
            profile: semantic,
          }),
        ],
      }),
      e.source,
    );
    e.embedded.length = 0;
    const second = await build(
      task({
        changeKeys: [
          await change({
            upserts: [page("p1", ["Preise", "Pakete ab 49 Euro", "Kontakt"])],
            deletes: [],
            replaceAll: false,
          }),
        ],
        previousReleaseKey: first.applied.file,
        previousSchemaDigest: "digest-1",
      }),
      e.source,
    );
    expect(e.embedded).toEqual(["Pakete ab 49 Euro"]);
    expect(second.stats).toMatchObject({ rebuilt: false, passagesEmbedded: 1, passagesReused: 2 });
  });

  /** A first build with more distinct passages than one shard holds: 6,010 texts, 4 shards. */
  async function bigBuild(): Promise<IndexTask> {
    const docs = Array.from({ length: 601 }, (_, d) =>
      page(
        `p${d}`,
        Array.from({ length: 10 }, (_, s) => `Seite ${d} Abschnitt ${s}`),
      ),
    );
    return task({
      maxDocuments: 1_000,
      changeKeys: [
        await change({ upserts: docs, deletes: [], replaceAll: false, profile: semantic }),
      ],
    });
  }

  it("the lead names the shards, which exist, and how wide the build would run", async () => {
    const admin = fakePieces();
    const out = await build(await bigBuild(), fakeEmbedders("granite@aaaaaaaaaaaa").source, {
      claims: () => admin.claims("lead"),
    });
    // 6,010 texts: four shards of at most 2,000, two tasks' shares of 6,000.
    expect(admin.registered).toEqual([{ count: 4, done: [], wantedTasks: 2 }]);
    expect(out.stats).toMatchObject({ passagesEmbedded: 6_010 });
    expect([...admin.state.values()]).toEqual(["done", "done", "done", "done"]);
  });

  it("a helper embeds what it claims, the lead the rest, and the release is the one task's", async () => {
    const t = await bigBuild();
    const single = await build(t, fakeEmbedders("granite@aaaaaaaaaaaa").source, {
      claims: () => fakePieces().claims("lead"),
    });
    // The single build left its shards; the shared one must embed on its own.
    const shards = join(root, "t1650/pages/vectors");
    for (const f of await readdir(shards)) if (f.startsWith("v-")) await rm(join(shards, f));

    const admin = fakePieces({ helperClaims: 2 });
    await admin.claims("lead").register(4, [], 2);
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    // A helper takes two shards, then hears `stop`: it ends after its shard.
    await expect(
      indexCollection(store, t, {
        embedders: e.source,
        slot: HELPER,
        claims: () => admin.claims(`${HELPER.helper}:0`),
      }),
    ).rejects.toThrow(/stopped this helper/);
    const byHelper = e.embedded.length;
    expect(byHelper).toBeGreaterThan(2_000);
    const lead = await build(t, e.source, { claims: () => admin.claims("lead") });
    expect(new Set(e.embedded).size).toBe(6_010);
    expect(e.embedded.length).toBe(6_010);
    expect(lead.stats).toMatchObject({ passagesEmbedded: 6_010 });
    // Content-addressed files: the same release name is the same index.
    expect(lead.applied.file).toBe(single.applied.file);
  });

  it("the lead waits for a shard another task still embeds, and takes it over once its claim runs out", async () => {
    const t = await bigBuild();
    const admin = fakePieces();
    await admin.claims("lead").register(4, [], 2);
    // Somebody holds shard 0 and never reports it.
    admin.state.set(0, "claimed");
    let clock = 0;
    const out = await build(t, fakeEmbedders("granite@aaaaaaaaaaaa").source, {
      claims: () => ({ ...admin.claims("lead"), register: async () => {} }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // Its claim ran out meanwhile (ops/job_pieces.ts opens it again).
        if (admin.state.get(0) === "claimed") admin.state.set(0, "open");
      },
    });
    expect(out.stats).toMatchObject({ passagesEmbedded: 6_010 });
    expect(clock).toBeGreaterThan(0);
  });

  it("a helper whose shards are all taken moves on instead of waiting", async () => {
    const admin = fakePieces();
    await admin.claims("lead").register(4, [], 2);
    for (const i of [0, 1, 2, 3]) admin.state.set(i, "claimed");
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const out = await indexCollection(store, await bigBuild(), {
      embedders: e.source,
      slot: HELPER,
      claims: () => admin.claims(`${HELPER.helper}:0`),
    });
    expect(out.kind).toBe("shared");
    expect(e.embedded).toEqual([]);
  });

  it("a retry's first report already counts the shards an earlier attempt wrote", async () => {
    const t = await bigBuild();
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const first = fakePieces({ helperClaims: 1 });
    await first.claims("lead").register(4, [], 2);
    await expect(
      indexCollection(store, t, {
        embedders: e.source,
        slot: HELPER,
        claims: () => first.claims(`${HELPER.helper}:0`),
      }),
    ).rejects.toThrow(/stopped this helper/);
    const reports: number[] = [];
    const retry = fakePieces();
    await build(t, e.source, {
      claims: () => retry.claims("lead"),
      onProgress: async (p) => {
        reports.push(p.embedded);
      },
    });
    // Not a 0 that reads as "starting over" for the next 20 seconds.
    expect(reports[0]).toBeGreaterThan(0);
    // The retry's lead named the written shard as done.
    expect(retry.registered[0]?.done).toHaveLength(1);
  });

  it("a later Stage with one text more keeps the shards an unfinished index wrote", async () => {
    // A first index that did not finish (here: its attempt's time ran out
    // after two of four shards) and the next Stage, one passage more: only
    // the shard the new text falls in, and the ones never written, embed.
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    let clock = 0;
    const slow: EmbedderSource = async (model) => {
      const inner = await e.source(model);
      return {
        ...inner,
        embed: async (texts, kind) => {
          clock += 60_000;
          return inner.embed(texts, kind);
        },
      };
    };
    await expect(
      indexCollection(store, await bigBuild(), {
        embedders: slow,
        claims: () => fakePieces().claims("lead"),
        shardDeadline: 70 * 60_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/not embedded within this attempt's time/);
    const written = e.embedded.length;
    e.embedded.length = 0;
    const docs = [
      ...Array.from({ length: 601 }, (_, d) =>
        page(
          `p${d}`,
          Array.from({ length: 10 }, (_, s) => `Seite ${d} Abschnitt ${s}`),
        ),
      ),
      page("extra", ["Ein neuer Abschnitt"]),
    ];
    const next = await task({
      maxDocuments: 1_000,
      changeKeys: [
        await change({ upserts: docs, deletes: [], replaceAll: false, profile: semantic }),
      ],
    });
    const out = await build(next, e.source, { claims: () => fakePieces().claims("lead") });
    expect(out.stats).toMatchObject({ passagesEmbedded: 6_011 });
    // At least one of the two written shards was kept: a shard is ~1,500.
    expect(6_011 - e.embedded.length).toBeGreaterThan(1_000);
    expect(6_011 - e.embedded.length).toBeLessThanOrEqual(written);
  });

  it("on its lead alone a build too large for one attempt goes on where the last attempt stopped", async () => {
    // No helper ever joins (a small quota, or self-hosted): every attempt
    // embeds shards until its time is up, and the next one only the rest,
    // so a narrow width takes longer but finishes.
    const t = await bigBuild();
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    let clock = 0;
    const slow: EmbedderSource = async (model) => {
      const inner = await e.source(model);
      return {
        ...inner,
        embed: async (texts, kind) => {
          // Each model call takes a minute of the attempt's clock.
          clock += 60_000;
          return inner.embed(texts, kind);
        },
      };
    };
    // The pieces outlive the attempts (they are the run's), as in the database.
    const admin = fakePieces();
    const attempt = () => {
      const start = clock;
      return indexCollection(store, t, {
        embedders: slow,
        claims: () => admin.claims("lead"),
        // 6,010 texts are 4 shards of about 1,500 (47 calls of 32): a shard
        // takes about 47 minutes here, and none is claimed after minute 60.
        shardDeadline: start + 70 * 60_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
    };
    await expect(attempt()).rejects.toThrow(
      /pieces of the search index were not embedded within this attempt's time/,
    );
    // Two whole shards, about half.
    const first = e.embedded.length;
    expect(first).toBeGreaterThan(2_500);
    expect(first).toBeLessThan(3_500);
    let out: Awaited<ReturnType<typeof attempt>> | null = null;
    for (let i = 0; i < 5 && out === null; i++) {
      try {
        out = await attempt();
      } catch (err) {
        expect(String(err)).toContain("next attempt embeds only those");
      }
    }
    // Every text embedded exactly once over all attempts, and the release built.
    expect(e.embedded.length).toBe(6_010);
    expect(new Set(e.embedded).size).toBe(6_010);
    expect(out?.kind).toBe("built");
  });
});

/** A helper's first task (#1776). */
const HELPER: TaskSlot = { index: 0, count: 2, helper: "00000000-0000-4000-8000-000000001776" };

/**
 * A stand-in admin for one build's shards, claiming as `job_pieces` does
 * (ops/job_pieces.ts): the first open shard, `wait` while others hold the
 * rest, `none` when all are done. A helper hears `stop` after
 * `helperClaims` shards.
 */
function fakePieces(opts: { helperClaims?: number } = {}) {
  const state = new Map<number, "open" | "claimed" | "done">();
  const registered: { count: number; done: number[]; wantedTasks: number }[] = [];
  const claimed = new Map<string, number>();
  return {
    state,
    registered,
    claims(worker: string): ShardClaims {
      return {
        register: async (count, done, wantedTasks) => {
          registered.push({ count, done: [...done], wantedTasks });
          for (let i = 0; i < count; i++) if (!state.has(i)) state.set(i, "open");
          // A new lead: the claims of the attempt before are open again.
          for (const [i, s] of state) if (s === "claimed") state.set(i, "open");
          for (const i of done) state.set(i, "done");
        },
        claim: async (): Promise<PieceClaim> => {
          const mine = claimed.get(worker) ?? 0;
          if (worker !== "lead" && opts.helperClaims !== undefined && mine >= opts.helperClaims)
            return { stop: true };
          for (const [i, s] of [...state].sort((a, b) => a[0] - b[0])) {
            if (s !== "open") continue;
            state.set(i, "claimed");
            claimed.set(worker, mine + 1);
            return { piece: i, key: null };
          }
          return [...state.values()].some((s) => s === "claimed") ? { wait: true } : { none: true };
        },
        done: async (shard) => {
          state.set(shard, "done");
        },
      };
    },
  };
}

describe("what the index job reports", () => {
  /** A stand-in admin that records every report and answers the claims from `admin`. */
  function recordingReporter(slot: TaskSlot, admin = fakePieces()) {
    const calls: { action: string; payload: unknown }[] = [];
    const worker = slot.helper === null ? "lead" : `${slot.helper}:${slot.index}`;
    const claims = admin.claims(worker);
    const reporter: JobReporter = {
      kind: "collection_index",
      subjectId: "00000000-0000-4000-8000-000000000001",
      attempt: 1,
      slot,
      stopped: false,
      call: async <T>(action: string, payload: unknown = {}): Promise<T> => {
        calls.push({ action, payload });
        const p = payload as { count: number; done: number[]; wantedTasks: number; piece: number };
        if (action === "pieces") await claims.register(p.count, p.done, p.wantedTasks);
        if (action === "claim") return (await claims.claim()) as T;
        if (action === "piece-done") await claims.done(p.piece);
        return {} as T;
      },
    };
    return { reporter, calls };
  }

  async function big(): Promise<IndexTask> {
    const docs = Array.from({ length: 601 }, (_, d) => ({
      id: `p${d}`,
      lang: "de",
      values: {
        title: `p${d}`,
        sections: Array.from({ length: 10 }, (_, s) => ({
          anchor: `a${s}`,
          heading: "",
          text: `Seite ${d} Abschnitt ${s}`,
        })),
      },
    }));
    return task({
      maxDocuments: 1_000,
      changeKeys: [
        await change({
          upserts: docs,
          deletes: [],
          replaceAll: false,
          profile: profile({ weight: 1, minSimilarity: 0.2 }),
        }),
      ],
    });
  }

  it("the lead names its shards, claims them, and reports the release", async () => {
    const { reporter, calls } = recordingReporter({ index: 0, count: 1, helper: null });
    await indexTasks(reporter, store, [await big()], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: reporter.slot,
    });
    const actions = calls.map((c) => c.action);
    expect(actions[0]).toBe("pieces");
    expect(calls[0]?.payload).toMatchObject({ count: 4, done: [], wantedTasks: 2 });
    expect(actions.filter((a) => a === "piece-done")).toHaveLength(4);
    expect(actions.at(-1)).toBe("done");
    expect(actions).not.toContain("leave");
    expect(calls.find((c) => c.action === "progress")?.payload).toMatchObject({
      worker: "lead",
      planned: 6_010,
      wantedTasks: 2,
    });
  });

  it("a helper reports its progress, never the shards or the release, and leaves when none is left", async () => {
    const admin = fakePieces();
    await admin.claims("lead").register(4, [], 2);
    const { reporter, calls } = recordingReporter(HELPER, admin);
    await indexTasks(reporter, store, [await big()], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: reporter.slot,
    });
    const actions = calls.map((c) => c.action);
    for (const a of ["pieces", "done", "failed"]) expect(actions).not.toContain(a);
    expect(actions.filter((a) => a === "piece-done")).toHaveLength(4);
    expect(actions.at(-1)).toBe("leave");
    expect(calls.find((c) => c.action === "progress")?.payload).toMatchObject({
      worker: `${HELPER.helper}:0`,
      embedded: 0,
      planned: 6_010,
    });
  });

  it("a helper the ledger stopped ends without leaving again: the claim gave its task back", async () => {
    const admin = fakePieces({ helperClaims: 1 });
    await admin.claims("lead").register(4, [], 2);
    const { reporter, calls } = recordingReporter(HELPER, admin);
    await indexTasks(reporter, store, [await big()], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: reporter.slot,
    });
    const actions = calls.map((c) => c.action);
    expect(actions.filter((a) => a === "piece-done")).toHaveLength(1);
    expect(actions).not.toContain("leave");
  });
});
