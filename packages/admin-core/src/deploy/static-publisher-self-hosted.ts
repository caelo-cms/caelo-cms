// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.78 — self-hosted static publisher.
 *
 * Encapsulates the local-disk publish + promote + rollback behaviour
 * that lived inline in deploy.ts before v0.2.78. No behaviour change
 * for self-hosted installs (Caddy + bind-mounted out_dir): publishing
 * is a no-op (the generator subprocess already synced into
 * `<outDir>/current/`); promotion overlays the source build's files
 * into the destination's `current/` with per-target robots.txt +
 * routing-manifest patched; rollback re-syncs an archived build into
 * `current/`.
 *
 * #587 — publishing needs nothing extra for redirects: the Caddy container
 * reloads itself when a sync changes a build's `_redirects.caddy` import
 * (caddy-redirects.ts in @caelo-cms/provisioning).
 *
 * #1157 — a saved redirect goes live without a build: `syncRedirects`
 * rewrites the redirect files in the target's `current/` directory against
 * the files that directory serves, and the same reload loop picks the
 * snippet up within a few seconds.
 *
 * #1271 — a self-hosted build carries its media and fonts as hard links
 * from the media store and the fonts cache (the generator's `link`
 * delivery), so promote, rollback and plugin-data builds work on complete
 * trees as before. The build's internal files (asset references, parity
 * digests) never reach `current/`.
 */

import { existsSync } from "node:fs";
import {
  copyFile,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  CADDY_REDIRECTS_FILE,
  emitCaddyRedirects,
  emitCaddySiteHeaders,
  emitCaddyStaticFileHeaders,
  formatRedirectsFile,
  isSafeStagedPath,
  parseSiteHeaderSet,
  parseStaticFilesManifest,
  SECURITY_HEADERS_BUILD_FILE,
  type SiteHeaderSet,
  STATIC_FILES_MANIFEST_FILE,
  type StagedManifest,
} from "@caelo-cms/shared";
import { BUILD_INTERNAL_FILES } from "@caelo-cms/static-generator";
import { planRedirectSync } from "./redirect-sync-plan.js";
import { contentTypeFor } from "./static-file-policy.js";
import type {
  PromoteSummary,
  PublishSummary,
  RedirectSyncResult,
  StaticPublisher,
} from "./static-publisher.js";

