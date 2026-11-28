// SPDX-License-Identifier: MPL-2.0

/**
 * Fetches a catalog model's files once and verifies them (#1650): at image
 * build (the Dockerfiles run `scripts/fetch-models.ts`), in CI and in a
 * development checkout. Never at run time (files.ts says why).
 *
 * The download comes from the publisher's repository at the pinned
 * revision. The host it redirects to (a CDN) is not trusted with anything:
 * the bytes count only when their size and SHA-256 equal the catalog's, and
 * a file lands under its final name only then (written beside it, renamed
 * once verified), so an interrupted or tampered download never looks like a
 * model.
 *
 * Then the files a process loads are derived from them (#1782, derive.ts)
 * and checked against the catalog's pins the same way. `runtimeOnly`
 * removes the publisher's files afterwards: an image carries only what it
 * loads.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddingModel, EmbeddingModelFile } from "@caelo-cms/shared";
import { deriveModelFiles } from "./derive.js";
import {
  ModelFileError,
  modelDir,
  modelFilePath,
  readVerifiedModelFile,
  verifyModelFileInPlace,
} from "./files.js";

/** Where a file of the catalog is downloaded from. */
export function sourceUrl(model: EmbeddingModel, file: EmbeddingModelFile): string {
  const { host, repo, revision } = model.source;
  return `https://${host}/${repo}/resolve/${revision}/${file.path}`;
}

/** What {@link fetchModel} did with each file. */
export interface FetchedFile {
  readonly file: string;
  readonly action: "present" | "downloaded" | "derived" | "removed";
  readonly bytes: number;
}

/** Whether a file is there and verified. */
async function verified(
  dir: string,
  model: EmbeddingModel,
  file: EmbeddingModel["files"]["model"] | EmbeddingModel["derived"]["graph"],
): Promise<boolean> {
  return verifyModelFileInPlace(dir, model, file).then(
    () => true,
    () => false,
  );
}

