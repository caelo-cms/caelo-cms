// SPDX-License-Identifier: MPL-2.0

/**
 * For tests that load a real catalog model (#1650). Locally they run when
 * `CAELO_MODELS_DIR` names a directory `bun run models:fetch` filled, and
 * skip with a warning otherwise; CI sets `CAELO_MODELS=required`, which
 * turns a missing model into a failure, so these suites never silently stop
 * running there.
 */

import { existsSync } from "node:fs";
import type { EmbeddingModel } from "@caelo-cms/shared";
import { MODELS_DIR_ENV, modelFilePath } from "./files.js";

/** Where the test models are, and whether a test must have them. */
export function modelsForTests(
  model: EmbeddingModel,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly dir: string | null; readonly required: boolean } {
  const dir = env[MODELS_DIR_ENV]?.trim() || null;
  const required = env.CAELO_MODELS === "required";
  const present =
    dir !== null &&
    existsSync(modelFilePath(dir, model, model.derived.graph)) &&
    existsSync(modelFilePath(dir, model, model.derived.table)) &&
    existsSync(modelFilePath(dir, model, model.derived.tokenizer));
  if (!present && !required) {
    console.warn(
      `[models] SKIPPED: ${model.id} is not fetched, so tests that embed are untested in this run. Run \`bun run models:fetch\` and export ${MODELS_DIR_ENV}=<the directory it prints>.`,
    );
  }
  return { dir: present ? dir : null, required };
}
