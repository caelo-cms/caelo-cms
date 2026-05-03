// SPDX-License-Identifier: MPL-2.0

/**
 * `MediaStorageAdapter` interface lives in `@caelo-cms/shared` so the
 * static generator + browser-side admin can read the URL convention.
 * The filesystem-bound implementation lives here because it imports
 * `node:fs/promises` (Bun-side only).
 *
 * On disk: `<rootDir>/<sha>/<variant>.<ext>`. The directory is
 * created on first put; cleanup is the caller's responsibility (the
 * delete op walks variants and unlinks).
 *
 * Cloud-bucket adapters (S3, GCS, Azure Blob) will land in P15 and
 * implement the same shape.
 */

import { mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MediaStorageAdapter } from "@caelo-cms/shared";
import { Glob } from "bun";

export class LocalVolumeAdapter implements MediaStorageAdapter {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = resolve(rootDir);
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  #pathFor(key: string): string {
    // Containment guard — reject keys that escape the root.
    const target = resolve(this.#rootDir, key);
    if (!target.startsWith(`${this.#rootDir}/`) && target !== this.#rootDir) {
      throw new Error(`storage key escapes rootDir: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Uint8Array, _contentType: string): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, body);
  }

  async get(key: string): Promise<Uint8Array> {
    const path = this.#pathFor(key);
    const buf = await readFile(path);
    return new Uint8Array(buf);
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    try {
      await unlink(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  // P7 review-pass: cache the directory scan for 60 s so the Owner
  // panel doesn't re-walk the tree on every render. Tradeoff: the
  // panel may show stale numbers right after an upload; acceptable
  // for a stats surface.
  #cache: { value: number; expiresAt: number } | null = null;
  async totalSizeBytes(): Promise<number> {
    const now = Date.now();
    if (this.#cache && this.#cache.expiresAt > now) return this.#cache.value;
    let total = 0;
    const glob = new Glob("**/*");
    for await (const file of glob.scan({ cwd: this.#rootDir, absolute: true })) {
      try {
        const s = await stat(file);
        if (s.isFile()) total += s.size;
      } catch {
        // Skip files that vanished mid-scan.
      }
    }
    this.#cache = { value: total, expiresAt: now + 60_000 };
    return total;
  }

  /**
   * Removes all files under a given sha-prefixed directory.
   *
   * FIXME(orphan-scrubber): not currently called. The plan deferred a
   * periodic orphan-blob scrubber that walks `media_assets.storage_key`
   * vs `storage.exists()` and reconciles. When the first installation
   * hits the rare orphan case (transaction-rollback after pipeline
   * succeeded, or manual file delete), the scrubber lands and uses
   * this method.
   */
  async pruneSha(sha: string): Promise<void> {
    const path = this.#pathFor(sha);
    try {
      await rm(path, { recursive: true, force: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
  }
}

/**
 * Module-level singleton constructed at admin boot. The hooks file
 * passes the configured `MEDIA_ROOT_DIR` env (default `data/media`)
 * into setMediaStorage(); ops + endpoints read it back via
 * getMediaStorage().
 */
let storage: MediaStorageAdapter | null = null;
let storageProvider = "local";

export function setMediaStorage(adapter: MediaStorageAdapter, provider = "local"): void {
  storage = adapter;
  storageProvider = provider;
}

export function getMediaStorage(): MediaStorageAdapter {
  if (!storage) {
    throw new Error(
      "media storage not initialised — call setMediaStorage() at boot (apps/admin/src/hooks.server.ts)",
    );
  }
  return storage;
}

/** Provider tag stamped onto `media_assets.storage_provider` at upload. */
export function getMediaStorageProvider(): string {
  return storageProvider;
}

/**
 * P7 optimization #3 — plugin seam. P11 plugin SDK lands the full
 * sandboxed plugin loader, but the storage-adapter extension point is
 * one of the cleanest single-extension examples and benefits cloud-bucket
 * deployments today.
 *
 * Plugins call this at boot to swap LocalVolumeAdapter for an S3 / R2 /
 * GCS adapter. `MEDIA_STORAGE_PROVIDER=<name>` env reads back through
 * a registered factory so installations don't have to write boot code:
 *
 *   registerMediaStorageFactory("r2", (env) => new R2Adapter({
 *     bucket: env.R2_BUCKET, accessKey: env.R2_KEY, ... }));
 *   // then set MEDIA_STORAGE_PROVIDER=r2 in the env.
 *
 * Stays a no-op until P11 actually loads plugins; the registry is here
 * now so the admin boot can read it without an interface change later.
 */
export type MediaStorageFactory = (env: NodeJS.ProcessEnv) => MediaStorageAdapter;

const factories = new Map<string, MediaStorageFactory>();

export function registerMediaStorageFactory(name: string, factory: MediaStorageFactory): void {
  if (factories.has(name)) {
    throw new Error(`media storage factory already registered: ${name}`);
  }
  factories.set(name, factory);
}

export function getMediaStorageFactory(name: string): MediaStorageFactory | undefined {
  return factories.get(name);
}

export function listMediaStorageFactories(): string[] {
  return [...factories.keys()];
}
