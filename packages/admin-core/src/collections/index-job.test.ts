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
import { type EmbedderSource, indexCollection } from "./index-job.js";
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
    const { applied, stats } = await indexCollection(store, task({ changeKeys: keys }), e.source);
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
    const a = await indexCollection(store, task({ changeKeys: keys }), off.source);
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
    const b = await indexCollection(
      store,
      task({ changeKeys: keys2, vectorModel: null }),
      off.source,
    );
    expect(b.applied.manifest.vectorModel).toBeNull();
    expect(off.embedded).toEqual([]);
  });

  it("extends a release of the same model with only the changed passages", async () => {
    const e = fakeEmbedders("granite@aaaaaaaaaaaa");
    const first = await indexCollection(
      store,
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
    const second = await indexCollection(
      store,
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
    const first = await indexCollection(
      store,
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
    const second = await indexCollection(
      store,
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
    const first = await indexCollection(
      store,
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
    const second = await indexCollection(
      store,
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
      indexCollection(
        store,
        task({ changeKeys: keys, vectorModel: "no-such-model" }),
        fakeEmbedders("x@y").source,
      ),
    ).rejects.toThrow(
      /no-such-model, which this release's catalog does not have: pick a model in Settings → Plugin settings/,
    );
  });
});