export const selfHostedStaticPublisher: StaticPublisher = {
  servesCurrentDir: true,
  /**
   * For self-hosted, the generator subprocess already wrote
   * `<outDir>/builds/<runId>/` AND synced into `<outDir>/current/`
   * (see apps/static-generator/src/generate.ts:695). Caddy's
   * bind-mount serves from `current/`. So publishing is a no-op —
   * we report what was synced and where for the Ops dashboard.
   */
  async publishStaging({ buildDir, runId, target }) {
    const fileCount = await countFiles(buildDir);
    // #1330 — the staging gateway serves the build directory itself (its
    // container mounts the staging target's output directory read-only):
    // a run's directory is complete and never changes, so pointing staging
    // at it once it has its manifest is the whole publish.
    const stagingLocation =
      target.env === "staging" ? await writeBuildManifest(buildDir, runId, target) : null;
    return {
      provider: "self-hosted",
      uploadedCount: fileCount,
      skippedUnchangedCount: 0,
      location: `${target.outDir}/current/`,
      ...(stagingLocation ? { stagingLocation } : {}),
    };
  },

  async promoteToProduction({ sourceBuildDir, fromTarget, toTarget, siteBaseUrl, beforeRelease }) {
    // The sync into `current/` is the release itself.
    await beforeRelease?.();
    if (fromTarget.name === toTarget.name) {
      throw new Error("fromTarget and toTarget must differ");
    }
    // Materialise an overlay build dir on the destination that
    // mirrors the source's build but with the destination's
    // robots.txt + routing-manifest values. Then sync that overlay
    // into the destination's `current/` so Caddy serves it.
    //
    // sourceBuildDir is `<sharedRoot>/<from.outDir>/builds/<runId>`.
    // Derive toDir by splitting on `/builds/` and substituting the
    // destination's outDir for the source's. This handles any
    // `out_dir` shape (single segment, nested segments like
    // `output/staging`, or absolute paths) without assuming a
    // particular number of dirname() calls. Caught by the issue #47
    // real-AI e2e suite: with the seeded `out_dir = 'output/staging'`
    // / `out_dir = 'output/production'`, the previous
    // `dirname(dirname(dirname(...)))` walked one segment too few
    // and the `join(sharedRoot, toTarget.outDir)` produced
    // `<root>/output/output/production`. Caddy read from the
    // unpopulated `<root>/output/production` and served 404.
    const buildsIdx = sourceBuildDir.lastIndexOf(`${sep}builds${sep}`);
    if (buildsIdx < 0) {
      throw new Error(
        `selfHostedStaticPublisher.promoteToProduction: sourceBuildDir does not contain '/builds/' segment: ${sourceBuildDir}`,
      );
    }
    const sourceRootDir = sourceBuildDir.substring(0, buildsIdx);
    if (!sourceRootDir.endsWith(fromTarget.outDir)) {
      throw new Error(
        `selfHostedStaticPublisher.promoteToProduction: sourceBuildDir prefix (${sourceRootDir}) does not end with fromTarget.outDir (${fromTarget.outDir}). Cannot derive destination path.`,
      );
    }
    const sharedRoot = sourceRootDir.substring(0, sourceRootDir.length - fromTarget.outDir.length);
    const toDir = join(sharedRoot, toTarget.outDir);
    const toBuildsDir = join(toDir, "builds");
    const toCurrent = join(toDir, "current");
    const overlayBuildId = `${basename(sourceBuildDir)}-${toTarget.name}`;
    const overlayDir = join(toBuildsDir, overlayBuildId);
    const { buildRobotsTxtWithSitemap, envNoindexBuildError, manifestBakesEnvNoindex } =
      await import("@caelo-cms/static-generator");
    const manifestRaw = await Bun.file(join(sourceBuildDir, "routing-manifest.json"))
      .text()
      .catch(() => "{}");
    if (
      fromTarget.robotsDefault === "noindex" &&
      toTarget.robotsDefault === "index" &&
      manifestBakesEnvNoindex(parseJsonOrNull(manifestRaw))
    ) {
      throw envNoindexBuildError(basename(sourceBuildDir));
    }
    await mkdir(overlayDir, { recursive: true });
    await copyTreeExcept(sourceBuildDir, overlayDir, ["robots.txt", "routing-manifest.json"]);
    // The env-level staging noindex lives in robots.txt + the staging
    // vhost's X-Robots-Tag header (Caddyfile.staging) — the production
    // vhost sends no such header, so rewriting robots.txt for the
    // destination is all promote has to do.
    await writeFile(
      join(overlayDir, "robots.txt"),
      buildRobotsTxtWithSitemap(
        toTarget.robotsDefault,
        siteBaseUrl,
        existsSync(join(sourceBuildDir, "sitemap.xml")),
      ),
      "utf8",
    );
    try {
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      manifest.target = toTarget.name;
      manifest.env = toTarget.env;
      await writeFile(
        join(overlayDir, "routing-manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
    } catch {
      // Malformed manifest — overlay just won't have one.
    }
    await mkdir(toCurrent, { recursive: true });
    await syncContentsInto(overlayDir, toCurrent);
    const fileCount = await countFiles(overlayDir);
    const summary: PromoteSummary = {
      provider: "self-hosted",
      uploadedCount: fileCount,
      skippedUnchangedCount: 0,
      location: `${toTarget.outDir}/current/`,
      destinationBuildId: overlayBuildId,
    };
    return summary;
  },

  async syncRedirects({ target, rows, outputRoot }): Promise<RedirectSyncResult> {
    const currentDir = resolve(outputRoot, target.outDir, "current");
    const served = await listFiles(currentDir);
    if (served.size === 0) {
      throw new Error(
        `selfHostedStaticPublisher.syncRedirects: ${currentDir} serves no files, so the redirects cannot be checked against a published build. ${target.env === "production" ? "Publish live" : "Stage"} first; the redirects go out with it.`,
      );
    }
    const sync = planRedirectSync(rows, target.pageUrlStyle ?? "directory", served);
    // #1461 — the snippet also carries the static files' Content-Types. A
    // build from before static files has no sidecar and no such files.
    const staticFiles = await readFile(join(currentDir, STATIC_FILES_MANIFEST_FILE), "utf8").then(
      parseStaticFilesManifest,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      },
    );
    // #1454 — and the headers of the build served; none on a build from before them.
    const siteHeaders = await readSiteHeaderFile(currentDir);
    const snippet =
      emitCaddyRedirects(sync.plan) +
      emitCaddyStaticFileHeaders(staticFiles) +
      (siteHeaders ? emitCaddySiteHeaders(siteHeaders) : "");
    const table = formatRedirectsFile(rows);
    const files: readonly (readonly [string, string])[] = [
      ["_redirects", table],
      ["_redirects.cloudflare", table],
      // Last: the Caddy reload loop watches this one.
      [CADDY_REDIRECTS_FILE, snippet],
    ];
    let changed = false;
    for (const [name, body] of files) {
      const path = join(currentDir, name);
      const existing = await readFile(path, "utf8").catch(() => null);
      if (existing === body) continue;
      // Write-then-rename: the reload loop must never read a half-written snippet.
      const tmp = join(currentDir, `.${name}.${process.pid}.tmp`);
      await writeFile(tmp, body, "utf8");
      await rename(tmp, path);
      changed = true;
    }
    return {
      outcome: changed ? "applied" : "unchanged",
      redirectCount: sync.redirectCount,
      goneCount: sync.goneCount,
      shadowedCount: sync.shadowedCount,
      unservedTargets: sync.unservedTargets,
      location: `${target.outDir}/current/${CADDY_REDIRECTS_FILE}`,
    };
  },

  async readLiveFiles({ live, paths }) {
    const out = new Map<string, Buffer | null>();
    for (const path of paths) {
      const file = insideBuild(live.localBuildDir, path);
      out.set(path, existsSync(file) ? await readFile(file) : null);
    }
    return out;
  },

  /**
   * #1155 — the live build's archive copied to `builds/<runId>/` with the
   * re-baked files written over it, then mirrored into `current/` like a
   * rollback. The archive is a complete build, so the new one is too, and
   * a later rollback to this run finds it.
   */
  async publishPluginData({ target, live, runId, files, pruneBuildIds, beforeRelease }) {
    // The sync into `current/` is the release itself.
    await beforeRelease?.();
    if (!existsSync(join(live.localBuildDir, "routing-manifest.json"))) {
      throw new Error(
        `self-hosted publisher: the archive of the live build (${live.localBuildDir}) is missing, so there is nothing to publish plugin data on top of. Publish live again; the next plugin-data build then starts from that build.`,
      );
    }
    const buildDir = join(dirname(live.localBuildDir), runId);
    await mkdir(buildDir, { recursive: true });
    await copyTreeExcept(live.localBuildDir, buildDir, []);
    for (const [path, body] of files) {
      await overwriteExistingFile(insideBuild(buildDir, path), path, body);
    }
    const currentDir = join(dirname(dirname(live.localBuildDir)), "current");
    await mkdir(currentDir, { recursive: true });
    await syncContentsInto(buildDir, currentDir);
    // Each plugin-data build is a full copy of the site and the generator's
    // retention never sees them (they bypass it): drop the older ones the
    // caller named, so a busy comment section cannot fill the disk.
    for (const id of pruneBuildIds) {
      if (id === runId || id === live.buildId) continue;
      await rm(insideBuild(dirname(live.localBuildDir), id), { recursive: true, force: true });
    }
    return {
      provider: "self-hosted",
      uploadedCount: files.size,
      skippedUnchangedCount: (await countFiles(buildDir)) - files.size,
      location: `${target.outDir}/current/`,
      destinationBuildId: runId,
    };
  },

  async rollback({ sourceBuildDir, target }): Promise<PublishSummary> {
    // sourceBuildDir is `<repoRoot>/<target.outDir>/builds/<runId>`.
    // currentDir is the sibling of `builds/`.
    const currentDir = join(dirname(dirname(sourceBuildDir)), "current");
    await mkdir(currentDir, { recursive: true });
    await syncContentsInto(sourceBuildDir, currentDir);
    const fileCount = await countFiles(sourceBuildDir);
    return {
      provider: "self-hosted",
      uploadedCount: fileCount,
      skippedUnchangedCount: 0,
      location: `${target.outDir}/current/`,
    };
  },
};

/**
 * Replaces the contents of a file the build already has. Opening with `r+`
 * (no create flag) makes "the file exists" and "write it" one step, so a
 * path the live build lacks fails here instead of being created between a
 * check and the write.
 */
async function overwriteExistingFile(file: string, path: string, body: Buffer): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `self-hosted publisher: ${path} is not a file of the live build — a plugin-data build only replaces files the build has`,
      );
    }
    throw err;
  }
  try {
    await handle.truncate(0);
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
}

