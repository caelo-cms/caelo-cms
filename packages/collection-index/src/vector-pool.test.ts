// SPDX-License-Identifier: MPL-2.0

/**
 * Vector reuse (vector-pool.ts): a Stage and a rebuild send only passage
 * text the collection has not embedded to the model, and the release they
 * write holds the same vectors a full re-embedding would have written.
 *
 * Before, `applyChanges` embedded every passage of every document it was
 * handed and a rebuild every passage of the collection: searchviu.com's
 * first build with vectors embedded 5,152 passages in 13.5 minutes.
 */

import { describe, expect, it } from "bun:test";
import {
  addReleaseVectors,
  applyChanges,
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  FileCache,
  openRelease,
  type ReleaseManifest,
  VectorPool,
} from "./index.js";

const SCHEMA: CollectionSchema = {
  fields: {
    title: { kind: "text" },
    sections: { kind: "passages", vector: true },
  },
};
const MODEL = { id: "counting-8", dims: 8 };

function doc(id: string, texts: readonly string[]): CollectionDoc {
  return {
    id,
    lang: "en",
    values: {
      title: id,
      sections: texts.map((text, i) => ({ anchor: `s${i}`, heading: "", text })),
    },
  };
}

/** A deterministic embedding that records every text it is asked for. */
function countingEmbed() {
  const asked: string[] = [];
  const embed = (texts: readonly string[]): Promise<Float32Array[]> => {
    asked.push(...texts);
    return Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array(MODEL.dims);
        for (let i = 0; i < t.length; i++) {
          const at = (t.charCodeAt(i) * (i + 1)) % MODEL.dims;
          v[at] = (v[at] as number) + 1;
        }
        return v;
      }),
    );
  };
  return { asked, embed };
}

function memoryStore() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    sink: (n: string, d: Uint8Array) => void files.set(n, d),
    cache: () =>
      new FileCache(
        {
          read: async (f) => {
            const d = files.get(f);
            if (!d) throw new Error(`missing ${f}`);
            return d;
          },
        },
        1 << 26,
      ),
  };
}

const SITE = [
  doc("pricing", ["Plans for agencies.", "Cancel any month.", "Contact sales."]),
  doc("logfiles", ["Logfile analysis shows crawlers.", "Export to CSV.", "Contact sales."]),
  doc("about", ["We build SEO software.", "Founded in Hamburg.", "Jobs."]),
];

async function firstRelease(store = memoryStore()) {
  const { asked, embed } = countingEmbed();
  const applied = await buildRelease(SITE, {
    schema: SCHEMA,
    sink: store.sink,
    embed,
    vectorModel: MODEL,
  });
  return { applied, asked, store };
}

/** Every file of a release's vector field, for comparing two builds. */
async function vectorFiles(store: ReturnType<typeof memoryStore>, manifest: ReleaseManifest) {
  const opened = await openRelease(manifest, store.cache());
  return opened.segments.flatMap((s) => [
    ...(s.reader.manifest.vectors?.codes ?? []),
    ...(s.reader.manifest.vectors?.blocks ?? []),
  ]);
}

describe("vector reuse", () => {
  it("embeds a text that repeats within one build once", async () => {
    const { applied, asked } = await firstRelease();
    // "Contact sales." is on two pages: nine passages, eight texts.
    expect(asked.length).toBe(8);
    expect(applied.passages).toEqual({ embedded: 8, reused: 1 });
  });

  it("a Stage embeds only the passages whose text changed", async () => {
    const store = memoryStore();
    const first = await firstRelease(store);
    const { asked, embed } = countingEmbed();
    const applied = await applyChanges(
      first.applied.manifest,
      {
        upserts: [
          // One passage of three changed.
          doc("pricing", ["Plans for agencies.", "Cancel any week.", "Contact sales."]),
          // Re-rendered by an update, words unchanged.
          doc("logfiles", ["Logfile analysis shows crawlers.", "Export to CSV.", "Contact sales."]),
        ],
        deletes: [],
      },
      { schema: SCHEMA, sink: store.sink, cache: store.cache(), embed, vectorModel: MODEL },
    );
    expect(asked).toEqual(["Cancel any week."]);
    expect(applied.passages).toEqual({ embedded: 1, reused: 5 });
  });

  it("a rebuild under the same model embeds nothing it has, and writes the same vectors as a full one", async () => {
    const store = memoryStore();
    const first = await firstRelease(store);
    const pool = await addReleaseVectors(
      new VectorPool(),
      await openRelease(first.applied.manifest, store.cache()),
      "sections",
    );
    const { asked, embed } = countingEmbed();
    const rebuilt = await buildRelease(SITE, {
      schema: SCHEMA,
      sink: store.sink,
      embed,
      vectorModel: MODEL,
      reuse: pool,
    });
    expect(asked).toEqual([]);
    expect(rebuilt.passages).toEqual({ embedded: 0, reused: 9 });
    // Content-addressed files: equal names are equal bytes.
    expect(await vectorFiles(store, rebuilt.manifest)).toEqual(
      await vectorFiles(store, first.applied.manifest),
    );
  });

  it("takes nothing from a release without vectors", async () => {
    const store = memoryStore();
    const plain = await buildRelease(SITE, { schema: SCHEMA, sink: store.sink });
    const pool = await addReleaseVectors(
      new VectorPool(),
      await openRelease(plain.manifest, store.cache()),
      "sections",
    );
    expect(pool.size).toBe(0);
  });

  it("reads only the changed documents' vectors on a Stage", async () => {
    const store = memoryStore();
    const first = await firstRelease(store);
    const opened = await openRelease(first.applied.manifest, store.cache());
    // Keys follow stream order from 1: "about" is key 3.
    const pool = await addReleaseVectors(
      new VectorPool(),
      opened,
      "sections",
      new Map([[0, new Set([3])]]),
    );
    expect(pool.size).toBe(3);
    expect(pool.get("Founded in Hamburg.")).toBeDefined();
    expect(pool.get("Plans for agencies.")).toBeUndefined();
  });
});
