// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — a short-lived loopback origin that serves ONE staged build
 * to the audit browser, for providers whose staging has no URL the browser
 * can open (plain gcp: private bucket behind the IAP-protected admin proxy;
 * aws / azure). gcp-firebase and self-hosted keep auditing their real
 * staging URL.
 *
 * Shape (maintainer decision on PR #583):
 * - bound to 127.0.0.1 on a random port, alive only for one audit;
 * - read-only for the build: GET and HEAD, nothing else;
 * - `/api/*` goes to the install's real gateway when `apiOrigin` is given,
 *   unchanged in method and body — see {@link StagedOriginOptions};
 * - path-traversal safe: the request path is decoded once and reduced to
 *   plain segments before it becomes a storage key; `.`/`..`, backslashes
 *   and NUL are refused, and a local file must resolve inside the build;
 * - served like staging serves it: the publishers' Content-Type and
 *   Cache-Control policy (#555 immutable hashed assets, #571 .ico) plus
 *   staging's `X-Robots-Tag: noindex`.
 */

import { readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { readStagedBuildFiles, readStagedObject } from "../deploy/staged-build-files.js";
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

/**
 * Map a request path to the storage key(s) to try, or null when the path
 * is not a plain, safe site path. Pure (exported for tests).
 *
 * `/` → `index.html`; `/about/` → `about/index.html`; `/about` → `about`
 * (no-extension builds) then `about/index.html`.
 */
export function stagedKeysFor(requestPath: string): string[] | null {
  const pathOnly = requestPath.split("?")[0]?.split("#")[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return null;
  const key = segments.join("/");
  if (key === "") return ["index.html"];
  if (decoded.endsWith("/")) return [`${key}/index.html`];
  return [key, `${key}/index.html`];
}

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
 * Files of a gcp staging run: the private staging bucket under `<runId>/`,
 * falling back to the live static bucket for files the incremental Stage
 * skipped as unchanged, and only for files the build contains (#842: a
 * page the build deleted is still live until Confirm-publish) — the same
 * lookup as the admin's staging preview.
 */
export function gcsStagingSource(runId: string): StagedFileSource {
  const stagingName = process.env.CAELO_STAGING_BUCKET;
  const staticName = process.env.CAELO_STATIC_BUCKET;
  if (!stagingName || !staticName) {
    throw new Error(
      "CAELO_STAGING_BUCKET / CAELO_STATIC_BUCKET not set — the GCP stack sets both on the admin service",
    );
  }
  let run: Promise<{
    staging: import("@google-cloud/storage").Bucket;
    live: import("@google-cloud/storage").Bucket;
    buildFiles: ReadonlySet<string>;
  }> | null = null;
  const open = () => {
    run ??= import("@google-cloud/storage").then(async ({ Storage }) => {
      const storage = new Storage();
      const staging = storage.bucket(stagingName);
      return {
        staging,
        live: storage.bucket(staticName),
        buildFiles: await readStagedBuildFiles(staging, runId),
      };
    });
    return run;
  };
  return {
    async read(key) {
      const object = await readStagedObject({ ...(await open()), runId, key });
      if (!object) return null;
      return {
        bytes: new Uint8Array(object.body),
        contentType: object.contentType ?? contentTypeFor(key),
      };
    },
  };
}

/**
 * How the loopback origin answers what is not a build file.
 */
export interface StagedOriginOptions {
  /**
   * The live site's origin (`https://<domain>`), whose `/api/*` the load
   * balancer routes to the API gateway. Plugin components call
   * `/api/plugin/<slug>/<op>` same-origin when a page loads (auth `me`,
   * the comment list, the rating average — all POSTs), so a build served
   * without the gateway behind it audits a page whose components fail and
   * log console errors that staging never shows. Forwarding everything
   * keeps the audit equal to gcp-firebase and self-hosted staging, whose
   * `/api/*` reaches the same gateway: the request meets the gateway's
   * rate limit, WAF, honeypot and CAPTCHA like any visitor's. Writes stay
   * out of reach in practice because they follow a click, and Lighthouse
   * never clicks.
   */
  readonly apiOrigin?: string;
}

/** Largest request body forwarded to the gateway (its own hard ceiling). */
const MAX_API_BODY_BYTES = 1024 * 1024;

/** Request headers a page's own `/api/*` call carries that the gateway reads. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "cookie",
  "user-agent",
] as const;

/** Response headers that describe the hop, not the answer (fetch decodes the body). */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

/**
 * The gateway URL a loopback `/api/*` request goes to, or null when the
 * path is not a plain `/api/` path on that origin. Pure (exported for tests).
 */
export function apiTargetFor(requestPath: string, apiOrigin: string): URL | null {
  if (!requestPath.startsWith("/api/")) return null;
  const origin = new URL(apiOrigin);
  const target = new URL(requestPath, origin);
  // `new URL` resolves dot segments: `/api/../x` must not leave `/api/`.
  return target.origin === origin.origin && target.pathname.startsWith("/api/") ? target : null;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_API_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function forwardToGateway(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
): Promise<void> {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await readBody(req) : null;
  if (hasBody && body === null) {
    res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" }).end("body too large");
    return;
  }
  const answer = await fetch(target, {
    method: req.method ?? "GET",
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
    redirect: "manual",
  });
  const out: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name) && name !== "set-cookie") out[name] = value;
  });
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  const bytes = new Uint8Array(await answer.arrayBuffer());
  res.writeHead(answer.status, out);
  res.end(req.method === "HEAD" ? undefined : bytes);
}

/** A running loopback origin. */
export interface StagedOrigin {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Serve `source` on 127.0.0.1 at a random port until `close()`. */
export async function serveStagedBuild(
  source: StagedFileSource,
  options: StagedOriginOptions = {},
): Promise<StagedOrigin> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const apiTarget = options.apiOrigin ? apiTargetFor(req.url ?? "/", options.apiOrigin) : null;
    if (apiTarget) {
      await forwardToGateway(req, res, apiTarget);
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
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": String(file.bytes.byteLength),
        "Cache-Control": cacheControlForContentType(file.contentType, key),
        "X-Robots-Tag": "noindex",
      });
      res.end(req.method === "HEAD" ? undefined : file.bytes);
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