/** `path` under `dir`, refusing anything that would leave it. */
function insideBuild(dir: string, path: string): string {
  const root = resolve(dir);
  const file = resolve(root, path);
  if (!file.startsWith(`${root}${sep}`)) {
    throw new Error(`self-hosted publisher: "${path}" is outside the build directory`);
  }
  return file;
}

function parseJsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * #1330 — write the manifest the staging gateway serves `buildDir` by
 * (`builds/<runId>.manifest.json`, next to the build in the staging
 * target's output directory) and return the build's location there. The
 * build's internal files are left out, so the gateway never serves them;
 * manifests of builds the generator has pruned are deleted.
 */
async function writeBuildManifest(
  buildDir: string,
  runId: string,
  target: { readonly pageUrlStyle?: "directory" | "no-extension" | null },
): Promise<string> {
  const files = await listFiles(buildDir);
  for (const name of BUILD_INTERNAL_FILES) files.delete(name);
  const overrides: Record<string, string> = await readFile(
    join(buildDir, "_content-types.json"),
    "utf8",
  ).then(
    (t) => JSON.parse(t) as Record<string, string>,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return {};
      throw e;
    },
  );
  const entries: Record<string, { type: string; hash: string }> = {};
  for (const path of [...files].sort()) {
    if (!isSafeStagedPath(path)) {
      throw new Error(
        `self-hosted publisher: the build has a file the staging gateway may not serve (${JSON.stringify(path)}). Re-run the build.`,
      );
    }
    // The directory is the run's own and never changes: nothing to diff.
    entries[path] = { type: overrides[path] ?? contentTypeFor(path), hash: runId };
  }
  const location = `builds/${runId}`;
  const buildsDir = dirname(buildDir);
  const siteHeaders = await readSiteHeaderFile(buildDir);
  const manifest: StagedManifest = {
    version: 1,
    runId,
    pageUrlStyle: target.pageUrlStyle ?? "directory",
    files: entries,
    ...(siteHeaders ? { securityHeaders: siteHeaders.headers } : {}),
  };
  const manifestPath = join(buildsDir, `${runId}.manifest.json`);
  await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest), "utf8");
  await rename(`${manifestPath}.tmp`, manifestPath);
  for (const entry of await readdir(buildsDir)) {
    const id = entry.endsWith(".manifest.json") ? entry.slice(0, -".manifest.json".length) : null;
    if (id && id !== runId && !existsSync(join(buildsDir, id))) {
      await rm(join(buildsDir, entry), { force: true });
    }
  }
  return location;
}