/** Writes `data` under `path`, beside it first and renamed into place. */
async function place(path: string, data: Uint8Array): Promise<void> {
  const partial = `${path}.part-${crypto.randomUUID()}`;
  try {
    await writeFile(partial, data);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * Downloads every file of `model` into `dir` that is not already there and
 * verified, then derives the files a process loads. With `runtimeOnly` the
 * publisher's files are removed once the derived ones are in place.
 */
export async function fetchModel(
  dir: string,
  model: EmbeddingModel,
  deps: { readonly fetch?: typeof fetch; readonly runtimeOnly?: boolean } = {},
): Promise<FetchedFile[]> {
  const d = model.derived;
  const derivedFiles = [d.graph, d.table, d.tokenizer];
  const present = (await Promise.all(derivedFiles.map((f) => verified(dir, model, f)))).every(
    Boolean,
  );
  // An image's stage that already holds the derived files needs nothing of the publisher.
  const out =
    present && deps.runtimeOnly ? [] : await fetchPublisherFiles(dir, model, deps.fetch ?? fetch);
  if (present) {
    for (const f of derivedFiles) out.push({ file: f.name, action: "present", bytes: f.bytes });
  } else {
    const graph = await readVerifiedModelFile(dir, model, model.files.model);
    const tokenizer = JSON.parse(
      new TextDecoder().decode(await readVerifiedModelFile(dir, model, model.files.tokenizer)),
    ) as unknown;
    const derived = deriveModelFiles(model, graph, tokenizer);
    await place(modelFilePath(dir, model, d.graph), derived.graph);
    await place(modelFilePath(dir, model, d.table), derived.table);
    await place(modelFilePath(dir, model, d.tokenizer), derived.tokenizer);
    for (const f of derivedFiles) out.push({ file: f.name, action: "derived", bytes: f.bytes });
  }
  if (deps.runtimeOnly) {
    for (const f of [model.files.model, model.files.tokenizer]) {
      await rm(modelFilePath(dir, model, f), { force: true });
      out.push({ file: f.name, action: "removed", bytes: f.bytes });
    }
  }
  return out;
}

async function fetchPublisherFiles(
  dir: string,
  model: EmbeddingModel,
  doFetch: typeof fetch,
): Promise<FetchedFile[]> {
  const out: FetchedFile[] = [];
  for (const file of [model.files.model, model.files.tokenizer]) {
    const path = modelFilePath(dir, model, file);
    const present = await stat(path).then(
      () => true,
      () => false,
    );
    if (present) {
      // A present file that fails verification is replaced, not trusted.
      const ok = await readVerifiedModelFile(dir, model, file).then(
        () => true,
        () => false,
      );
      if (ok) {
        out.push({ file: file.name, action: "present", bytes: file.bytes });
        continue;
      }
    }
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.part-${crypto.randomUUID()}`;
    try {
      const url = sourceUrl(model, file);
      const response = await doFetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new ModelFileError(`fetch ${url}: HTTP ${response.status}`);
      }
      const hasher = new Bun.CryptoHasher("sha256");
      const sink = Bun.file(partial).writer();
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > file.bytes) {
          throw new ModelFileError(
            `fetch ${url}: more than the ${file.bytes} bytes the catalog pins`,
          );
        }
        hasher.update(chunk);
        sink.write(chunk);
      }
      await sink.end();
      const digest = hasher.digest("hex");
      if (bytes !== file.bytes || digest !== file.sha256) {
        throw new ModelFileError(
          `fetch ${url}: got ${bytes} bytes with SHA-256 ${digest}, the catalog pins ${file.bytes} bytes with ${file.sha256}`,
        );
      }
      await rename(partial, path);
      out.push({ file: file.name, action: "downloaded", bytes });
    } finally {
      await rm(partial, { force: true });
    }
  }
  return out;
}

/** The file next to a model's files that carries its licence (`NOTICE.txt`). */
export const MODEL_NOTICE = "NOTICE.txt";

/**
 * The notice that travels with a model in an image: what it is, where it
 * came from (repository and revision), its copyright and the full licence
 * text. Apache-2.0 §4 and MIT both ask for the licence with every copy; the
 * Hugging Face repositories carry it only as a tag, so the text comes from
 * the repo's `licenses/` (`<licence>.txt`), not the network.
 */
export function modelNotice(model: EmbeddingModel, licenceText: string): string {
  const { host, repo, revision } = model.source;
  return [
    `${model.label} (${model.id})`,
    `Source: https://${host}/${repo} at revision ${revision}`,
    `Derived from: ${model.files.model.path} (SHA-256 ${model.files.model.sha256}), ${model.files.tokenizer.path} (SHA-256 ${model.files.tokenizer.sha256})`,
    `${model.copyright.replace(/\.?$/, ".")} Licensed under the ${model.licence} licence (${model.licenceUrl}).`,
    `Modified by the Caelo CMS project: ${model.derived.graph.name} is the publisher's graph without its token table (the ${model.derived.gather} node and its initializer), whose gathered rows are its input ${model.derived.tableInput}; ${model.derived.table.name} is that table, byte for byte; ${model.derived.tokenizer.name} holds the vocabulary, merges, added tokens and template of tokenizer.json in a compact binary form. The weights and the computation are unchanged.`,
    "",
    licenceText.trimEnd(),
    "",
  ].join("\n");
}

/** Writes {@link MODEL_NOTICE} for `model` from `licensesDir/<licence>.txt`. */
export async function writeModelNotice(
  dir: string,
  model: EmbeddingModel,
  licensesDir: string,
): Promise<void> {
  const text = await readFile(join(licensesDir, `${model.licence}.txt`), "utf8").catch(() => {
    throw new ModelFileError(
      `no licence text ${model.licence}.txt in ${licensesDir} for ${model.id}`,
    );
  });
  await writeFile(join(modelDir(dir, model), MODEL_NOTICE), modelNotice(model, text));
}
