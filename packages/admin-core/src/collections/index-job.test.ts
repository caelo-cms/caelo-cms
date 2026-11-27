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
  scopedStore,
  searchVectors,
} from "@caelo-cms/collection-index";
import type { Embedder } from "@caelo-cms/models";
import { encodeChangeFile } from "@caelo-cms/plugin-host";
import type { SearchProfile } from "@caelo-cms/plugin-sdk";
import { DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModel } from "@caelo-cms/shared";
import { planRunCapacity } from "../reporting-jobs/run-capacity.js";
import {
  type EmbedderSource,
  type IndexOptions,
  indexCollection,
  indexTasks,
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

  /** A first build with more distinct passages than one task embeds. */
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

  it("asks for more tasks when one task has more to embed than its share", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const out = await indexCollection(store, await bigBuild(), {
      embedders: e.source,
      slot: { index: 0, count: 1, max: 32 },
    });
    expect(out).toMatchObject({ kind: "scale", tasks: 2 });
    // It decided before embedding anything.
    expect(e.embedded).toEqual([]);
  });

  it("an attempt already wide widens further for a collection that needs more", async () => {
    const docs = Array.from({ length: 1_201 }, (_, d) =>
      page(
        `q${d}`,
        Array.from({ length: 10 }, (_, s) => `Grosse Seite ${d} Abschnitt ${s}`),
      ),
    );
    const t = task({
      maxDocuments: 2_000,
      changeKeys: [
        await change({ upserts: docs, deletes: [], replaceAll: false, profile: semantic }),
      ],
    });
    const out = await indexCollection(store, t, {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: { index: 0, count: 2, max: 32 },
    });
    expect(out).toMatchObject({ kind: "scale", tasks: 3 });
  });

  it("builds alone where the launcher runs one task (inside the admin)", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const out = await build(await bigBuild(), e.source, { slot: { index: 0, count: 1, max: 1 } });
    expect(out.stats).toMatchObject({ passagesEmbedded: 6_010, tasks: 1 });
  });

  it("in a wide attempt every task embeds its share once and the first builds what one task would have", async () => {
    const t = await bigBuild();
    const alone = fakeEmbedders("granite@aaaaaaaaaaaa");
    const single = await build(t, alone.source, { slot: { index: 0, count: 1, max: 1 } });
    // The single build left its shards; the wide one must embed on its own.
    const shards = join(root, "t1650/pages/vectors");
    for (const f of await readdir(shards)) if (f.startsWith("v-")) await rm(join(shards, f));

    const wide = fakeEmbedders("granite@aaaaaaaaaaaa");
    for (const index of [1, 2]) {
      const out = await indexCollection(store, t, {
        embedders: wide.source,
        slot: { index, count: 3, max: 32 },
      });
      expect(out.kind).toBe("shared");
    }
    const first = await build(t, wide.source, { slot: { index: 0, count: 3, max: 32 } });
    expect(new Set(wide.embedded).size).toBe(6_010);
    expect(wide.embedded.length).toBe(6_010);
    expect(first.stats).toMatchObject({ passagesEmbedded: 6_010, tasks: 3 });
    // Content-addressed files: the same release name is the same index.
    expect(first.applied.file).toBe(single.applied.file);
  });

  it("a retry's first report already counts the shards an earlier attempt wrote", async () => {
    const t = await bigBuild();
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    await indexCollection(store, t, { embedders: e.source, slot: { index: 1, count: 2, max: 32 } });
    const reports: number[] = [];
    await indexCollection(store, t, {
      embedders: e.source,
      slot: { index: 1, count: 2, max: 32 },
      onProgress: async (p) => {
        reports.push(p.embedded);
      },
    });
    // Not a 0 that reads as "starting over" for the next 20 seconds.
    expect(reports[0]).toBeGreaterThan(0);
  });

  it("the next attempt embeds only the shares a dead attempt left missing", async () => {
    const t = await bigBuild();
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    await indexCollection(store, t, { embedders: e.source, slot: { index: 1, count: 2, max: 32 } });
    const written = e.embedded.length;
    e.embedded.length = 0;
    // Task 1 of the retry finds its shard and embeds nothing; task 0 only its own share.
    await indexCollection(store, t, { embedders: e.source, slot: { index: 1, count: 2, max: 32 } });
    expect(e.embedded).toEqual([]);
    await build(t, e.source, { slot: { index: 0, count: 2, max: 32 } });
    expect(e.embedded.length).toBe(6_010 - written);
  });

  it("the first task stops waiting at its deadline and names the missing tasks", async () => {
    const t = await bigBuild();
    let clock = 0;
    await expect(
      indexCollection(store, t, {
        embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
        slot: { index: 0, count: 3, max: 32 },
        // Time for its own shards (none starts in the last ten minutes), then a wait.
        shardDeadline: 20 * 60_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/2 of 4 pieces of the search index, of task\(s\) 1, 2 of 3, did not arrive/);
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
        slot: { index: 0, count: 1, max: 1 },
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
    const out = await build(next, e.source, { slot: { index: 0, count: 1, max: 1 } });
    expect(out.stats).toMatchObject({ passagesEmbedded: 6_011 });
    // At least one of the two written shards was kept: a shard is ~1,500.
    expect(6_011 - e.embedded.length).toBeGreaterThan(1_000);
    expect(6_011 - e.embedded.length).toBeLessThanOrEqual(written);
  });

  it("on one task a build too large for one attempt goes on where the last attempt stopped", async () => {
    // The quota leaves one task (max 1): every attempt embeds shards until
    // its time is up, and the next one only the rest, so a narrow width
    // takes longer but finishes.
    const t = await bigBuild();
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    let clock = 0;
    const timed = async (texts: readonly string[]) => {
      // Each model call takes a minute of the attempt's clock.
      clock += 60_000;
      return texts;
    };
    const slow: EmbedderSource = async (model) => {
      const inner = await e.source(model);
      return { ...inner, embed: async (texts, kind) => inner.embed(await timed(texts), kind) };
    };
    const attempt = () => {
      const start = clock;
      return indexCollection(store, t, {
        embedders: slow,
        slot: { index: 0, count: 1, max: 1 },
        // 6,010 texts are 4 shards of about 1,500 (47 calls of 32): a shard
        // takes about 47 minutes here, and none starts after minute 60.
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

describe("what the index job reports", () => {
  /** A stand-in admin that records every report. */
  function recordingReporter(slot: { index: number; count: number; max: number }) {
    const calls: { action: string; payload: unknown }[] = [];
    const reporter = {
      kind: "collection_index" as const,
      subjectId: "00000000-0000-4000-8000-000000000001",
      attempt: 1,
      slot,
      stopped: false,
      call: async <T>(action: string, payload: unknown = {}): Promise<T> => {
        calls.push({ action, payload });
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

  it("asks for more tasks and stops, reporting nothing else for the collection", async () => {
    const { reporter, calls } = recordingReporter({ index: 0, count: 1, max: 32 });
    await indexTasks(reporter, store, [await big()], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: reporter.slot,
    });
    expect(calls.map((c) => c.action)).toEqual(["scale"]);
    expect(calls[0]?.payload).toMatchObject({ tasks: 2 });
  });

  it("a task that is not the first reports its progress and never the release", async () => {
    const { reporter, calls } = recordingReporter({ index: 1, count: 2, max: 32 });
    await indexTasks(reporter, store, [await big()], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: reporter.slot,
    });
    const actions = calls.map((c) => c.action);
    expect(actions).not.toContain("done");
    expect(actions).not.toContain("failed");
    // Its share is shards 1 and 3 of 4 (about half of 6,010). It reports at
    // once, so its share counts before its first batch, and with the plan's total.
    const firstReport = calls[0]?.payload as { toEmbed: number };
    expect(calls[0]).toMatchObject({
      action: "progress",
      payload: { task: 1, tasks: 2, embedded: 0, planned: 6_010 },
    });
    expect(firstReport.toEmbed).toBeGreaterThan(2_500);
    expect(firstReport.toEmbed).toBeLessThan(3_500);
    expect(calls.at(-1)).toMatchObject({
      action: "progress",
      payload: { task: 1, embedded: firstReport.toEmbed, toEmbed: firstReport.toEmbed },
    });
    // Without a quota limit (no capacity: inside the admin) no limit is reported.
    expect(calls.some((c) => (c.payload as { limit?: unknown }).limit)).toBe(false);
  });

  it("names the CPU quota when it keeps the build narrower than it would run", async () => {
    const { reporter, calls } = recordingReporter({ index: 0, count: 1, max: 1 });
    await indexTasks(
      { ...reporter, capacity: planRunCapacity("acme-site", "europe-west1", 20) },
      store,
      [await big()],
      { embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source, slot: reporter.slot },
    );
    const progress = calls.find((c) => c.action === "progress");
    expect(progress?.payload).toMatchObject({
      tasks: 1,
      limit: {
        wantedTasks: 2,
        quotaVcpu: 20,
        quotaNeededVcpu: 8 + 30 + 4,
        projectId: "acme-site",
        region: "europe-west1",
      },
    });
    expect(calls.map((c) => c.action)).toContain("done");
  });

  it("sizes the run's other collections before widening, so it widens once", async () => {
    const pagesOf = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, d) => ({
        id: `${prefix}${d}`,
        lang: "de",
        values: {
          title: `${prefix}${d}`,
          sections: Array.from({ length: 10 }, (_, s) => ({
            anchor: `a${s}`,
            heading: "",
            text: `${prefix} Seite ${d} Abschnitt ${s}`,
          })),
        },
      }));
    const semantic = profile({ weight: 1, minSimilarity: 0.2 });
    // 6,010 texts want 2 tasks; the next collection's 18,010 want 4.
    const small = task({
      maxDocuments: 3_000,
      changeKeys: [
        await change({
          upserts: pagesOf("k", 601),
          deletes: [],
          replaceAll: false,
          profile: semantic,
        }),
      ],
    });
    const large = task({
      collection: "pages2",
      maxDocuments: 3_000,
      changeKeys: [
        await change({
          upserts: pagesOf("g", 1_801),
          deletes: [],
          replaceAll: false,
          profile: semantic,
        }),
      ],
    });
    const { reporter, calls } = recordingReporter({ index: 0, count: 1, max: 32 });
    await indexTasks(reporter, store, [small, large], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: reporter.slot,
    });
    expect(calls.map((c) => c.action)).toEqual(["scale"]);
    expect(calls[0]?.payload).toMatchObject({ tasks: 4 });
    const payload = calls[0]?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toContain("t1650/pages2");
  });

  it("in a wide attempt that has to widen, only the first task asks", async () => {
    const docs = Array.from({ length: 1_201 }, (_, d) => ({
      id: `w${d}`,
      lang: "de",
      values: {
        title: `w${d}`,
        sections: Array.from({ length: 10 }, (_, s) => ({
          anchor: `a${s}`,
          heading: "",
          text: `Weite Seite ${d} Abschnitt ${s}`,
        })),
      },
    }));
    const t = task({
      maxDocuments: 2_000,
      changeKeys: [
        await change({
          upserts: docs,
          deletes: [],
          replaceAll: false,
          profile: profile({ weight: 1, minSimilarity: 0.2 }),
        }),
      ],
    });
    const other = recordingReporter({ index: 1, count: 2, max: 32 });
    await indexTasks(other.reporter, store, [t], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: other.reporter.slot,
    });
    expect(other.calls).toEqual([]);
    const first = recordingReporter({ index: 0, count: 2, max: 32 });
    await indexTasks(first.reporter, store, [t], {
      embedders: fakeEmbedders("granite@aaaaaaaaaaaa").source,
      slot: first.reporter.slot,
    });
    expect(first.calls.map((c) => c.action)).toEqual(["scale"]);
  });
});
