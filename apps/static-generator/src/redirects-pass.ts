// SPDX-License-Identifier: MPL-2.0

/**
 * Write the redirects table into the build (#587).
 *
 * - `_redirects` — the table dump (`<from> <to> <status>` per line). The
 *   cloud publishers read it and build the redirect plan against the build
 *   they deploy (Firebase Hosting config, GCP URL map, …).
 * - `_redirects.cloudflare` — the same content under the name Cloudflare
 *   Pages / Netlify operators look for.
 * - `_redirects.caddy` — the plan as a Caddyfile snippet the self-hosted
 *   site blocks import (redirect-emit-caddy.ts in @caelo-cms/shared).
 *
 * #1157 — a redirects save also puts the table live without a build
 * (admin-core deploy/redirect-sync.ts); the copies here are what a build
 * carries, and Publish live re-syncs the table as saved now.
 *
 * Runs after every other file of the build is written: the plan leaves out
 * rows whose from path a build file serves (the live page wins), so it needs
 * the complete file list.
 */

import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRedirectPlan,
  CADDY_REDIRECTS_FILE,
  emitCaddyRedirects,
  formatRedirectsFile,
  type RedirectPageUrlStyle,
  type RedirectTableRow,
} from "@caelo-cms/shared";

/**
 * Write the redirect files into `buildDir`.
 *
 * @returns how many files were written.
 * @throws when a row cannot be served (see `buildRedirectPlan`).
 */
export async function writeRedirectFiles(args: {
  readonly buildDir: string;
  readonly rows: readonly RedirectTableRow[];
  readonly pageUrlStyle: RedirectPageUrlStyle;
}): Promise<number> {
  const table = formatRedirectsFile(args.rows);
  await writeFile(join(args.buildDir, "_redirects"), table, "utf8");
  await writeFile(join(args.buildDir, "_redirects.cloudflare"), table, "utf8");
  const plan = buildRedirectPlan({
    rows: args.rows,
    pageUrlStyle: args.pageUrlStyle,
    servedFiles: await listBuildFiles(args.buildDir),
  });
  await writeFile(join(args.buildDir, CADDY_REDIRECTS_FILE), emitCaddyRedirects(plan), "utf8");
  return 3;
}

/** Every file below `root`, relative, `/`-separated, no leading slash. */
export async function listBuildFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else files.add(childRel);
    }
  };
  await walk("");
  return files;
}
