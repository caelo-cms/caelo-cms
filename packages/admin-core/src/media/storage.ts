// SPDX-License-Identifier: MPL-2.0

/**
 * `MediaStorageAdapter` interface lives in `@caelo/shared` so the
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
import { dirname, join, resolve } from "node:path";
import type { MediaStorageAdapter } from "@caelo/shared";
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

  async totalSizeBytes(): Promise<number> {
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
    return total;
  }

  /**
   * Removes all files under a given sha-prefixed directory. Used by
   * the delete op once every variant for that sha is gone.
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
export function setMediaStorage(adapter: MediaStorageAdapter): void {
  storage = adapter;
}
export function getMediaStorage(): MediaStorageAdapter {
  if (!storage) {
    throw new Error(
      "media storage not initialised — call setMediaStorage() at boot (apps/admin/src/hooks.server.ts)",
    );
  }
  return storage;
}

/** Path helper used by the storage path containment check. */
export function joinKeyPath(rootDir: string, key: string): string {
  return join(resolve(rootDir), key);
}
