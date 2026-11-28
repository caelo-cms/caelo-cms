// SPDX-License-Identifier: MPL-2.0

/**
 * Where a catalog model's files live and how they are checked (#1650).
 *
 * Layout: `<CAELO_MODELS_DIR>/<model id>/<revision>/<file name>`. The images
 * set `CAELO_MODELS_DIR` and carry the files (fetched and verified at image
 * build); a development checkout fetches them once with
 * `bun run models:fetch`. There is no download at run time: a process that
 * finds a file missing or different fails loudly and names the command,
 * because a model fetched by a running gateway would be a supply-chain path
 * nobody reviewed.
 *
 * A process loads the derived files (#1782, derive.ts): the graph without
 * its token table, the table, and the compact tokenizer. The publisher's
 * graph and `tokenizer.json` are only the source they are derived from at
 * fetch time; images do not carry them.
 *
 * Every load re-hashes what it hands to ONNX Runtime, so a file that
 * changed on disk after the build (a corrupt layer, a dev cache edited by
 * hand) is refused, not embedded with. The token table is hashed as a
 * stream and then read row by row: it is never held in memory whole.
 */

import { open } from "node:fs/promises";
import { join } from "node:path";
import type { EmbeddingDerivedFile, EmbeddingModel, EmbeddingModelFile } from "@caelo-cms/shared";

/** The env var naming the models directory. */
export const MODELS_DIR_ENV = "CAELO_MODELS_DIR";

/** A model file is missing, has the wrong size or the wrong digest. */
export class ModelFileError extends Error {
  override readonly name = "ModelFileError";
}

/** The models directory from the environment; throws naming the variable when it is not set. */
export function modelsDirFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir = env[MODELS_DIR_ENV]?.trim();
  if (!dir) {
    throw new ModelFileError(
      `${MODELS_DIR_ENV} is not set: it names the directory holding the embedding models (the images set it; in a checkout run \`bun run models:fetch\` and set it to the directory it prints)`,
    );
  }
  return dir;
}

/** The directory of one model's files. */
export function modelDir(dir: string, model: EmbeddingModel): string {
  return join(dir, model.id, model.source.revision);
}

/** The path of one of a model's files (the publisher's or a derived one). */
export function modelFilePath(
  dir: string,
  model: EmbeddingModel,
  file: EmbeddingModelFile | EmbeddingDerivedFile,
): string {
  return join(modelDir(dir, model), file.name);
}

/** SHA-256 of bytes, lowercase hex. */
export function sha256Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function fixOf(model: EmbeddingModel): string {
  return `run \`bun run models:fetch\` (or rebuild the image) so ${model.id} is fetched again`;
}

/** Reads one model file and checks its size and digest; throws a {@link ModelFileError}. */
export async function readVerifiedModelFile(
  dir: string,
  model: EmbeddingModel,
  file: EmbeddingModelFile | EmbeddingDerivedFile,
): Promise<Uint8Array> {
  const path = modelFilePath(dir, model, file);
  const fix = fixOf(model);
  // One open file for the size check and the read: what is checked is what
  // is read (and the digest below is taken of exactly those bytes).
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    throw new ModelFileError(`embedding model ${model.id}: ${path} is missing; ${fix}`);
  }
  let data: Uint8Array;
  try {
    const { size } = await handle.stat();
    if (size !== file.bytes) {
      throw new ModelFileError(
        `embedding model ${model.id}: ${path} has ${size} bytes, the catalog pins ${file.bytes}; ${fix}`,
      );
    }
    data = new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
  const digest = sha256Hex(data);
  if (digest !== file.sha256) {
    throw new ModelFileError(
      `embedding model ${model.id}: ${path} has SHA-256 ${digest}, the catalog pins ${file.sha256}; ${fix}`,
    );
  }
  return data;
}

/**
 * Checks a file's size and digest without holding it: hashed in chunks of
 * a few megabytes. Returns its path.
 */
export async function verifyModelFileInPlace(
  dir: string,
  model: EmbeddingModel,
  file: EmbeddingModelFile | EmbeddingDerivedFile,
): Promise<string> {
  const path = modelFilePath(dir, model, file);
  const fix = fixOf(model);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    throw new ModelFileError(`embedding model ${model.id}: ${path} is missing; ${fix}`);
  }
  try {
    const { size } = await handle.stat();
    if (size !== file.bytes) {
      throw new ModelFileError(
        `embedding model ${model.id}: ${path} has ${size} bytes, the catalog pins ${file.bytes}; ${fix}`,
      );
    }
    const hasher = new Bun.CryptoHasher("sha256");
    const chunk = new Uint8Array(4 * 1024 * 1024);
    for (let at = 0; at < size; ) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, at);
      if (bytesRead === 0) break;
      hasher.update(chunk.subarray(0, bytesRead));
      at += bytesRead;
    }
    const digest = hasher.digest("hex");
    if (digest !== file.sha256) {
      throw new ModelFileError(
        `embedding model ${model.id}: ${path} has SHA-256 ${digest}, the catalog pins ${file.sha256}; ${fix}`,
      );
    }
  } finally {
    await handle.close();
  }
  return path;
}

/** What a process loads of a model, verified. */
export interface LoadableModelFiles {
  /** The derived graph's bytes (handed to ONNX Runtime, then dropped). */
  readonly graph: Uint8Array;
  /** The compact tokenizer's bytes. */
  readonly tokenizer: Uint8Array;
  /** The verified token table, read row by row from here. */
  readonly tablePath: string;
}

/** The derived files of a model, verified. */
export async function readModelFiles(
  dir: string,
  model: EmbeddingModel,
): Promise<LoadableModelFiles> {
  const d = model.derived;
  const [graph, tokenizer, tablePath] = await Promise.all([
    readVerifiedModelFile(dir, model, d.graph),
    readVerifiedModelFile(dir, model, d.tokenizer),
    verifyModelFileInPlace(dir, model, d.table),
  ]);
  return { graph, tokenizer, tablePath };
}
