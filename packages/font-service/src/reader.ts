// SPDX-License-Identifier: MPL-2.0

/**
 * Font reads for the in-transaction preview and build consumers (the theme
 * font resolver) and the admin's font file route.
 *
 * Why a process cache (#803): a preview used to read each bound face per
 * typography role, and each read fetched the complete file as base64 and
 * then again in 256 KB chunks — every `substring` re-fetching the whole
 * TOAST value — so ~5 queries, twice the file size on the wire and three
 * hashes per role per preview. Revisions are immutable (no UPDATE or
 * DELETE policy on `font_assets`, migration 0223), so the bytes of
 * (id, sha256) never change and may be kept in memory. A cached read still
 * runs one index lookup under the caller's transaction, so the table's
 * read policy, not this cache, decides who may read a revision.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { fontRevisionVisible, readFontRevision } from "./ops.js";
import type { FontMetadata, FontRef } from "./types.js";

/** One face as read from the registry: verified metadata + complete bytes. */
export interface FontRead {
  readonly metadata: FontMetadata;
  readonly bytes: Uint8Array;
}

/**
 * Byte budget of the cache. A theme binds a few faces (registry files are
 * capped at 8 MiB, typical TTFs ~0.1–1 MiB); 32 MiB keeps the faces of the
 * themes being edited without letting a 2 GiB admin instance grow on an
 * unbounded map (epic #1209).
 */
const MAX_CACHED_BYTES = 32 * 1024 * 1024;

/** (id|sha256) → read, in least-recently-used order (Map insertion order). */
const cache = new Map<string, FontRead>();
let cachedBytes = 0;
/** Counts the byte reads that reached the database, for the regression tests. */
let byteReads = 0;

function remember(key: string, read: FontRead): void {
  if (read.bytes.byteLength > MAX_CACHED_BYTES) return;
  cache.set(key, read);
  cachedBytes += read.bytes.byteLength;
  for (const [oldKey, old] of cache) {
    if (cachedBytes <= MAX_CACHED_BYTES) break;
    cache.delete(oldKey);
    cachedBytes -= old.bytes.byteLength;
  }
}

/**
 * Reader for faces bound in theme typography: the complete file in one
 * query on first use, from memory afterwards.
 *
 * @param tx the caller's transaction; every read is checked under it
 * @returns a function resolving a pin to its verified metadata + bytes
 * @throws FontRevisionNotFound when `tx` cannot see the revision
 * @throws FontEmbeddingNotPermitted:web when the licence forbids web use
 */
export function fontReader(tx: TransactionRunner) {
  return async (ref: FontRef): Promise<FontRead> => {
    const key = `${ref.id}|${ref.sha256}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      if (!(await fontRevisionVisible(tx, ref))) throw new Error("FontRevisionNotFound");
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    byteReads += 1;
    const read = await readFontRevision(tx, ref);
    if (!read.metadata.embedding.web) throw new Error("FontEmbeddingNotPermitted:web");
    remember(key, read);
    return read;
  };
}

/** Test seam: drop every cached face. */
export function clearFontReaderCache(): void {
  cache.clear();
  cachedBytes = 0;
}

/** Test seam: how many face byte reads reached the database in this process. */
export function fontByteReadCount(): number {
  return byteReads;
}
