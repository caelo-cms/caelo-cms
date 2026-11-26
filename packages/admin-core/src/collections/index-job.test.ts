// SPDX-License-Identifier: MPL-2.0

/**
 * #1650 — the index job and the vector model: it embeds only when the
 * Stage named a model and the profile turns semantic search on, records the
 * model's fingerprint, and rebuilds (never extends) a release built with
 * another model. Embedders are stand-ins here; the real model's behaviour
 * is tested in packages/models and the parity test.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
        shardDeadline: 30_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/the vectors of task\(s\) 1, 2 of 3 did not arrive in time/);
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
    // At least the final count of its share (3,005 of 6,010).
    // It reports at once, so its share counts before its first batch, and with the plan's total.
    expect(calls[0]).toMatchObject({
      action: "progress",
      payload: { task: 1, tasks: 2, embedded: 0, toEmbed: 3_005, planned: 6_010 },
    });
    expect(calls.at(-1)).toMatchObject({
      action: "progress",
      payload: { task: 1, embedded: 3_005, toEmbed: 3_005 },
    });
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
    expect((calls[0]?.payload as { reason: string }).reason).toContain("t1650/pages2");
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
