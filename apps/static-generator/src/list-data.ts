// SPDX-License-Identifier: MPL-2.0

/**
 * Lists in a deploy build (epic #1107, `docs/lists.md` §10): the build's
 * list render data and its render dependencies.
 *
 * The generator runs outside admin-core (subprocess), so — like the link
 * index (`link-index.ts`) — it loads the main-line, published state
 * itself; admin-core's `lists/load.ts` is the draft-aware twin for the
 * editor preview. Both feed the same shared resolver
 * (`createListRenderContext`), which is what keeps preview and build HTML
 * equal.
 *
 * Render dependencies: every built page's {@link ListRenderDeps} are
 * merged into `render-deps.json`, written into the build directory (the
 * build manifest's place) and next to the target's builds
 * (`<outDir>/render-deps.json`), where the next incremental build of the
 * target reads them to find the pages a change reaches.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type ListRenderData,
  type ListRenderDeps,
  mergeRenderDeps,
  parseRenderDeps,
  RENDER_DEPS_FILE,
  type RenderDepsFile,
  renderDepsAttrs,
  selectDependentPages,
} from "@caelo-cms/shared";

/**
 * Load the list render data of a build: list types, lists, page types,
 * pages (published = `inBuild`), media metadata, the `link-resolve` page
 * partition and the `list-resolve` overlays, main line only.
 *
 * FIXME(issue #1109): part B of epic #1107 implements the loader (it owns
 * the tables); until it merges, every build fails here loudly.
 */
export async function loadBuildListRenderData(
  _tx: TransactionRunner,
  _opts: { readonly env: "dev" | "staging" | "production" },
): Promise<ListRenderData> {
  throw new Error("loadBuildListRenderData: implemented by part B (#1109)");
}

/** What changed since the target's last build, as the redeploy trigger reports it. */
export interface BuildChange {
  readonly pageIds: readonly string[];
  readonly listIds: readonly string[];
  readonly listTypeIds: readonly string[];
}

/** True when the build is incremental (anything named as changed). */
export function isIncremental(change: BuildChange): boolean {
  return change.pageIds.length + change.listIds.length + change.listTypeIds.length > 0;
}

/** The target-level deps file (the last build's view), or null. */
export async function readTargetRenderDeps(outDir: string): Promise<RenderDepsFile | null> {
  let raw: string | null = null;
  try {
    raw = await readFile(join(outDir, RENDER_DEPS_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return parseRenderDeps(raw);
}

/**
 * The pages an incremental build renders: the changed pages plus every
 * page whose recorded deps intersect the change. Without a deps file (the
 * target was never built with deps) dependents cannot be known, so the
 * build renders every page — a superset, never a stale page.
 *
 * @returns the page ids, or null for "every page".
 */
export function incrementalPageIds(
  change: BuildChange,
  deps: RenderDepsFile | null,
  data: ListRenderData,
): string[] | null {
  if (deps === null) return null;
  const typeSlugs: string[] = [];
  for (const t of data.listTypes.values()) {
    if (change.listTypeIds.includes(t.id)) typeSlugs.push(t.def.slug);
  }
  const current = new Map([...data.pages.values()].map((p) => [p.id, renderDepsAttrs(p)]));
  const dependents = selectDependentPages(
    deps,
    { pageIds: change.pageIds, listIds: change.listIds, listTypeSlugs: typeSlugs },
    current,
  );
  return [...new Set([...change.pageIds, ...dependents])];
}

/**
 * Merge this build's per-page deps into the target's file and write it to
 * the build directory and the target directory.
 */
export async function writeRenderDeps(args: {
  readonly outDir: string;
  readonly buildDir: string;
  readonly previous: RenderDepsFile | null;
  readonly rebuilt: ReadonlyMap<string, ListRenderDeps>;
  readonly data: ListRenderData;
  /** A full build replaces the previous file instead of merging into it. */
  readonly full: boolean;
}): Promise<void> {
  const merged = mergeRenderDeps(
    args.full ? null : args.previous,
    args.rebuilt,
    args.data.pages.values(),
  );
  const json = JSON.stringify(merged);
  await writeFile(join(args.buildDir, RENDER_DEPS_FILE), json, "utf8");
  await writeFile(join(args.outDir, RENDER_DEPS_FILE), json, "utf8");
}