/** Every file below `dir`, relative and `/`-separated; empty when `dir` is missing. */
async function listFiles(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else out.add(childRel);
    }
  };
  await walk("");
  return out;
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else n += 1;
    }
  };
  await walk("");
  return n;
}

/**
 * Copy every file in `src` into `dst` at the same relative path,
 * skipping the names listed in `exceptNames` at the root level.
 */
async function copyTreeExcept(src: string, dst: string, exceptNames: string[]): Promise<void> {
  const skip = new Set(exceptNames);
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(src, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (rel === "" && skip.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await mkdir(join(dst, childRel), { recursive: true });
        await walk(childRel);
      } else {
        await mkdir(join(dst, childRel, ".."), { recursive: true });
        await copyFile(join(src, childRel), join(dst, childRel));
      }
    }
  };
  await walk("");
}

/**
 * Mirror `src` into `dst` so dst contains exactly src's tree, in
 * place — no rmtree of dst (which would break Caddy's bind-mount).
 * Used by promote and rollback.
 */
async function syncContentsInto(src: string, dst: string): Promise<void> {
  const tryRm = async (path: string, opts: Parameters<typeof rm>[1] = {}) => {
    try {
      await rm(path, opts);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EFAULT" && code !== "ENOENT") throw e;
    }
  };
  const srcFiles = new Set<string>();
  const collect = async (rel: string): Promise<void> => {
    const entries = await readdir(join(src, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await collect(childRel);
      else srcFiles.add(childRel);
    }
  };
  await collect("");
  // Not part of the site (see the module comment).
  for (const name of BUILD_INTERNAL_FILES) srcFiles.delete(name);
  for (const rel of srcFiles) {
    await mkdir(join(dst, rel, ".."), { recursive: true });
    await copyFile(join(src, rel), join(dst, rel));
  }
  // Sweep dst for stale files no longer in src.
  const sweep = async (rel: string): Promise<void> => {
    const here = join(dst, rel);
    if (!(await stat(here).catch(() => null))) return;
    const entries = await readdir(here, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await sweep(childRel);
      } else if (!srcFiles.has(childRel)) {
        await tryRm(join(dst, childRel));
      }
    }
  };
  await sweep("");
}

/** #1454 — the headers `dir` holds, or null for a build from before them. */
async function readSiteHeaderFile(dir: string): Promise<SiteHeaderSet | null> {
  return readFile(join(dir, SECURITY_HEADERS_BUILD_FILE), "utf8").then(
    parseSiteHeaderSet,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    },
  );
}
