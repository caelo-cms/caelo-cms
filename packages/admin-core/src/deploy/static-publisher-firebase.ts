// SPDX-License-Identifier: MPL-2.0

/**
 * v0.3.0 — Firebase Hosting static publisher.
 *
 * Used on `CAELO_PROVIDER=gcp-firebase` installs. Static site lives
 * on Firebase Hosting; admin + gateway stay on Cloud Run (no LB).
 * The Firebase Hosting REST API handles:
 *
 *   - Versioning: each Stage creates an immutable Hosting version
 *     containing the full file set.
 *   - Deduplication: Firebase's populateFiles API only requests
 *     uploads for files NOT already content-addressed in the site
 *     (sha256 of gzipped body). No manual CRC32C-manifest needed.
 *   - Preview channels: each Stage deploys the version to a
 *     per-runId preview channel with a 7-day TTL. #650 — the channel
 *     URL is never shown: the gateway serves staging.<domain> from it
 *     behind the access gate, older channels are pruned when a newer
 *     Stage succeeds, the last one after Publish live.
 *   - Publish live: a release on the live channel. When staging has
 *     its own host (#650) it is a fresh version of the rebuild with the
 *     live host (publishLiveBuild, after the parity guard); otherwise a
 *     copy of the staged version (promoteToProduction). Rollback
 *     re-releases the Hosting version a run recorded.
 *
 * Auth: ADC via the Cloud Run service identity. The runSa needs
 * roles/firebasehosting.admin on the Firebase project — provisioned
 * by the gcp-firebase Pulumi stack.
 *
 * Env vars expected on the admin Cloud Run service (set by stack):
 *   - CAELO_FIREBASE_SITE — Firebase Hosting site ID
 *     (typically `<namePrefix>-site` e.g. `caelo-production-site`)
 *   - GOOGLE_CLOUD_PROJECT or CAELO_PROVIDER_PROJECT — GCP project id
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import {
  CONTENT_HASHED_PATH_PATTERN,
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  NOSNIFF,
  SVG_DOCUMENT_CSP,
  SVG_PATH_PATTERN,
} from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { firebaseRedirectsFromFile } from "./firebase-redirects.js";
import type {
  PromoteSummary,
  PublishSummary,
  StagingPreviewSelection,
  StaticPublisher,
} from "./static-publisher.js";

const FIREBASE_HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const PARALLEL_UPLOADS = 50;
const PREVIEW_CHANNEL_TTL_DAYS = 7;
/** Firebase `ttl` duration of a preview channel staging does not serve. */
const PREVIEW_CHANNEL_TTL = `${PREVIEW_CHANNEL_TTL_DAYS * 24 * 60 * 60}s`;

export function siteName(): string {
  const site = process.env.CAELO_FIREBASE_SITE;
  if (!site) {
    throw new Error(
      "static-publisher-firebase: CAELO_FIREBASE_SITE not set. The gcp-firebase Pulumi stack must set this env var on the admin Cloud Run service.",
    );
  }
  return site;
}

export async function googleAuthToken(
  scopes: readonly string[] = ["https://www.googleapis.com/auth/firebase.hosting"],
): Promise<string> {
  // Use google-auth-library to fetch an ADC access token. On Cloud
  // Run this picks up the service account identity automatically.
  // Lazy-import so self-hosted installs don't pull the dep.
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: [...scopes] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error("static-publisher-firebase: failed to obtain ADC access token");
  }
  return token.token;
}

interface WalkedFile {
  absolutePath: string;
  relativePath: string;
}

async function walkBuildDir(buildDir: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(buildDir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else {
        out.push({
          absolutePath: join(buildDir, childRel),
          relativePath: childRel,
        });
      }
    }
  };
  await walk("");
  return out;
}

/**
 * RE2 pattern for "every path whose first segment neither starts with
 * `_` nor is exactly `api`" — RE2 has no lookahead, so the `api`
 * exclusion is spelled out character by character. Matches `/`,
 * `/about/`, `/about`, `/apiary`, `/robots.txt`; rejects `/_assets/…`,
 * `/api`, `/api/…`. See VERSION_CONFIG_HEADERS for why.
 */
