// SPDX-License-Identifier: MPL-2.0

/**
 * #1782 — the token table taken out of the graph: the split graph fed the
 * gathered rows computes exactly what the publisher's graph computes, on
 * both runtimes, and the split refuses graphs it would not reproduce.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ortNode from "onnxruntime-node";
import * as ortWeb from "onnxruntime-web";
import { TINY_GATHER, TINY_WIDTH, tinyGraph } from "./tiny-model.js";
import { splitTokenTable, TokenTable } from "./token-table.js";

const ROWS = 40;
const graph = tinyGraph(ROWS);
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "caelo-token-table-"));
  ortWeb.env.wasm.numThreads = 1;
  ortWeb.env.wasm.proxy = false;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

type Ort = typeof ortNode;

async function outputs(
  ort: Ort,
  model: Uint8Array,
  ids: number[],
  rows?: Uint8Array,
): Promise<Float32Array> {
  const session = await ort.InferenceSession.create(model);
  const n = ids.length;
  const feeds: Record<string, ortNode.Tensor> = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, n]),
    attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
  };
  if (rows)
    feeds[`${TINY_GATHER}_output_0_quantized`] = new ort.Tensor("uint8", rows, [1, n, TINY_WIDTH]);
  const out = await session.run(feeds);
  await session.release();
  return out.last_hidden_state?.data as Float32Array;
}

describe("splitTokenTable", () => {
  it("takes the table out and keeps everything else", () => {
    const split = splitTokenTable(graph, TINY_GATHER);
    expect(split.rows).toBe(ROWS);
    expect(split.width).toBe(TINY_WIDTH);
    expect(split.elementType).toBe("uint8");
    expect(split.input).toBe(`${TINY_GATHER}_output_0_quantized`);
    expect(split.table.length).toBe(ROWS * TINY_WIDTH);
    expect(split.graph.length).toBeLessThan(graph.length - split.table.length + 200);
    // Deterministic: the same input, the same bytes.
    expect([...splitTokenTable(graph, TINY_GATHER).graph]).toEqual([...split.graph]);
  });

  for (const [name, ort] of [
    ["native", ortNode],
    ["WebAssembly", ortWeb as unknown as Ort],
  ] as const) {
    it(`answers exactly like the full graph on ${name}`, async () => {
      const split = splitTokenTable(graph, TINY_GATHER);
      const path = join(dir, `tokens-${name}.bin`);
      await writeFile(path, split.table);
      const table = new TokenTable(path, split.rows, split.width);
      try {
        for (const ids of [
          [0],
          [3, 1, 4, 1, 5, 9, 2, 6],
          [39, 0, 38],
          Array.from({ length: 30 }, (_, i) => i),
        ]) {
          const full = await outputs(ort, graph, ids);
          const fed = await outputs(ort, split.graph, ids, table.gather(ids));
          expect([...fed]).toEqual([...full]);
        }
      } finally {
        table.close();
      }
    });
  }

  it("refuses what it would not reproduce", () => {
    expect(() => splitTokenTable(graph, "/nope")).toThrow('no node named "/nope"');
    expect(() => splitTokenTable(graph, "/dequantize")).toThrow("is not a Gather");
    expect(() => splitTokenTable(new Uint8Array([8, 1]), TINY_GATHER)).toThrow("no graph");
  });
});

describe("TokenTable", () => {
  it("reads rows by id and refuses ids outside the table", async () => {
    const data = Uint8Array.from({ length: 3 * 4 }, (_, i) => i);
    const path = join(dir, "rows.bin");
    await writeFile(path, data);
    const table = new TokenTable(path, 3, 4);
    try {
      expect([...table.gather([2, 0])]).toEqual([8, 9, 10, 11, 0, 1, 2, 3]);
      expect(() => table.gather([3])).toThrow("outside its 3 rows");
    } finally {
      table.close();
    }
    expect(() => table.gather([0])).toThrow("closed");
  });
});
