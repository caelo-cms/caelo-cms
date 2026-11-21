// SPDX-License-Identifier: MPL-2.0

/**
 * Collection stores (epic #1644, R2): where a collection's files live.
 *
 * One store per environment: the staging store, written by the admin (change
 * files) and the indexing job (segments, releases), read by the staging
 * gateway; and the live store, written only by Publish live's copy and read
 * by the live gateway. The live gateway's identity can read the live store
 * and nothing else, so staged index data never reaches visitors before
 * Publish live (CLAUDE.md §2).
 *
 * Keys are relative paths `<plugin>/<collection>/<file>`; segment files are
 * content-addressed, so a write of an existing name is a no-op and a copy
 * moves only what the destination lacks.
 *
 * A store is named by a URL: `gs://bucket[/prefix]` (Cloud Storage over its
 * JSON API with the instance's own token) or `file:///absolute/dir`.
 */

import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FileSource } from "./reader.js";

/** A collection store. */
export interface CollectionStore extends FileSource {
  /** For logs and errors: `gs://bucket/prefix` or the directory. */
  readonly describe: string;
  /** The bytes at `key`; throws when there are none. */
  read(key: string): Promise<Uint8Array>;
  /** The bytes at `key`, or null. */
  readIfExists(key: string): Promise<Uint8Array | null>;
  /** Writes `key`. With `immutable`, an existing object is left as it is (content-addressed names). */
  write(key: string, data: Uint8Array, opts?: { readonly immutable?: boolean }): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix ("" for every key), in no particular order. */
  list(prefix: string): Promise<string[]>;
  /**
   * The keys under a prefix with when each was written (epoch ms), for a
   * clean-up that must spare what a writer still in flight just put there.
   */
  listEntries(prefix: string): Promise<StoreEntry[]>;
}

/** One stored object: its key and when it was written (epoch milliseconds). */
export interface StoreEntry {
  readonly key: string;
  readonly writtenAt: number;
}

/** A key the stores accept: a plain relative path without `..`, backslashes or control characters. */
export function isStoreKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 900 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    ![...key].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) &&
    key.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function assertKey(key: string): void {
  if (!isStoreKey(key)) throw new Error(`collection store: refused key "${key}"`);
}

/** A store rooted at a sub-prefix of another, e.g. one plugin's collection. */
export function scopedStore(store: CollectionStore, prefix: string): CollectionStore {
  assertKey(prefix);
  const k = (key: string) => `${prefix}/${key}`;
  return {
    describe: `${store.describe}/${prefix}`,
    read: (key) => store.read(k(key)),
    readIfExists: (key) => store.readIfExists(k(key)),
    write: (key, data, opts) => store.write(k(key), data, opts),
    has: (key) => store.has(k(key)),
    delete: (key) => store.delete(k(key)),
    list: async (p) =>
      (await store.list(p === "" ? prefix : k(p))).map((full) => full.slice(prefix.length + 1)),
    listEntries: async (p) =>
      (await store.listEntries(p === "" ? prefix : k(p))).map((e) => ({
        key: e.key.slice(prefix.length + 1),
        writtenAt: e.writtenAt,
      })),
  };
}

// ─── a directory ────────────────────────────────────────────────────────

/** A store in a local directory (self-hosted, tests). */
export function directoryStore(root: string): CollectionStore {
  const inside = async (key: string): Promise<string> => {
    assertKey(key);
    const base = await realpath(root).catch(async () => {
      await mkdir(root, { recursive: true });
      return realpath(root);
    });
    return join(base, ...key.split("/"));
  };
  const readIfExists = async (key: string): Promise<Uint8Array | null> => {
    const file = await inside(key);
    const real = await realpath(file).catch(() => null);
    if (real === null) return null;
    const base = await realpath(root);
    // A symlink (or anything else) that leaves the root is refused.
    if (!real.startsWith(base + sep)) return null;
    return new Uint8Array(await readFile(real));
  };
  return {
    describe: root,
    async read(key) {
      const data = await readIfExists(key);
      if (data === null) throw new Error(`collection store ${root}: "${key}" does not exist`);
      return data;
    },
    readIfExists,
    async write(key, data, opts) {
      const file = await inside(key);
      if (opts?.immutable && (await stat(file).catch(() => null))?.isFile()) return;
      await mkdir(dirname(file), { recursive: true });
      // Write then rename: a reader never sees half a file.
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
    },
    async has(key) {
      return (await stat(await inside(key)).catch(() => null))?.isFile() ?? false;
    },
    async delete(key) {
      await rm(await inside(key), { force: true });
    },
    async list(prefix) {
      return (await listDirectory(prefix)).map((e) => e.key);
    },
    listEntries: (prefix) => listDirectory(prefix),
  };

  async function listDirectory(prefix: string): Promise<StoreEntry[]> {
    const base = await realpath(root).catch(() => null);
    if (base === null) return [];
    const dir = prefix === "" ? base : await inside(prefix);
    const out: StoreEntry[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && !e.name.endsWith(".tmp")) {
          // A write lands by rename (writeFile then rename): the mtime is when it was written.
          const st = await stat(full).catch(() => null);
          if (st)
            out.push({ key: relative(base, full).split(sep).join("/"), writtenAt: st.mtimeMs });
        }
      }
    };
    await walk(dir);
    return out;
  }
}

// ─── Cloud Storage ──────────────────────────────────────────────────────

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** An OAuth access token for the instance's own account. */
export type AccessTokenSource = () => Promise<string>;

