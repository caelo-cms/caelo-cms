// SPDX-License-Identifier: MPL-2.0

/**
 * Fetches every catalog embedding model into a directory and verifies it
 * (#1650). Run by the admin and gateway Dockerfiles, by CI before the tests
 * that load a model, and once in a development checkout:
 *
 *   bun run models:fetch                     # into $CAELO_MODELS_DIR, or ./.caelo-models
 *   bun packages/models/scripts/fetch-models.ts --dir /opt/caelo/models
 *
 * `--licenses <dir>` writes each model's NOTICE.txt (licence and source)
 * from `<dir>/<licence>.txt`, as the images do. Prints the directory to set as CAELO_MODELS_DIR. Exits non-zero when a
 * file cannot be fetched or does not match the catalog. `--epoch` stamps
 * every file and directory with one fixed time, so an image layer of the
 * same models has the same digest in every build (#1559).
 */

import { readdir, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
// The subpath (data only, no dependency): the Dockerfiles' `models` stage
// runs this script with nothing installed but that file.
import { EMBEDDING_MODELS } from "@caelo-cms/shared/embedding-models";
import { fetchModel, writeModelNotice } from "../src/fetch.js";
import { MODELS_DIR_ENV } from "../src/files.js";

const args = process.argv.slice(2);
const at = args.indexOf("--dir");
const dir = resolve(
  at >= 0 && args[at + 1]
    ? (args[at + 1] as string)
    : (process.env[MODELS_DIR_ENV] ?? ".caelo-models"),
);
const licensesAt = args.indexOf("--licenses");
const licenses = licensesAt >= 0 ? (args[licensesAt + 1] ?? null) : null;
let failed = false;
for (const model of EMBEDDING_MODELS) {
  try {
    const files = await fetchModel(dir, model);
    for (const f of files) {
      console.log(`${model.id}: ${f.file} ${f.action} (${(f.bytes / 1e6).toFixed(1)} MB)`);
    }
    if (licenses) await writeModelNotice(dir, model, resolve(licenses));
  } catch (e) {
    failed = true;
    console.error(`${model.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failed) process.exit(1);
if (args.includes("--epoch")) {
  // 2000-01-01, the time the image's other reproducible layers use.
  const epoch = new Date(946_684_800_000);
  const stamp = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await stamp(child);
      await utimes(child, epoch, epoch);
    }
  };
  await stamp(dir);
  await utimes(dir, epoch, epoch);
}
console.log(`${MODELS_DIR_ENV}=${dir}`);
