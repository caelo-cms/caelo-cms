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
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddingModel, EmbeddingModelFile } from "@caelo-cms/shared";
import { ModelFileError, modelDir, modelFilePath, readVerifiedModelFile } from "./files.js";

/** Where a file of the catalog is downloaded from. */
export function sourceUrl(model: EmbeddingModel, file: EmbeddingModelFile): string {
  const { host, repo, revision } = model.source;
  return `https://${host}/${repo}/resolve/${revision}/${file.path}`;
}

/** What {@link fetchModel} did with each file. */
export interface FetchedFile {
  readonly file: string;
  readonly action: "present" | "downloaded";
  readonly bytes: number;
}

/** Downloads every file of `model` into `dir` that is not already there and verified. */
export async function fetchModel(
  dir: string,
  model: EmbeddingModel,
  deps: { readonly fetch?: typeof fetch } = {},
): Promise<FetchedFile[]> {
  const doFetch = deps.fetch ?? fetch;
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
    `Files: ${model.files.model.path} (SHA-256 ${model.files.model.sha256}), ${model.files.tokenizer.path} (SHA-256 ${model.files.tokenizer.sha256})`,
    `${model.copyright.replace(/\.?$/, ".")} Licensed under the ${model.licence} licence (${model.licenceUrl}); redistributed unmodified.`,
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