/** The token of the instance's service account, from the metadata server, cached until a minute before it expires. */
export function metadataTokenSource(fetchImpl: typeof fetch = fetch): AccessTokenSource {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.until > now) return cached.token;
    const res = await fetchImpl(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("metadata token: no access_token in the answer");
    cached = {
      token: body.access_token,
      until: now + Math.max(0, (body.expires_in ?? 300) - 60) * 1000,
    };
    return cached.token;
  };
}

const API = "https://storage.googleapis.com";

/** A store in a Cloud Storage bucket, under an optional prefix. */
export function gcsStore(
  bucket: string,
  prefix: string,
  token: AccessTokenSource,
  fetchImpl: typeof fetch = fetch,
): CollectionStore {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket))
    throw new Error(`collection store: "${bucket}" is not a bucket name`);
  if (prefix !== "") assertKey(prefix);
  const object = (key: string): string => {
    assertKey(key);
    return prefix === "" ? key : `${prefix}/${key}`;
  };
  const authed = async (init: RequestInit = {}): Promise<RequestInit> => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${await token()}`,
    },
  });
  const fail = async (res: Response, what: string): Promise<never> => {
    await res.body?.cancel();
    throw new Error(`collection store gs://${bucket}: ${what}: HTTP ${res.status}`);
  };
  const readIfExists = async (key: string): Promise<Uint8Array | null> => {
    const res = await fetchImpl(
      `${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(object(key))}?alt=media`,
      await authed(),
    );
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) return fail(res, `read ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return {
    describe: `gs://${bucket}${prefix ? `/${prefix}` : ""}`,
    async read(key) {
      const data = await readIfExists(key);
      if (data === null)
        throw new Error(`collection store gs://${bucket}: "${key}" does not exist`);
      return data;
    },
    readIfExists,
    async write(key, data, opts) {
      const precondition = opts?.immutable ? "&ifGenerationMatch=0" : "";
      const res = await fetchImpl(
        `${API}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(object(key))}${precondition}`,
        await authed({
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          // A Blob, not the view: the DOM's BodyInit takes no shared-buffer view.
          body: new Blob([data as Uint8Array<ArrayBuffer>]),
        }),
      );
      // 412: an immutable name that already exists — the same bytes by construction.
      if (res.status === 412 && opts?.immutable) {
        await res.body?.cancel();
        return;
      }
      if (!res.ok) return fail(res, `write ${key}`);
      await res.body?.cancel();
    },
    async has(key) {
      const res = await fetchImpl(
        `${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(object(key))}?fields=name`,
        await authed(),
      );
      await res.body?.cancel();
      if (res.status === 404) return false;
      if (!res.ok)
        throw new Error(`collection store gs://${bucket}: stat ${key}: HTTP ${res.status}`);
      return true;
    },
    async delete(key) {
      const res = await fetchImpl(
        `${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(object(key))}`,
        await authed({ method: "DELETE" }),
      );
      if (res.status === 404 || res.ok) {
        await res.body?.cancel();
        return;
      }
      return fail(res, `delete ${key}`);
    },
    async list(p) {
      return (await listObjects(p)).map((e) => e.key);
    },
    listEntries: (p) => listObjects(p),
  };

  async function listObjects(p: string): Promise<StoreEntry[]> {
    const out: StoreEntry[] = [];
    let pageToken: string | undefined;
    const full = p === "" ? prefix : object(p);
    do {
      const res = await fetchImpl(
        `${API}/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(full === "" ? "" : `${full}/`)}&fields=items(name,timeCreated),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        await authed(),
      );
      if (!res.ok) return fail(res, `list ${p}`);
      const body = (await res.json()) as {
        items?: { name: string; timeCreated?: string }[];
        nextPageToken?: string;
      };
      for (const item of body.items ?? []) {
        // Asked for in `fields`: an object without it is a broken answer.
        if (!item.timeCreated) throw new Error(`gs://${bucket}: ${item.name} has no timeCreated`);
        out.push({
          key: prefix === "" ? item.name : item.name.slice(prefix.length + 1),
          // An object is never rewritten (immutable names): created = written.
          writtenAt: Date.parse(item.timeCreated),
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }
}

/** `s` without its trailing slashes, in linear time (a `/\/+$/` scan is quadratic on many slashes). */
function withoutTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** Opens a store from its URL (`gs://bucket[/prefix]` or `file:///dir`). */
export function storeFromUrl(url: string, fetchImpl: typeof fetch = fetch): CollectionStore {
  if (url.startsWith("gs://")) {
    const rest = url.slice("gs://".length);
    const slash = rest.indexOf("/");
    const bucket = slash < 0 ? rest : rest.slice(0, slash);
    const prefix = slash < 0 ? "" : withoutTrailingSlashes(rest.slice(slash + 1));
    return gcsStore(bucket, prefix, metadataTokenSource(fetchImpl), fetchImpl);
  }
  if (url.startsWith("file://")) {
    const path = decodeURIComponent(new URL(url).pathname);
    if (!path.startsWith("/"))
      throw new Error(`collection store: "${url}" must name an absolute directory`);
    return directoryStore(path);
  }
  throw new Error(
    `collection store: "${url}" is neither gs://bucket[/prefix] nor file:///directory`,
  );
}

/** Copies every key of `keys` the destination lacks; returns how many it copied. */
export async function copyMissing(
  from: CollectionStore,
  to: CollectionStore,
  keys: Iterable<string>,
  parallel = 16,
): Promise<number> {
  const list = [...keys];
  let copied = 0;
  for (let i = 0; i < list.length; i += parallel) {
    await Promise.all(
      list.slice(i, i + parallel).map(async (key) => {
        if (await to.has(key)) return;
        await to.write(key, await from.read(key), { immutable: true });
        copied++;
      }),
    );
  }
  return copied;
}
