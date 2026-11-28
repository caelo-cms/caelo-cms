// SPDX-License-Identifier: MPL-2.0

/**
 * #1650, #1782 — model files are used only as the catalog pins them, and a
 * model missing from disk fails loudly with the command that fetches it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveModelFiles } from "./derive.js";
import {
  ModelFileError,
  modelFilePath,
  modelsDirFromEnv,
  readModelFiles,
  readVerifiedModelFile,
  verifyModelFileInPlace,
} from "./files.js";
import { tinyModel } from "./tiny-model.js";

const { model, graph } = tinyModel();

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "caelo-models-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function place(
  bytes: Uint8Array,
  file: Parameters<typeof modelFilePath>[2] = model.files.model,
): Promise<void> {
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

  it("reads the derived files a process loads, the table checked in place", async () => {
    const json = JSON.parse(new TextDecoder().decode(tinyModel().tokenizer)) as unknown;
    const derived = deriveModelFiles(model, graph, json);
    await place(derived.graph, model.derived.graph);
    await place(derived.tokenizer, model.derived.tokenizer);
    await place(derived.table, model.derived.table);
    const files = await readModelFiles(dir, model);
    expect([...files.graph]).toEqual([...derived.graph]);
    expect([...files.tokenizer]).toEqual([...derived.tokenizer]);
    expect(files.tablePath).toBe(modelFilePath(dir, model, model.derived.table));
  });

  it("checks a file in place without reading it whole", async () => {
    const table = new Uint8Array(model.derived.table.bytes);
    await place(table, model.derived.table);
    await expect(verifyModelFileInPlace(dir, model, model.derived.table)).rejects.toThrow(
      /has SHA-256 [0-9a-f]{64}, the catalog pins/,
    );
  });
});