export const FIREBASE_SHORT_CACHE_PATH_PATTERN =
  "^/(?:(?:[^_a/][^/]*|a(?:[^p/][^/]*)?|ap(?:[^i/][^/]*)?|api[^/]+)(?:/.*)?)?$";

/**
 * v0.6.3 — per-path response headers attached to every Firebase
 * Hosting version we publish. Exported so the regression test in
 * __tests__/static-publisher-firebase-headers.test.ts can pin the
 * shape WITHOUT needing to mock the entire Firebase REST surface.
 *
 * SCHEMA CONTRACT (critical — getting this wrong causes 400 at deploy):
 * Firebase Hosting's REST API at sites.versions.create expects each
 * entry's `headers` field as a map<string, string> (key → value).
 * The Firebase CLI's firebase.json uses an array-of-{key,value}
 * shape and translates internally — the REST API does NOT. Mixing
 * the two shapes was the v0.3.1 → v0.6.2 staging-deploy bug
 * ("Cannot bind a list to map for field 'headers'").
 *
 * Spec: https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.versions#Header
 *
 * MATCHING CONTRACT: each entry's `glob` / `regex` is matched against
 * the REQUEST URL path (Firebase discovery doc, `Header.regex`: "RE2
 * regular expression to match against the request URL path"), not
 * the file that ends up served. A page requested as `/about/` is
 * served from `/about/index.html` but never matched the old
 * `*.html` glob — which is why pages fell through to Firebase's
 * default `max-age=3600`, as did the content-hashed fonts.
 *
 * The two entries are DISJOINT on purpose: Firebase applies every
 * matching entry and does not document which one wins when two set
 * the same header, so no path may match both.
 *
 *   1. Content-hashed build outputs (fonts, plugin bundles, media since
 *      #667 — see `@caelo-cms/shared` static-cache-policy.ts) →
 *      immutable, 1 year.
 *      All of them live under a `/_…` top-level directory.
 *   2. Every path whose first segment does NOT start with `_` and is
 *      not `api` → short + stale-while-revalidate: pages (`/`,
 *      `/about/`, `/about.html`, bare-slug `/about`), robots.txt,
 *      sitemap.xml, root manifests. A publish creates a new release
 *      (Firebase purges its CDN) and visitors pick it up within 60s.
 *
 * Paths matching neither keep Firebase's default (`max-age=3600`):
 * pre-#667 media under a bare slug (`/_assets/<slug>.<ext>` — stable URL,
 * bytes replaceable, must not be immutable), the pinned-font license files
 * and the `/api/**` rewrite to the gateway (its own headers stay
 * authoritative).
 *
 * A third entry pins `Content-Type: image/x-icon` on `.ico` files (theme
 * favicons): the one icon MIME the media library stores and the
 * `<link rel="icon" type>` declares, instead of whatever name Hosting's
 * extension table picks. It sets no Cache-Control, so overlapping a
 * Cache-Control entry on the path never makes two entries set the same
 * header.
 *
 * The {@link SECURITY_HEADER_ENTRIES} close the list (#891): every
 * response `nosniff`, every SVG the sandboxing CSP. Neither sets
 * Cache-Control or Content-Type, so they overlap the entries above
 * without two entries ever setting the same header.
 */
export const SECURITY_HEADER_ENTRIES = [
  {
    regex: "^/",
    headers: { "X-Content-Type-Options": NOSNIFF },
  },
  {
    regex: SVG_PATH_PATTERN,
    headers: { "Content-Security-Policy": SVG_DOCUMENT_CSP },
  },
] as const;

export const VERSION_CONFIG_HEADERS = [
  {
    regex: CONTENT_HASHED_PATH_PATTERN,
    headers: { "Cache-Control": IMMUTABLE_CACHE_CONTROL },
  },
  {
    regex: FIREBASE_SHORT_CACHE_PATH_PATTERN,
    headers: { "Cache-Control": HTML_CACHE_CONTROL },
  },
  {
    regex: "\\.ico$",
    headers: { "Content-Type": "image/x-icon" },
  },
  ...SECURITY_HEADER_ENTRIES,
] as const;

