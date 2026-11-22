// SPDX-License-Identifier: MPL-2.0

/**
 * #1650 — model files are used only as the catalog pins them, and a model
 * missing from disk fails loudly with the command that fetches it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingModel } from "@caelo-cms/shared";
import {
  ModelFileError,
  modelFilePath,
  modelsDirFromEnv,
  readModelFiles,
  readVerifiedModelFile,
  sha256Hex,
} from "./files.js";

const graph = new TextEncoder().encode("not really an onnx graph");
const tokenizer = new TextEncoder().encode(JSON.stringify({ model: { type: "WordLevel" } }));

/** A catalog entry for two small files. */
export function fakeModel(g: Uint8Array = graph, t: Uint8Array = tokenizer): EmbeddingModel {
  return {
    id: "test-model",
    label: "Test",
    description: "Test",
    source: {
      host: "huggingface.co",
      repo: "example/test",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    licence: "Apache-2.0",
    licenceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    copyright: "Copyright Example",
    files: {
      model: { name: "model.onnx", path: "onnx/model.onnx", sha256: sha256Hex(g), bytes: g.length },
      tokenizer: {
        name: "tokenizer.json",
        path: "tokenizer.json",
        sha256: sha256Hex(t),
        bytes: t.length,
      },
    },
    dims: 4,
    maxTokens: 8,
    pooling: "cls",
    prefixes: { query: "", passage: "" },
    padTokenId: 0,
    inputs: ["input_ids", "attention_mask"],
    output: "last_hidden_state",
    languages: "test",
    quantization: "none",
  };
}

let dir = "";
const model = fakeModel();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "caelo-models-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function place(bytes: Uint8Array, file = model.files.model): Promise<void> {
  const path = modelFilePath(dir, model, file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
}

describe("model files", () => {
  it("names the variable when the models directory is not set", () => {
    expect(() => modelsDirFromEnv({})).toThrow(/CAELO_MODELS_DIR is not set.*models:fetch/);
    expect(modelsDirFromEnv({ CAELO_MODELS_DIR: " /opt/m " })).toBe("/opt/m");
  });

  it("lays files out by id and revision", () => {
    expect(modelFilePath("/m", model, model.files.model)).toBe(
      "/m/test-model/0123456789abcdef0123456789abcdef01234567/model.onnx",
    );
  });

  it("refuses a missing file and names the fetch command", async () => {
    await expect(readVerifiedModelFile(dir, model, model.files.model)).rejects.toThrow(
      /is missing; run `bun run models:fetch`/,
    );
  });

  it("refuses a file of another size", async () => {
    await place(new Uint8Array([1, 2, 3]));
    const e = await readVerifiedModelFile(dir, model, model.files.model).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelFileError);
    expect(String(e)).toMatch(/has 3 bytes, the catalog pins/);
  });

  it("refuses a file of the right size with another digest", async () => {
    const tampered = new Uint8Array(graph);
    tampered[0] = (tampered[0] as number) ^ 1;
    await place(tampered);
    await expect(readVerifiedModelFile(dir, model, model.files.model)).rejects.toThrow(
      /has SHA-256 [0-9a-f]{64}, the catalog pins/,
    );
  });

  it("reads verified files and parses the tokenizer", async () => {
    await place(graph);
    await place(tokenizer, model.files.tokenizer);
    const files = await readModelFiles(dir, model);
    expect([...files.graph]).toEqual([...graph]);
    expect(files.tokenizer).toEqual({ model: { type: "WordLevel" } });
  });
});
