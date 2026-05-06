// SPDX-License-Identifier: MPL-2.0

/**
 * Single-string version constant. Intentionally NOT imported from
 * `@caelo-cms/shared` — keeps `@caelo-cms/provisioning` self-contained
 * on npm so `bunx @caelo-cms/provisioning` doesn't drag in a workspace
 * dep (which only resolves inside the monorepo). The release script
 * walks every workspace package.json and bumps them in lockstep, so
 * this constant tracks `CAELO_VERSION` from `@caelo-cms/shared` by
 * convention, not import.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// dist/version.js → ../package.json (npm layout) | src/version.ts → ../package.json (dev layout).
const pkgJson = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as {
  version: string;
};

export const CAELO_VERSION: string = pkgJson.version;
