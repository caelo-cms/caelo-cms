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
 */

import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PromoteSummary, PublishSummary, StaticPublisher } from "./static-publisher.js";

export const selfHostedStaticPublisher: StaticPublisher = {
  /**
   * For self-hosted, the generator subprocess already wrote
   * `<outDir>/builds/<runId>/` AND synced into `<outDir>/current/`
   * (see apps/static-generator/src/generate.ts:695). Caddy's
   * bind-mount serves from `current/`. So publishing is a no-op —
   * we report what was synced and where for the Ops dashboard.
   */
  async publishStaging({ buildDir, target }) {
    const fileCount = await countFiles(buildDir);
    return {
      provider: "self-hosted",
      uploadedCount: fileCount,
      skippedUnchangedCount: 0,
      location: `${target.outDir}/current/`,
    };
  },

  async promoteToProduction({ sourceBuildDir, fromTarget, toTarget }) {
    if (fromTarget.name === toTarget.name) {
      throw new Error("fromTarget and toTarget must differ");
    }
    // Materialise an overlay build dir on the destination that
    // mirrors the source's build but with the destination's
    // robots.txt + routing-manifest values. Then sync that overlay
    // into the destination's `current/` so Caddy serves it.
    //
    // sourceBuildDir is `<repoRoot>/<from.outDir>/builds/<runId>`.
    // Walk up two levels to get the deploy ops' shared repo root,
    // then resolve the destination's outDir under it. Avoids
    // depending on process.cwd() which may not match the test's
    // repoRoot.
    const sharedRoot = dirname(dirname(dirname(sourceBuildDir)));
    const toDir = join(sharedRoot, toTarget.outDir);
    const toBuildsDir = join(toDir, "builds");
    const toCurrent = join(toDir, "current");
    const overlayBuildId = `${basename(sourceBuildDir)}-${toTarget.name}`;
    const overlayDir = join(toBuildsDir, overlayBuildId);
    await mkdir(overlayDir, { recursive: true });
    const { buildRobotsTxt } = await import("@caelo-cms/static-generator");
    await copyTreeExcept(sourceBuildDir, overlayDir, ["robots.txt", "routing-manifest.json"]);
    await writeFile(join(overlayDir, "robots.txt"), buildRobotsTxt(toTarget.robotsDefault), "utf8");
    const manifestRaw = await Bun.file(join(sourceBuildDir, "routing-manifest.json"))
      .text()
      .catch(() => "{}");
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

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
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
