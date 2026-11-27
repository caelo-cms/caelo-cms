// SPDX-License-Identifier: MPL-2.0

/**
 * #1650, #1782 — fetching a model: from the pinned revision, verified before
 * it lands under its name, never trusting a file already there; then the
 * files a process loads, derived and checked against their pins.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchModel, sourceUrl } from "./fetch.js";
import { modelDir, modelFilePath } from "./files.js";
import { tinyModel } from "./tiny-model.js";

const { model, graph, tokenizer } = tinyModel();
const derivedNames = [
  model.derived.graph.name,
  model.derived.table.name,
  model.derived.tokenizer.name,
];

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "caelo-fetch-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A fetch serving `files` by URL and recording what was asked. */
function serving(files: Record<string, Uint8Array>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const body = files[url];
    return body ? new Response(body) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, asked };
}

const urls = {
  [sourceUrl(model, model.files.model)]: graph,
  [sourceUrl(model, model.files.tokenizer)]: tokenizer,
};

describe("fetchModel", () => {
  it("downloads from the pinned revision and verifies", async () => {
    const s = serving(urls);
    const r = await fetchModel(dir, model, { fetch: s.fetch });
    expect(r.map((x) => x.action)).toEqual([
      "downloaded",
      "downloaded",
      "derived",
      "derived",
      "derived",
    ]);
    expect(s.asked).toEqual([
      "https://huggingface.co/example/test/resolve/0123456789abcdef0123456789abcdef01234567/onnx/model.onnx",
      "https://huggingface.co/example/test/resolve/0123456789abcdef0123456789abcdef01234567/tokenizer.json",
    ]);
    expect([...(await readFile(modelFilePath(dir, model, model.files.model)))]).toEqual([...graph]);
  });

  it("leaves verified files alone", async () => {
    await fetchModel(dir, model, { fetch: serving(urls).fetch });
    const s = serving(urls);
    const r = await fetchModel(dir, model, { fetch: s.fetch });
    expect(r.map((x) => x.action)).toEqual(["present", "present", "present", "present", "present"]);
    expect(s.asked).toEqual([]);
  });

  it("derives again when a derived file was changed", async () => {
    await fetchModel(dir, model, { fetch: serving(urls).fetch });
    const table = modelFilePath(dir, model, model.derived.table);
    const bytes = await readFile(table);
    bytes[0] = (bytes[0] as number) ^ 1;
    await writeFile(table, bytes);
    const r = await fetchModel(dir, model, { fetch: serving(urls).fetch });
    expect(r.filter((x) => x.action === "derived").map((x) => x.file)).toEqual(derivedNames);
  });

  it("keeps only what a process loads with runtimeOnly, and needs nothing more then", async () => {
    const r = await fetchModel(dir, model, { fetch: serving(urls).fetch, runtimeOnly: true });
    expect(r.filter((x) => x.action === "removed").map((x) => x.file)).toEqual([
      "model.onnx",
      "tokenizer.json",
    ]);
    expect((await readdir(modelDir(dir, model))).sort()).toEqual([...derivedNames].sort());
    const s = serving(urls);
    await fetchModel(dir, model, { fetch: s.fetch, runtimeOnly: true });
    expect(s.asked).toEqual([]);
  });

  it("replaces a present file that fails verification", async () => {
    const path = modelFilePath(dir, model, model.files.model);
    await mkdir(modelDir(dir, model), { recursive: true });
    const wrong = new Uint8Array(graph);
    wrong[wrong.length - 1] = (wrong[wrong.length - 1] as number) ^ 1;
    await writeFile(path, wrong);
    const r = await fetchModel(dir, model, { fetch: serving(urls).fetch });
    expect(r[0]?.action).toBe("downloaded");
    expect([...(await readFile(path))]).toEqual([...graph]);
  });

  it("refuses bytes that are not the pinned ones and leaves nothing behind", async () => {
    const evil = {
      ...urls,
      [sourceUrl(model, model.files.model)]: new Uint8Array(graph.length),
    };
    await expect(fetchModel(dir, model, { fetch: serving(evil).fetch })).rejects.toThrow(
      /the catalog pins \d+ bytes with/,
    );
    expect(await readdir(modelDir(dir, model))).toEqual([]);
  });

  it("stops reading past the pinned size", async () => {
    const big = {
      ...urls,
      [sourceUrl(model, model.files.model)]: new Uint8Array(graph.length + 1000),
    };
    await expect(fetchModel(dir, model, { fetch: serving(big).fetch })).rejects.toThrow(
      /more than the \d+ bytes the catalog pins/,
    );
  });

  it("reports an HTTP failure", async () => {
    await expect(fetchModel(dir, model, { fetch: serving({}).fetch })).rejects.toThrow(/HTTP 404/);
  });
});
