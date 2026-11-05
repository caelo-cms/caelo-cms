// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — a short-lived loopback origin that serves ONE staged build
 * to the audit browser, for providers whose staging the browser cannot open
 * without the gate (gcp and gcp-firebase: the staging slot the gated staging
 * gateway serves, #1330 — Lighthouse must not measure through the gateway,
 * #875; aws / azure). Self-hosted keeps auditing its real staging URL.
 *
 * Shape (maintainer decision on PR #583):
 * - bound to 127.0.0.1 on a random port, alive only for one audit;
 * - read-only for the build: GET and HEAD, nothing else;
 * - `/api/plugin/*` is answered here with the staging stub
 *   (@caelo-cms/shared `staging-plugin-stub.ts`): an audit never writes
 *   visitor data, on live or on staging; nothing else under `/api/` is
 *   forwarded anywhere;
 * - path-traversal safe: the request path is decoded once and reduced to
 *   plain segments before it becomes a storage key; `.`/`..`, backslashes
 *   and NUL are refused, and a local file must resolve inside the build;
 * - served like staging serves it: the publishers' Content-Type and
 *   Cache-Control policy (#555 immutable hashed assets, #571 .ico), the
 *   media security headers every staging origin sends (#891: nosniff, the
 *   SVG CSP) plus staging's `X-Robots-Tag: noindex`;
 * - compressed like the CDN in front of every staging and live host: an
 *   uncompressed document fails Lighthouse's document-latency insight, and
 *   would measure transfer costs no visitor pays.
 */

import { readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import {
  isPluginCallPath,
  mediaSecurityHeaders,
  STAGING_PLUGIN_STUB_BODY,
  type StagedManifest,
  stagedFileKey,
  stagedKeysFor,
  stagedManifestKey,
  stagedManifestSchema,
} from "@caelo-cms/shared";
import { StagedRunError } from "../deploy/staged-build-files.js";
import { stagingBucket } from "../deploy/staging-slots.js";
import { cacheControlForContentType, contentTypeFor } from "../deploy/static-file-policy.js";

/** One file of a staged build. */
export interface StagedFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Where a staged build's files come from. `key` is a safe site path
 *  without leading slash (`index.html`, `about/index.html`, `_assets/x.css`). */
export interface StagedFileSource {
  read(key: string): Promise<StagedFile | null>;
}

/** #1330 — moved to @caelo-cms/shared staged-site.ts (the staging gateway uses it too). */
export { stagedKeysFor } from "@caelo-cms/shared";

/** Files of a build directory on this machine (`<outDir>/builds/<runId>`). */
export function localBuildSource(buildDir: string): StagedFileSource {
  let overrides: Promise<Record<string, string>> | null = null;
  const contentTypes = () => {
    // The generator's sidecar for keys whose type the extension cannot
    // tell (bare-slug pages in 'no-extension' builds).
    overrides ??= readFile(join(buildDir, "_content-types.json"), "utf8").then(
      (t) => JSON.parse(t) as Record<string, string>,
      (e: NodeJS.ErrnoException) => {
        // Only an ABSENT sidecar (older builds) means "no overrides". An
        // unreadable or malformed one would serve no-extension pages with
        // the wrong type and audit something staging never serves — fail.
        if (e.code === "ENOENT") return {};
        throw e;
      },
    );
    return overrides;
  };
  return {
    async read(key) {
      let root: string;
      let file: string;
      try {
        root = await realpath(buildDir);
        file = await realpath(join(root, key));
      } catch {
        return null;
      }
      // Symlinks or anything else resolving outside the build are refused.
      if (!file.startsWith(root + sep)) return null;
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        return null; // a directory, or vanished
      }
      const type = (await contentTypes())[key] ?? contentTypeFor(key);
      return { bytes: new Uint8Array(bytes), contentType: type };
    },
  };
}

/**
 * #1330 — files of a staged build in its staging slot (`_slots/a` of the
 * private staging bucket, gcp and gcp-firebase): the complete mirror the
 * staging gateway serves, read through its manifest. The quality audit's
 * Lighthouse runs load it on a loopback origin instead of through the gated
 * gateway, so a cold start or the streaming rewrite never skews a score
 * (#875; decision 2026-11-04, D4). Throws a {@link StagedRunError} when the
 * slot holds another run (a later Stage resynced it): the audit is then of a
 * build staging no longer has.
 */
export function stagingSlotSource(location: string, runId: string): StagedFileSource {
  let opened: Promise<{
    bucket: import("@google-cloud/storage").Bucket;
    manifest: StagedManifest;
    generation: string;
  }> | null = null;
  const replaced = () =>
    new StagedRunError(
      `the staging slot ${location} no longer holds build ${runId} — a later Stage replaced it. Stage again to check the current build.`,
    );
  /** The manifest's generation, or null when it is gone (a Stage is resyncing the slot). */
  const generationOf = async (bucket: import("@google-cloud/storage").Bucket) => {
    try {
      const [meta] = await bucket.file(stagedManifestKey(location)).getMetadata();
      return meta.generation === undefined ? null : String(meta.generation);
    } catch {
      return null;
    }
  };
  const open = () => {
    opened ??= stagingBucket().then(async (bucket) => {
      const file = bucket.file(stagedManifestKey(location));
      const generation = await generationOf(bucket);
      if (generation === null) {
        throw new StagedRunError(
          `the staging slot ${location} has no manifest (a Stage is resyncing it). Stage again.`,
        );
      }
      const manifest = stagedManifestSchema.parse(
        JSON.parse((await file.download())[0].toString("utf8")),
      );
      if (manifest.runId !== runId) throw replaced();
      return { bucket, manifest, generation };
    });
    return opened;
  };
  return {
    async read(key) {
      const { bucket, manifest, generation } = await open();
      const entry = manifest.files[key];
      if (!entry) return null;
      const [body] = await bucket.file(stagedFileKey(location, key)).download();
      // The fence: a slot sync deletes the manifest before it writes the
      // first file, so a manifest still at the generation this source read
      // AFTER the download proves the bytes are this build's, not a later
      // Stage's that reuses the slot.
      if ((await generationOf(bucket)) !== generation) throw replaced();
      return { bytes: new Uint8Array(body), contentType: entry.type };
    },
  };
}

/** A running loopback origin. */
export interface StagedOrigin {
  readonly baseUrl: string;
  close(): Promise<void>;
}

const COMPRESSIBLE_TYPE =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;

/** The body and headers the CDN would send for `file` to this request. */
function encoded(
  file: StagedFile,
  acceptEncoding: string | undefined,
): { readonly body: Uint8Array; readonly headers: Record<string, string> } {
  if (!COMPRESSIBLE_TYPE.test(file.contentType)) return { body: file.bytes, headers: {} };
  const headers = { Vary: "Accept-Encoding" };
  if (!/\bgzip\b/i.test(acceptEncoding ?? "")) return { body: file.bytes, headers };
  return {
    body: gzipSync(file.bytes),
    headers: { ...headers, "Content-Encoding": "gzip" },
  };
}

/** Serve `source` on 127.0.0.1 at a random port until `close()`. */
export async function serveStagedBuild(source: StagedFileSource): Promise<StagedOrigin> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // #1326 interim — a plugin call never goes to live: the live gateway
    // refuses the staged page (no live Origin), and must. Answer it here
    // the way the gateway answers staging (staging-plugin-stub.ts), so the
    // page logs no failed request and writes nothing into live data.
    if (isPluginCallPath(new URL(req.url ?? "/", "http://staged.invalid").pathname)) {
      if (req.method !== "GET" && req.method !== "HEAD") req.resume();
      res
        .writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        })
        .end(STAGING_PLUGIN_STUB_BODY);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const keys = stagedKeysFor(req.url ?? "/");
    if (keys === null) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("bad path");
      return;
    }
    for (const key of keys) {
      const file = await source.read(key);
      if (!file) continue;
      const { body, headers } = encoded(file, req.headers["accept-encoding"]);
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": String(body.byteLength),
        "Cache-Control": cacheControlForContentType(file.contentType, key),
        ...mediaSecurityHeaders(file.contentType),
        "X-Robots-Tag": "noindex",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not in this build");
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`staged origin error: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("staged origin: could not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
