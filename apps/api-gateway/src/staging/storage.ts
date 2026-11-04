// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1330 — where the staging gateway reads the staged site from:
 * private staging storage, and nothing else (decision 2026-11-04, D1).
 *
 *   - `gs://<bucket>` (gcp, gcp-firebase): the private staging bucket,
 *     through the Cloud Storage JSON API with the service's own token from
 *     the metadata server. Its account may only read that bucket; there is
 *     no client library in the gateway image and no other bucket it could
 *     reach.
 *   - `file:///srv/staging` (self-hosted): the staging target's output
 *     directory, mounted read-only into the container.
 *
 * Keys come only from the published location and the build's manifest
 * (staging/site.ts serves nothing the manifest does not list), and both are
 * validated plain paths (@caelo-cms/shared staged-site.ts); the directory
 * reader additionally refuses a key that resolves outside its root.
 */

import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { isSafeStagedPath } from "@caelo-cms/shared";

/** One object opened for streaming. */
export interface StagedObject {
  readonly body: ReadableStream<Uint8Array>;
  /** Byte length when the store knows it. */
  readonly size: number | null;
}

/** Read-only access to staging storage. */
export interface StagingStorage {
  /** For logs: `gs://bucket` or the directory. */
  readonly describe: string;
  /** The object at `key` as text, or null when it does not exist. */
  readText(key: string, signal?: AbortSignal): Promise<string | null>;
  /** The object at `key` as a stream, or null when it does not exist. */
  open(key: string, signal?: AbortSignal): Promise<StagedObject | null>;
}

/** The env var naming the staging storage (stack-contract.ts sets it on the staging gateway). */
export const STAGING_STORAGE_ENV = "CAELO_STAGING_STORAGE";

/** A storage key the readers accept: a plain relative path. */
function assertKey(key: string): void {
  if (!isSafeStagedPath(key)) throw new Error(`staging storage: refused key "${key}"`);
}

// ─── Cloud Storage ─────────────────────────────────────────────────────

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** An OAuth access token for the service's own account. */
export type AccessTokenSource = () => Promise<string>;

/**
 * The metadata server's token for the instance's service account, cached
 * until a minute before it expires.
 */
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

/** Staging storage in a Cloud Storage bucket. */
export function gcsStagingStorage(
  bucket: string,
  token: AccessTokenSource,
  fetchImpl: typeof fetch = fetch,
): StagingStorage {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) {
    throw new Error(`staging storage: "${bucket}" is not a bucket name`);
  }
  const get = async (key: string, signal?: AbortSignal): Promise<Response | null> => {
    assertKey(key);
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${await token()}` },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`staging storage gs://${bucket}/${key}: HTTP ${res.status}`);
    }
    return res;
  };
  return {
    describe: `gs://${bucket}`,
    async readText(key, signal) {
      const res = await get(key, signal);
      return res ? await res.text() : null;
    },
    async open(key, signal) {
      const res = await get(key, signal);
      if (!res?.body) return null;
      const length = res.headers.get("content-length");
      return { body: res.body, size: length !== null ? Number(length) : null };
    },
  };
}

// ─── a directory (self-hosted) ─────────────────────────────────────────

/** Staging storage in a local directory (mounted read-only). */
export function directoryStagingStorage(root: string): StagingStorage {
  const resolveInside = async (key: string): Promise<string | null> => {
    assertKey(key);
    let base: string;
    let file: string;
    try {
      base = await realpath(root);
      file = await realpath(join(base, key));
    } catch {
      return null;
    }
    // A symlink (or anything else) that leaves the root is refused.
    if (!file.startsWith(base + sep)) return null;
    const info = await stat(file).catch(() => null);
    return info?.isFile() ? file : null;
  };
  return {
    describe: root,
    async readText(key) {
      const file = await resolveInside(key);
      return file ? await Bun.file(file).text() : null;
    },
    async open(key) {
      const file = await resolveInside(key);
      if (!file) return null;
      const f = Bun.file(file);
      return { body: f.stream(), size: f.size };
    },
  };
}

/**
 * The staging storage `CAELO_STAGING_STORAGE` names. No default (CLAUDE.md
 * §2): a staging gateway without it cannot serve anything and says so.
 *
 * @throws naming the variable and the forms it takes.
 */
export function stagingStorageFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch = fetch,
): StagingStorage {
  const raw = env[STAGING_STORAGE_ENV];
  if (raw?.startsWith("gs://")) {
    return gcsStagingStorage(
      raw.slice("gs://".length).replace(/\/+$/, ""),
      metadataTokenSource(fetchImpl),
      fetchImpl,
    );
  }
  if (raw?.startsWith("file://")) {
    const path = new URL(raw).pathname;
    if (!path.startsWith("/"))
      throw new Error(`${STAGING_STORAGE_ENV}: "${raw}" is not an absolute file URL`);
    return directoryStagingStorage(path);
  }
  throw new Error(
    `the staging gateway needs ${STAGING_STORAGE_ENV}=gs://<staging bucket> or file:///<staging dir> (got ${raw ? JSON.stringify(raw) : "nothing"}): it serves the staged site from there (#1330). Cloud installs set it in the converge (\`cms-provision upgrade\`); self-hosted: \`cms-provision up\`.`,
  );
}
