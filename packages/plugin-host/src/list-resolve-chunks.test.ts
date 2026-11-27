// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a `list-resolve` scope too big for one call is asked in parts
 * (docs/dev/external-plugin-brokers.md §6.5). The plugin source entries
 * split across parts too: one source of 500 entries with two long text
 * fields (about 1.5 MB, within the list-source answer limit) made one
 * part past the sandbox's 1 MB message limit.
 */

import { describe, expect, it } from "bun:test";
import type { ListResolveScope } from "@caelo-cms/plugin-sdk";
import { chunkListResolveScope } from "./list-resolve.js";
import { RENDER_POINT_CHUNK_BYTES } from "./render-points.js";

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

function bigScope(): ListResolveScope {
  const fields = [
    { name: "title", label: "Title", type: "text" as const },
    { name: "body", label: "Body", type: "text" as const },
  ];
  return {
    listIds: ["00000000-0000-4000-8000-000000000001"],
    contentInstanceIds: [],
    pageIds: [],
    sources: [
      {
        name: "big",
        label: "Big source",
        fields,
        entries: Array.from({ length: 500 }, (_, i) => ({
          id: `e${i}`,
          values: { title: "t".repeat(1500), body: "b".repeat(1500) },
        })),
      },
      {
        name: "small",
        label: "Small source",
        fields,
        entries: [{ id: "s0", values: { title: "x", body: "y" } }],
      },
    ],
  };
}

describe("#1729 — list-resolve scope parts", () => {
  it("splits a source's entries so every part stays within the chunk", () => {
    const scope = bigScope();
    expect(bytes(scope)).toBeGreaterThan(1_048_576);
    const parts = chunkListResolveScope(scope) as ListResolveScope[];
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(RENDER_POINT_CHUNK_BYTES);
    // Every entry once, in order, each part naming its sources whole.
    const seen = parts.flatMap((p) =>
      (p.sources ?? []).flatMap((s) => {
        expect(s.label).toBe(s.name === "big" ? "Big source" : "Small source");
        expect(s.fields.map((f) => f.name)).toEqual(["title", "body"]);
        return s.entries.map((e) => `${s.name}/${e.id}`);
      }),
    );
    expect(seen).toEqual([...Array.from({ length: 500 }, (_, i) => `big/e${i}`), "small/s0"]);
    expect(parts.flatMap((p) => p.listIds)).toEqual(scope.listIds);
  });

  it("keeps a scope that fits in one part", () => {
    const scope: ListResolveScope = { listIds: ["a"], contentInstanceIds: [], pageIds: [] };
    expect(chunkListResolveScope(scope)).toEqual([scope]);
    expect(chunkListResolveScope(undefined)).toEqual([undefined]);
  });
});
