// SPDX-License-Identifier: MPL-2.0

/**
 * #1650 — fetching a model: from the pinned revision, verified before it
 * lands under its name, never trusting a file already there.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchModel, sourceUrl } from "./fetch.js";
import { modelDir, modelFilePath } from "./files.js";
import { fakeModel } from "./files.test.js";

const graph = new TextEncoder().encode("graph bytes for the fetch test");
const tokenizer = new TextEncoder().encode('{"model":{}}');
const model = fakeModel(graph, tokenizer);

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
    expect(r.map((x) => x.action)).toEqual(["downloaded", "downloaded"]);
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
    expect(r.map((x) => x.action)).toEqual(["present", "present"]);
    expect(s.asked).toEqual([]);
  });

  it("replaces a present file that fails verification", async () => {
    const path = modelFilePath(dir, model, model.files.model);
    await mkdir(modelDir(dir, model), { recursive: true });
    await writeFile(path, new TextEncoder().encode("graph bytes for the fetch tesT"));
    const r = await fetchModel(dir, model, { fetch: serving(urls).fetch });
    expect(r[0]?.action).toBe("downloaded");
    expect([...(await readFile(path))]).toEqual([...graph]);
  });

  it("refuses bytes that are not the pinned ones and leaves nothing behind", async () => {
    const evil = {
      ...urls,
      [sourceUrl(model, model.files.model)]: new TextEncoder().encode(
        "graph bytes for the fetch tesX",
      ),
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