/**
 * Response header that keeps a non-indexable target (staging) out of
 * search engines at the serving layer — CMS_REQUIREMENTS §16.5, same
 * rule as the Caddy staging vhost. The generator no longer bakes the
 * env's `noindex` into page HTML (a staging build is what production
 * gets), so on Firebase this version-config header is what marks a
 * staging version non-indexable — together with its robots.txt.
 */
const ROBOTS_HEADER = "X-Robots-Tag";

interface FirebaseHeaderEntry {
  glob?: string;
  regex?: string;
  headers: Record<string, string>;
}
/** The slice of a Hosting version `config` this publisher inspects;
 *  every other field (rewrites, …) passes through untouched. */
interface FirebaseVersionConfig {
  headers?: ReadonlyArray<FirebaseHeaderEntry>;
  [field: string]: unknown;
}

function isRobotsHeaderEntry(entry: FirebaseHeaderEntry): boolean {
  return Object.keys(entry.headers ?? {}).some(
    (k) => k.toLowerCase() === ROBOTS_HEADER.toLowerCase(),
  );
}

/**
 * Return `config` with its env-level robots header set for `robots`:
 * every X-Robots-Tag entry is dropped, and a `noindex` target gets one
 * covering every path. Promote and rollback pass the SOURCE version's
 * config through this with the DESTINATION target — that is how a
 * staging version's `noindex` header stays out of the live release
 * while its rewrites + cache headers carry over unchanged.
 */
export function withTargetRobotsHeader(
  config: FirebaseVersionConfig,
  robots: "index" | "noindex",
): FirebaseVersionConfig {
  const kept = (config.headers ?? []).filter((e) => !isRobotsHeaderEntry(e));
  const headers =
    robots === "noindex"
      ? [...kept, { glob: "**", headers: { [ROBOTS_HEADER]: "noindex" } }]
      : kept;
  return { ...config, headers };
}

const SECURITY_HEADER_NAMES = new Set(
  SECURITY_HEADER_ENTRIES.flatMap((e) => Object.keys(e.headers).map((k) => k.toLowerCase())),
);

/**
 * Return `config` with the current {@link SECURITY_HEADER_ENTRIES} in
 * place of whatever security entries it carried. Promote and rollback
 * re-release a SOURCE version's config; a version staged (or released)
 * before #891 has no SVG CSP, and this is what keeps such a version from
 * going live without it.
 */
export function withSecurityHeaders(config: FirebaseVersionConfig): FirebaseVersionConfig {
  const kept = (config.headers ?? []).filter(
    (e) => !Object.keys(e.headers ?? {}).some((k) => SECURITY_HEADER_NAMES.has(k.toLowerCase())),
  );
  return { ...config, headers: [...kept, ...SECURITY_HEADER_ENTRIES] };
}

/**
 * True when a version config carries the env-level robots header.
 * Staging versions published before the generator stopped baking the
 * env's `noindex` into page HTML lack it (they relied on that meta), so
 * promote uses its absence to refuse such a legacy staging version.
 */
function hasRobotsHeader(config: FirebaseVersionConfig): boolean {
  return (config.headers ?? []).some(isRobotsHeaderEntry);
}

/**
 * Gzip a file's contents + compute the sha256 of the gzipped bytes.
 * Firebase Hosting's populateFiles API keys on this hash.
 */
async function gzipAndHash(absolutePath: string): Promise<{ body: Buffer; sha256: string }> {
  const gz = createGzip({ level: 9 });
  const stream = createReadStream(absolutePath);
  stream.pipe(gz);
  const chunks: Buffer[] = [];
  for await (const chunk of gz as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return { body, sha256 };
}

/**
 * v0.10.11 — Same as `gzipAndHash` but for in-memory bytes. Used by
 * `releaseAsTarget` to patch robots.txt with the destination target's
 * policy before releasing on the live channel.
 */
async function gzipAndHashBytes(input: Buffer): Promise<{ body: Buffer; sha256: string }> {
  return await new Promise((resolve, reject) => {
    const gz = createGzip({ level: 9 });
    const chunks: Buffer[] = [];
    gz.on("data", (c: Buffer) => chunks.push(c));
    gz.on("end", () => {
      const body = Buffer.concat(chunks);
      const sha256 = createHash("sha256").update(body).digest("hex");
      resolve({ body, sha256 });
    });
    gz.on("error", reject);
    gz.end(input);
  });
}

/**
 * Run `worker` over `items` with at most `parallelism` in flight.
 * Local copy of static-publisher-gcs's runBatched (kept independent
 * so changing one publisher doesn't ripple through the other).
 */
async function runBatched<T>(
  items: ReadonlyArray<T>,
  parallelism: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      // biome-ignore lint/style/noNonNullAssertion: cursor < length checked
      await worker(items[i]!);
    }
  };
  const workers: Promise<void>[] = [];
  const n = Math.min(parallelism, items.length);
  for (let i = 0; i < n; i++) workers.push(next());
  await Promise.all(workers);
}

