// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1651) — `replace()` of a collection handle: what one source
 * said is replaced whole. More than one write's worth of values takes
 * several change files; folded in order (the index job's own fold), every
 * replacement document survives, because no removal comes after them.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { foldChanges } from "../../admin-core/src/collections/index-job.js";
import { COLLECTION_OPS, encodeChangeFile, makePluginCollections } from "./collections-host.js";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

const PLUGIN = {
  pluginId: "00000000-0000-4000-8000-0000000c0111",
  pluginActorId: "00000000-0000-4000-8000-0000000c0112",
  slug: "t1644-replace",
  definition: {
    collections: {
      anchors: { fields: { text: { kind: "text" }, source: { kind: "keyword" } } },
    },
  },
} as unknown as LoadedPlugin;

/** Captures every change file the handle writes, as the write op would store it. */
function capture() {
  const files = new Map<string, Uint8Array>();
  const keys: string[] = [];
  const adapter = {
    runOperation: (op: { name: string }, _ctx: unknown, input: Record<string, never>) => {
      if (op.name !== COLLECTION_OPS.write) throw new Error(`unexpected op ${op.name}`);
      const key = `changes/${keys.length}.bin`;
      files.set(
        key,
        encodeChangeFile({
          upserts: input.upserts,
          deletes: input.deletes,
          replaceAll: false,
          ...((input.deleteWhere as unknown[]).length > 0
            ? { deleteWhere: input.deleteWhere }
            : {}),
        }),
      );
      keys.push(key);
      return ok({ changeId: key });
    },
  } as unknown as DatabaseAdapter;
  const infra = { registry: new OperationRegistry(), adapter } as unknown as PluginHostInfra;
  const store = {
    read: async (k: string) => {
      const d = files.get(k);
      if (!d) throw new Error(`missing ${k}`);
      return d;
    },
  };
  return { infra, keys, store };
}

describe("collection replace()", () => {
  it("keeps a replacement document whose source is in a later removal chunk", async () => {
    const { infra, keys, store } = capture();
    const collections = makePluginCollections(PLUGIN, infra, {
      origin: "observer",
      actorId: PLUGIN.pluginActorId,
      stageRunId: "00000000-0000-4000-8000-0000000c0113",
    });
    const sources = Array.from({ length: 1001 }, (_, i) => `s${i}`);
    const doc = { id: "a1", lang: "de", values: { text: "Preise", source: "s1000" } };
    await collections.anchors?.replace("source", sources, [doc]);
    expect(keys.length).toBe(2);
    const folded = await foldChanges(store as never, keys);
    expect([...folded.upserts.keys()]).toEqual(["a1"]);
    expect(folded.deleteWhere).toHaveLength(1001);
  });

  it("up to 1000 values stay one change", async () => {
    const { infra, keys } = capture();
    const collections = makePluginCollections(PLUGIN, infra, {
      origin: "observer",
      actorId: PLUGIN.pluginActorId,
      stageRunId: "00000000-0000-4000-8000-0000000c0113",
    });
    await collections.anchors?.replace(
      "source",
      ["p:1", "p:2"],
      [{ id: "a1", lang: "de", values: { text: "Preise", source: "p:1" } }],
    );
    expect(keys.length).toBe(1);
  });
});