interface CreateVersionResponse {
  name: string; // "sites/<site>/versions/<versionId>"
}
interface PopulateFilesResponse {
  uploadRequiredHashes?: string[];
  uploadUrl: string; // e.g. "https://upload-firebasehosting.googleapis.com/upload/sites/<site>/versions/<versionId>/files"
}
interface CreateChannelResponse {
  name: string; // "sites/<site>/channels/<channelId>"
  url: string; // public preview URL
}

/**
 * A non-2xx answer from the Firebase Hosting REST API. Carries the HTTP
 * status so callers can branch on it (the custom-domain reconnect treats
 * 404 on DELETE as "already gone" and 409 on create as "soft-deleted —
 * undelete instead").
 */
export class FirebaseHostingHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FirebaseHostingHttpError";
  }
}

export async function firebaseFetch<T>(
  path: string,
  init: RequestInit & { body?: BodyInit; token?: string } = {},
): Promise<T> {
  const token = init.token ?? (await googleAuthToken());
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (!headers["Content-Type"] && init.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${FIREBASE_HOSTING_API}/${path.replace(/^\/+/, "")}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FirebaseHostingHttpError(
      res.status,
      `firebase-hosting ${path} → ${res.status} ${res.statusText}: ${detail}`,
    );
  }
  // DELETE answers may carry an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Upload a single gzipped file to the version's signed upload URL.
 * Firebase Hosting's upload endpoint accepts the gzipped body
 * keyed by the sha256 hash returned from populateFiles.
 */
async function uploadGzippedFile(
  uploadUrlBase: string,
  sha256: string,
  body: Buffer,
  token: string,
): Promise<void> {
  const res = await fetch(`${uploadUrlBase}/${sha256}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    // Convert Buffer → Uint8Array to satisfy the fetch BodyInit shape.
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`firebase-hosting upload ${sha256} → ${res.status}: ${detail}`);
  }
}

/** Every channel Stage creates is named `runid-<runId>`; nothing else is. */
const RUN_CHANNEL_PREFIX = "runid-";

function channelIdFor(runId: string): string {
  return `${RUN_CHANNEL_PREFIX}${runId.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`.slice(0, 63);
}

/** The version behind the latest release on a runId's preview channel. */
async function channelHeadVersion(
  site: string,
  runId: string,
  token: string,
  op: "promote",
): Promise<string> {
  const channelId = channelIdFor(runId);
  type ListReleasesResponse = { releases?: { name: string; version: { name: string } }[] };
  const releases = await firebaseFetch<ListReleasesResponse>(
    `sites/${site}/channels/${channelId}/releases`,
    { token },
  );
  const head = releases.releases?.[0];
  if (!head) {
    throw new Error(
      `firebase publisher ${op}: no releases found on channel ${channelId} for runId=${runId}. Run Stage first.`,
    );
  }
  return head.version.name;
}

async function versionConfig(
  site: string,
  versionName: string,
  token: string,
): Promise<FirebaseVersionConfig> {
  const versionId = versionName.split("/").pop() ?? "";
  const version = await firebaseFetch<{ config?: FirebaseVersionConfig }>(
    `sites/${site}/versions/${versionId}`,
    { token },
  );
  return version.config ?? {};
}

/**
 * Release a copy of `sourceVersionName` on the live channel, rewritten
 * for `target`: same files except robots.txt (the target's policy, with
 * the `Sitemap:` line when the version carries a sitemap.xml), same
 * config except the env-level robots header (see
 * withTargetRobotsHeader) and the current security headers (see
 * withSecurityHeaders — a version from before #891 lacks the SVG CSP). Page HTML + sitemap.xml are reused by hash —
 * the generator renders them env-independently.
 */
async function releaseAsTarget(args: {
  site: string;
  token: string;
  sourceVersionName: string;
  sourceConfig: FirebaseVersionConfig;
  target: DeployTarget;
  siteBaseUrl: string;
}): Promise<{ versionName: string; uploadedCount: number; skippedUnchangedCount: number }> {
  const { site, token } = args;
  const sourceVersionId = args.sourceVersionName.split("/").pop() ?? "";

  // List the source version's full file manifest. Firebase paginates —
  // walk until exhausted. Every path is needed so the new version is
  // identical except for the patched robots.txt.
  type FileEntry = { path: string; hash: string; status: string };
  type ListFilesResponse = { files?: FileEntry[]; nextPageToken?: string };
  const allFiles: FileEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = `sites/${site}/versions/${sourceVersionId}/files${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const page = await firebaseFetch<ListFilesResponse>(url, { token });
    for (const f of page.files ?? []) allFiles.push(f);
    pageToken = page.nextPageToken;
  } while (pageToken);

  const { buildRobotsTxtWithSitemap } = await import("@caelo-cms/static-generator");
  const robotsBody = buildRobotsTxtWithSitemap(
    args.target.robotsDefault,
    args.siteBaseUrl,
    allFiles.some((f) => f.path === "/sitemap.xml"),
  );
  const { body: robotsGzipped, sha256: robotsSha256 } = await gzipAndHashBytes(
    Buffer.from(robotsBody, "utf-8"),
  );
  const filesMap: Record<string, string> = {};
  for (const f of allFiles) filesMap[f.path] = f.hash;
  filesMap["/robots.txt"] = robotsSha256;

  const created = await firebaseFetch<CreateVersionResponse>(`sites/${site}/versions`, {
    method: "POST",
    body: JSON.stringify({
      config: withSecurityHeaders(
        withTargetRobotsHeader(args.sourceConfig, args.target.robotsDefault),
      ),
    }),
    token,
  });
  const versionName = created.name;
  const versionId = versionName.split("/").pop() ?? "";

  // populateFiles — the server returns which hashes still need upload.
  // That is at most the patched robots.txt: every other file is already
  // content-addressed in the site's storage from the staging upload.
  const populate = await firebaseFetch<PopulateFilesResponse>(
    `sites/${site}/versions/${versionId}:populateFiles`,
    { method: "POST", body: JSON.stringify({ files: filesMap }), token },
  );
  const required = new Set(populate.uploadRequiredHashes ?? []);
  if (required.has(robotsSha256)) {
    await uploadGzippedFile(populate.uploadUrl, robotsSha256, robotsGzipped, token);
  }

  await firebaseFetch(`sites/${site}/versions/${versionId}?updateMask=status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "FINALIZED" }),
    token,
  });
  await firebaseFetch(`sites/${site}/releases?versionName=${versionName}`, {
    method: "POST",
    body: JSON.stringify({}),
    token,
  });
  return {
    versionName,
    uploadedCount: required.size,
    skippedUnchangedCount: Object.keys(filesMap).length - required.size,
  };
}

/**
 * Create, upload and finalize a Hosting version holding exactly the files
 * of `buildDir`, with the site config for `target`: the redirects table,
 * the `/api/**` rewrite to the gateway, the cache headers and the target's
 * env-level robots header. Shared by Stage (released on a preview channel)
 * and #650's Publish live rebuild (released on the live channel).
 */
async function createVersionFromBuild(args: {
  site: string;
  token: string;
  buildDir: string;
  target: DeployTarget;
}): Promise<{ versionName: string; uploadedCount: number; skippedUnchangedCount: number }> {
  const { site, token, buildDir, target } = args;
  // 1. Walk + gzip + hash every file in the build dir.
  const walked = await walkBuildDir(buildDir);
  const fileEntries = await Promise.all(
    walked.map(async (f) => {
      const { body, sha256 } = await gzipAndHash(f.absolutePath);
      return {
        relativePath: f.relativePath,
        gzipped: body,
        sha256,
      };
    }),
  );

  // 2. Create a new version with site config — rewrites for the
  //    gateway + per-extension caching headers. The rewrites send
  //    `/api/**` traffic to the gateway Cloud Run service so visitor
  //    form submissions, comments, ratings, etc. work end-to-end.
  //    Without rewrites those requests would 404 against the static
  //    bucket — v0.3.0 shipped without them which was the launch
  //    blocker the v0.3.1 audit surfaced.
  //
  //    Gateway service name + region come from env vars set by the
  //    gcp-firebase Pulumi stack on the admin Cloud Run service.
  //    No fallback per CLAUDE.md §2 — failing to set these env vars
  //    means the gcp-firebase Pulumi stack is misconfigured.
  const gatewayService = process.env.CAELO_GATEWAY_SERVICE;
  const gatewayRegion = process.env.CAELO_GATEWAY_REGION;
  if (!gatewayService || !gatewayRegion) {
    throw new Error(
      "static-publisher-firebase: CAELO_GATEWAY_SERVICE / CAELO_GATEWAY_REGION not set. The gcp-firebase Pulumi stack must set these env vars on the admin Cloud Run service.",
    );
  }
  // The redirects table rides the version config — Hosting ignores the
  // `_redirects` file the generator writes. Every build carries that
  // file; a build without it is not one the generator produced.
  let redirectsFile: string;
  try {
    redirectsFile = await readFile(join(buildDir, "_redirects"), "utf8");
  } catch (e) {
    throw new Error(
      `static-publisher-firebase: ${join(buildDir, "_redirects")} is missing (${(e as Error).message}). The static generator writes it on every build; re-run the build instead of deploying a partial directory.`,
    );
  }
  const redirects = firebaseRedirectsFromFile(
    redirectsFile,
    target.pageUrlStyle ?? "directory",
    new Set(walked.map((f) => f.relativePath)),
  );
  const config = withTargetRobotsHeader(
    {
      redirects,
      rewrites: [
        {
          glob: "/api/**",
          run: { serviceId: gatewayService, region: gatewayRegion },
        },
      ],
      headers: VERSION_CONFIG_HEADERS,
    },
    target.robotsDefault,
  );
  const created = await firebaseFetch<CreateVersionResponse>(`sites/${site}/versions`, {
    method: "POST",
    body: JSON.stringify({ config }),
    token,
  });
  const versionName = created.name; // "sites/<site>/versions/<versionId>"
  const versionId = versionName.split("/").pop() ?? "";

  // 3. populateFiles — tell Firebase which files this version has.
  //    Firebase returns which hashes still need upload.
  const filesMap: Record<string, string> = {};
  for (const f of fileEntries) {
    // Firebase expects paths to start with `/` (e.g. "/about").
    filesMap[`/${f.relativePath}`] = f.sha256;
  }
  const populate = await firebaseFetch<PopulateFilesResponse>(
    `sites/${site}/versions/${versionId}:populateFiles`,
    {
      method: "POST",
      body: JSON.stringify({ files: filesMap }),
      token,
    },
  );
  const required = new Set(populate.uploadRequiredHashes ?? []);

  // 4. Upload only the required hashes (Firebase already has the rest).
  const toUpload = fileEntries.filter((f) => required.has(f.sha256));
  await runBatched(toUpload, PARALLEL_UPLOADS, async (f) => {
    await uploadGzippedFile(populate.uploadUrl, f.sha256, f.gzipped, token);
  });

  // 5. Finalize the version.
  await firebaseFetch(`sites/${site}/versions/${versionId}?updateMask=status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "FINALIZED" }),
    token,
  });
  return {
    versionName,
    uploadedCount: toUpload.length,
    skippedUnchangedCount: fileEntries.length - toUpload.length,
  };
}

/** A `runid-*` preview channel Stage created; `neverExpires` once it was selected as served. */
interface RunPreviewChannel {
  readonly id: string;
  readonly neverExpires: boolean;
}

/** Every `runid-*` preview channel Stage created on the site (any order). */
async function listRunPreviewChannels(site: string, token: string): Promise<RunPreviewChannel[]> {
  type ListChannelsResponse = {
    channels?: { name: string; expireTime?: string | null }[];
    nextPageToken?: string;
  };
  const found: RunPreviewChannel[] = [];
  let pageToken: string | undefined;
  do {
    const page = await firebaseFetch<ListChannelsResponse>(
      `sites/${site}/channels?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      { token },
    );
    for (const c of page.channels ?? []) {
      const id = c.name.split("/").pop() ?? "";
      // Firebase reports expireTime for every channel it will delete
      // automatically; none means the channel never expires.
      if (id.startsWith(RUN_CHANNEL_PREFIX)) found.push({ id, neverExpires: !c.expireTime });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return found;
}

function isNotFound(e: unknown): boolean {
  return e instanceof FirebaseHostingHttpError && e.status === 404;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Retire a preview that staging no longer serves. A served preview never
 * expires, so it first gets the finite TTL back: if the delete then fails
 * (transient API error), the preview still disappears on its own instead
 * of staying publicly reachable forever. Already gone counts as retired.
 */
async function retirePreviewChannel(
  site: string,
  channel: RunPreviewChannel,
  token: string,
): Promise<void> {
  let ttlError: unknown = null;
  if (channel.neverExpires) {
    try {
      await firebaseFetch(`sites/${site}/channels/${channel.id}?updateMask=ttl`, {
        method: "PATCH",
        body: JSON.stringify({ ttl: PREVIEW_CHANNEL_TTL }),
        token,
      });
    } catch (e) {
      if (!isNotFound(e)) ttlError = e;
    }
  }
  try {
    await firebaseFetch(`sites/${site}/channels/${channel.id}`, { method: "DELETE", token });
  } catch (e) {
    if (isNotFound(e)) return;
    if (ttlError === null) throw e;
    throw new Error(
      `${messageOf(e)}; restoring its TTL failed too (${messageOf(ttlError)}), so it does not expire until a later Stage or Publish live retires it`,
    );
  }
}

export const firebaseHostingPublisher: StaticPublisher = {
  async publishStaging({ buildDir, runId, target }) {
    const site = siteName();
    const token = await googleAuthToken();
    const version = await createVersionFromBuild({ site, token, buildDir, target });
    const versionName = version.versionName;

    // 6. Create a per-runId preview channel with a 7-day TTL.
    //    Firebase channel IDs must be lowercase alphanumeric +
    //    dashes; sanitise the runId UUID (already alphanumeric+dashes).
    //    #650 — the channel URL is an internal origin: the gateway proxies
    //    staging.<domain> to it behind the access gate, and it is never
    //    shown to operators or the AI. Firebase cannot lock a channel
    //    (preview channels are public by URL), so older channels are
    //    deleted as soon as a newer Stage succeeds. The TTL stays until
    //    the Stage selects the channel as the one staging serves
    //    (selectStagingPreview), so a Stage that fails after this point
    //    leaves nothing public beyond the TTL.
    const channelId = channelIdFor(runId);
    const channel = await firebaseFetch<CreateChannelResponse>(
      `sites/${site}/channels?channelId=${channelId}`,
      {
        method: "POST",
        body: JSON.stringify({
          ttl: PREVIEW_CHANNEL_TTL,
          retainedReleaseCount: 1,
        }),
        token,
      },
    );

    // 7. Release the version to the preview channel.
    await firebaseFetch(`sites/${site}/channels/${channelId}/releases?versionName=${versionName}`, {
      method: "POST",
      body: JSON.stringify({}),
      token,
    });

    const summary: PublishSummary = {
      provider: "gcp-firebase",
      uploadedCount: version.uploadedCount,
      skippedUnchangedCount: version.skippedUnchangedCount,
      location: versionName,
      previewUrl: channel.url,
    };
    return summary;
  },

  async publishLiveBuild({ buildDir, target, sourceRunId }) {
    const site = siteName();
    const token = await googleAuthToken();
    const version = await createVersionFromBuild({ site, token, buildDir, target });
    await firebaseFetch(`sites/${site}/releases?versionName=${version.versionName}`, {
      method: "POST",
      body: JSON.stringify({}),
      token,
    });
    const summary: PromoteSummary = {
      provider: "gcp-firebase",
      uploadedCount: version.uploadedCount,
      skippedUnchangedCount: version.skippedUnchangedCount,
      location: version.versionName,
      // The staged run this live build was checked against — the same id a
      // copy-promote records, so "live matches staging" keeps working.
      destinationBuildId: sourceRunId,
    };
    return summary;
  },

  async selectStagingPreview({ servedRunId }): Promise<StagingPreviewSelection> {
    const site = siteName();
    const token = await googleAuthToken();
    const channels = await listRunPreviewChannels(site, token);
    const servedId = servedRunId === null ? null : channelIdFor(servedRunId);

    // The served preview first: staging.<domain> proxies to it until the
    // next Stage — after Publish live too, where it shows the published
    // state — so an idle week must not expire it into a 404 on every page.
    // A null expireTime is Firebase's "never delete automatically". This
    // also lifts the TTL of a preview selected before served previews were
    // kept alive (an upgrade between its Stage and the next Publish live).
    if (servedId !== null) {
      const served = channels.find((c) => c.id === servedId);
      if (!served) {
        throw new Error(
          `staging serves build ${servedRunId}, but its preview channel ${servedId} no longer exists on Firebase Hosting (it expired or was deleted), so staging cannot serve it. Stage again, then retry.`,
        );
      }
      if (!served.neverExpires) {
        await firebaseFetch(`sites/${site}/channels/${servedId}?updateMask=expireTime`, {
          method: "PATCH",
          body: JSON.stringify({ expireTime: null }),
          token,
        });
      }
    }

    const retired: string[] = [];
    const notRetired: { preview: string; error: string }[] = [];
    for (const channel of channels) {
      if (channel.id === servedId) continue;
      try {
        await retirePreviewChannel(site, channel, token);
        retired.push(channel.id);
      } catch (e) {
        notRetired.push({ preview: channel.id, error: messageOf(e) });
      }
    }
    return { retired, notRetired };
  },

  async promoteToProduction({ sourceRunId, fromTarget, toTarget, siteBaseUrl }) {
    const site = siteName();
    const token = await googleAuthToken();
    // The preview channel for the source runId — its latest release's
    // version is what we promote.
    const sourceVersionName = await channelHeadVersion(site, sourceRunId, token, "promote");
    const sourceConfig = await versionConfig(site, sourceVersionName, token);
    if (
      fromTarget.robotsDefault === "noindex" &&
      toTarget.robotsDefault === "index" &&
      !hasRobotsHeader(sourceConfig)
    ) {
      const { envNoindexBuildError } = await import("@caelo-cms/static-generator");
      throw envNoindexBuildError(sourceRunId);
    }
    const released = await releaseAsTarget({
      site,
      token,
      sourceVersionName,
      sourceConfig,
      target: toTarget,
      siteBaseUrl,
    });
    const summary: PromoteSummary = {
      provider: "gcp-firebase",
      uploadedCount: released.uploadedCount,
      skippedUnchangedCount: released.skippedUnchangedCount,
      location: released.versionName,
      destinationBuildId: sourceRunId,
    };
    return summary;
  },

  async rollback({ targetBuildId, target, siteBaseUrl, sourceLocation }): Promise<PublishSummary> {
    const site = siteName();
    const token = await googleAuthToken();
    // The Hosting version the run released, as its publish summary recorded
    // it — not the run's preview channel, which #650 deletes once a newer
    // Stage succeeds. A promoted run's version is
    // already production-shaped; a staging run's carries staging's robots,
    // so the release is re-derived for the rollback target either way —
    // a no-op rewrite for a version that already matches it.
    if (!sourceLocation || !/^sites\/[^/]+\/versions\/[^/]+$/.test(sourceLocation)) {
      throw new Error(
        `firebase publisher rollback: deploy run ${targetBuildId} has no recorded Hosting version (publish_summary.location = ${JSON.stringify(sourceLocation ?? null)}), so there is nothing to re-release. Pick a run published since v0.3.0, or Stage and Publish live again.`,
      );
    }
    const released = await releaseAsTarget({
      site,
      token,
      sourceVersionName: sourceLocation,
      sourceConfig: await versionConfig(site, sourceLocation, token),
      target,
      siteBaseUrl,
    });
    return {
      provider: "gcp-firebase",
      uploadedCount: released.uploadedCount,
      skippedUnchangedCount: released.skippedUnchangedCount,
      location: released.versionName,
    };
  },
};

// Suppress unused import warning — Readable is referenced from the type
// signature of `createReadStream` consumers but not used directly.
void Readable;
