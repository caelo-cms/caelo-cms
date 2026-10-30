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
 *     Stage succeeds, the last one after Publish live. #969 — a preview
 *     channel cannot be made permanent (Firebase refuses to clear its
 *     expireTime), so the served one is kept alive by refreshing its TTL
 *     to Firebase's 30-day maximum on every Stage, Publish live and
 *     periodic keep-alive (refreshStagingPreview).
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
import { readFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import {
  CONTENT_HASHED_PATH_PATTERN,
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  NOSNIFF,
  PhaseTimer,
  runBatched,
  SVG_DOCUMENT_CSP,
  SVG_PATH_PATTERN,
} from "@caelo-cms/shared";
import {
  type AssetReference,
  type AssetReferences,
  assetSourcePath,
  chunkedFileStream,
  type DeployTarget,
  digestProfile,
  hostingGzip,
  readAssetReferences,
} from "@caelo-cms/static-generator";
import { CPU_PARALLELISM, readBuildFiles, uniqueAssets } from "./build-files.js";
import { readFirebaseBuiltFile } from "./firebase-channel-file.js";
import { syncFirebaseRedirects } from "./firebase-redirect-sync.js";
import { firebaseRedirectsFromFile } from "./firebase-redirects.js";
import type {
  BuildUpload,
  BuildUploadFile,
  PromoteSummary,
  PublishSummary,
  StagingPreviewRefresh,
  StagingPreviewSelection,
  StaticPublisher,
} from "./static-publisher.js";

const FIREBASE_HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const PARALLEL_UPLOADS = 50;
const PREVIEW_CHANNEL_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Firebase `ttl` duration of a preview channel staging does not serve. */
const PREVIEW_CHANNEL_TTL = `${PREVIEW_CHANNEL_TTL_DAYS * 24 * 60 * 60}s`;
/**
 * #969 — the longest a preview channel can live: Firebase documents "up to
 * 30 days" (firebase-tools enforces it as MAX_DURATION) and refuses to clear
 * a preview channel's expireTime, so only the live channel never expires.
 */
const SERVED_PREVIEW_CHANNEL_TTL_DAYS = 30;
/** Firebase `ttl` duration the served preview is refreshed to. */
export const SERVED_PREVIEW_CHANNEL_TTL = `${SERVED_PREVIEW_CHANNEL_TTL_DAYS * 24 * 60 * 60}s`;

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
 * Gzip in-memory bytes the way Hosting stores them (the hosting gzip of the
 * stored media digests) and hash the result: Hosting keys every file by the
 * sha256 of its gzipped body. Every file of a build passes here (#1271), and
 * `releaseAsTarget` patches robots.txt with it.
 */
async function gzipAndHashBytes(input: Buffer): Promise<{ body: Buffer; sha256: string }> {
  return await new Promise((resolve, reject) => {
    const gz = hostingGzip();
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

/** The URL of the site's live channel (what visitors are served). */
export async function firebaseLiveChannelUrl(): Promise<string> {
  const channel = await firebaseFetch<{ url?: string }>(`sites/${siteName()}/channels/live`);
  if (!channel.url) {
    throw new Error(
      `firebase-hosting: the live channel of site ${siteName()} reported no url — nothing has been published live yet`,
    );
  }
  return channel.url;
}

/** One file of a Hosting version: its path (`/about/index.html`) and content hash. */
interface VersionFileEntry {
  readonly path: string;
  readonly hash: string;
  readonly status: string;
}

/** A version's full file manifest. Firebase paginates — walk until exhausted. */
async function listVersionFiles(
  site: string,
  versionId: string,
  token: string,
): Promise<VersionFileEntry[]> {
  type ListFilesResponse = { files?: VersionFileEntry[]; nextPageToken?: string };
  const allFiles: VersionFileEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = `sites/${site}/versions/${versionId}/files${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const page = await firebaseFetch<ListFilesResponse>(url, { token });
    for (const f of page.files ?? []) allFiles.push(f);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return allFiles;
}

/** The version the live channel's latest release points at, or null. */
async function liveChannelVersion(site: string, token: string): Promise<string | null> {
  type Release = { type?: string; version?: { name?: string } };
  const r = await firebaseFetch<{ releases?: Release[] }>(
    `sites/${site}/channels/live/releases?pageSize=1`,
    { token },
  );
  const head = r.releases?.[0];
  if (!head || head.type === "SITE_DISABLE") return null;
  return head.version?.name ?? null;
}

/**
 * #1155 — release `liveVersionName` again with `files` replaced: same
 * config (headers, redirects, rewrites) verbatim, same files by hash
 * except the replaced ones, which are the only uploads.
 */
async function releasePluginDataVersion(args: {
  site: string;
  token: string;
  liveVersionName: string;
  files: ReadonlyMap<string, Buffer>;
  /** See StaticPublisher.publishPluginData. */
  beforeRelease?: () => Promise<void>;
}): Promise<{ versionName: string; uploadedCount: number; skippedUnchangedCount: number }> {
  const { site, token } = args;
  const liveVersionId = args.liveVersionName.split("/").pop() ?? "";
  const allFiles = await listVersionFiles(site, liveVersionId, token);
  const filesMap: Record<string, string> = {};
  for (const f of allFiles) filesMap[f.path] = f.hash;
  const replaced = new Map<string, Buffer>();
  for (const [path, body] of args.files) {
    const key = `/${path}`;
    if (!(key in filesMap)) {
      throw new Error(
        `firebase publisher: ${path} is not a file of the live version ${args.liveVersionName} — a plugin-data build only replaces files the build has`,
      );
    }
    const { body: gzipped, sha256 } = await gzipAndHashBytes(body);
    filesMap[key] = sha256;
    replaced.set(sha256, gzipped);
  }
  const created = await firebaseFetch<CreateVersionResponse>(`sites/${site}/versions`, {
    method: "POST",
    body: JSON.stringify({ config: await versionConfig(site, args.liveVersionName, token) }),
    token,
  });
  const versionName = created.name;
  const versionId = versionName.split("/").pop() ?? "";
  const populate = await firebaseFetch<PopulateFilesResponse>(
    `sites/${site}/versions/${versionId}:populateFiles`,
    { method: "POST", body: JSON.stringify({ files: filesMap }), token },
  );
  const required = new Set(populate.uploadRequiredHashes ?? []);
  const toUpload = [...replaced.entries()].filter(([hash]) => required.has(hash));
  await runBatched(toUpload, PARALLEL_UPLOADS, async ([hash, gzipped]) => {
    await uploadGzippedFile(populate.uploadUrl, hash, gzipped, token);
  });
  await firebaseFetch(`sites/${site}/versions/${versionId}?updateMask=status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "FINALIZED" }),
    token,
  });
  await args.beforeRelease?.();
  await firebaseFetch(`sites/${site}/releases?versionName=${versionName}`, {
    method: "POST",
    body: JSON.stringify({ message: "Caelo: plugin data (#1155)" }),
    token,
  });
  return {
    versionName,
    uploadedCount: toUpload.length,
    skippedUnchangedCount: Object.keys(filesMap).length - toUpload.length,
  };
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
  /** See StaticPublisher.promoteToProduction. */
  beforeRelease?: () => Promise<void>;
}): Promise<{ versionName: string; uploadedCount: number; skippedUnchangedCount: number }> {
  const { site, token } = args;
  const sourceVersionId = args.sourceVersionName.split("/").pop() ?? "";

  // Every path is needed so the new version is identical except for the
  // patched robots.txt.
  const allFiles = await listVersionFiles(site, sourceVersionId, token);

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
  await args.beforeRelease?.();
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
 * Files per `populateFiles` call. Hosting is told about the files of a
 * batch at once and the ones it lacks are uploaded before the batch is
 * dropped, so this many gzipped bodies are the most the upload holds.
 */
const POPULATE_BATCH = 250;

/** A built file gzipped and waiting for its batch's `populateFiles`. */
interface PendingFile {
  readonly path: string;
  readonly sha256: string;
  readonly gzipped: Buffer;
}

/**
 * #1271 — a Hosting version filled while the generator writes the build.
 *
 * Created at the start without config (as firebase-tools does); every
 * served file is gzipped + hashed as it arrives and told to Hosting in
 * batches of {@link POPULATE_BATCH} (`populateFiles`), and the files of the
 * batch Hosting lacks are uploaded right away, {@link PARALLEL_UPLOADS} at a
 * time, before the batch is dropped. The media and fonts the build
 * references are named by their stored gzip hash and streamed from their
 * store only when Hosting lacks them. {@link finish} sets the site config —
 * the redirects need every served path — and finalizes the version.
 * Memory: a batch of gzipped files plus the paths, whatever the site's size.
 */
class FirebaseBuildUpload implements BuildUpload {
  readonly #site: string;
  readonly #token: string;
  readonly #versionName: string;
  readonly #versionId: string;
  readonly #paths = new Set<string>();
  /** Hashes this version uploaded or Hosting said it has. */
  readonly #known = new Set<string>();
  #batch: PendingFile[] = [];
  /** Batches are told to Hosting one after another. */
  #flushing: Promise<void> = Promise.resolve();
  #uploadUrl: string | null = null;
  #uploaded = 0;
  #redirectsFile: string | null = null;
  #state: "open" | "finished" | "aborted" = "open";

  private constructor(site: string, token: string, versionName: string) {
    this.#site = site;
    this.#token = token;
    this.#versionName = versionName;
    this.#versionId = versionName.split("/").pop() ?? "";
  }

  /** Create the (empty) version the build goes into. */
  static async open(): Promise<FirebaseBuildUpload> {
    const site = siteName();
    const token = await googleAuthToken();
    const created = await firebaseFetch<CreateVersionResponse>(`sites/${site}/versions`, {
      method: "POST",
      body: JSON.stringify({}),
      token,
    });
    return new FirebaseBuildUpload(site, token, created.name);
  }

  async put(file: BuildUploadFile): Promise<void> {
    if (this.#state !== "open") throw new Error(`firebase upload is ${this.#state}`);
    if (this.#paths.has(file.relPath)) {
      throw new Error(`static-publisher-firebase: ${file.relPath} was written twice`);
    }
    this.#paths.add(file.relPath);
    // The redirects ride the version config, built at finish().
    if (file.relPath === "_redirects")
      this.#redirectsFile = Buffer.from(file.body).toString("utf8");
    const { body, sha256 } = await gzipAndHashBytes(Buffer.from(file.body));
    this.#batch.push({ path: file.relPath, sha256, gzipped: body });
    if (this.#batch.length >= POPULATE_BATCH) await this.#flush();
  }

  /** Tell Hosting about the waiting files and upload the ones it lacks. */
  #flush(): Promise<void> {
    const batch = this.#batch;
    this.#batch = [];
    this.#flushing = this.#flushing.then(async () => {
      if (batch.length === 0) return;
      const required = await this.#populate(batch.map((f) => [f.path, f.sha256]));
      const toUpload = new Map<string, PendingFile>();
      for (const f of batch) {
        if (required.has(f.sha256) && !toUpload.has(f.sha256)) toUpload.set(f.sha256, f);
      }
      await runBatched([...toUpload.values()], PARALLEL_UPLOADS, async (f) => {
        await uploadGzippedFile(this.#url(), f.sha256, f.gzipped, this.#token);
      });
      this.#uploaded += toUpload.size;
    });
    return this.#flushing;
  }

  /** One `populateFiles` call; returns the hashes Hosting still needs (not yet uploaded here). */
  async #populate(files: readonly (readonly [string, string])[]): Promise<Set<string>> {
    const filesMap: Record<string, string> = {};
    // Firebase expects paths to start with `/` (e.g. "/about").
    for (const [path, sha] of files) filesMap[`/${path}`] = sha;
    const populate = await firebaseFetch<PopulateFilesResponse>(
      `sites/${this.#site}/versions/${this.#versionId}:populateFiles`,
      { method: "POST", body: JSON.stringify({ files: filesMap }), token: this.#token },
    );
    this.#uploadUrl = populate.uploadUrl;
    const required = new Set<string>();
    for (const h of populate.uploadRequiredHashes ?? []) {
      if (!this.#known.has(h)) required.add(h);
    }
    for (const [, sha] of files) this.#known.add(sha);
    return required;
  }

  #url(): string {
    if (this.#uploadUrl === null) {
      throw new Error("static-publisher-firebase: populateFiles returned no upload URL");
    }
    return this.#uploadUrl;
  }

  /**
   * Put the referenced media and fonts, set the site config for `target`
   * and finalize the version. Laps `populate`, `upload-assets`, `finalize`.
   */
  async finish(args: {
    references: AssetReferences;
    target: DeployTarget;
    timer: PhaseTimer;
  }): Promise<{ versionName: string; uploadedCount: number; skippedUnchangedCount: number }> {
    if (this.#state !== "open") throw new Error(`firebase upload is ${this.#state}`);
    const { references, target, timer } = args;
    await this.#flush();
    timer.lap("populate");
    const profile = await digestProfile();
    const assets = uniqueAssets(references);
    for (const asset of assets) {
      if (asset.digestProfile !== profile) {
        throw new Error(
          `static-publisher-firebase: ${asset.path} carries gzip digests of another gzip (${asset.digestProfile}; this Caelo gzips as ${profile}), so Hosting could not match the upload. Stage again: every Stage first digests such media anew (media.rebuild_digests).`,
        );
      }
      if (this.#paths.has(asset.path)) {
        throw new Error(
          `static-publisher-firebase: ${asset.path} is both a file of the build and a referenced asset. Re-run the build.`,
        );
      }
    }
    let assetUploads = 0;
    for (let at = 0; at < assets.length; at += POPULATE_BATCH) {
      const batch = assets.slice(at, at + POPULATE_BATCH);
      const required = await this.#populate(batch.map((a) => [a.path, a.gzipSha256]));
      const toUpload = new Map<string, AssetReference>();
      for (const a of batch) {
        if (required.has(a.gzipSha256) && !toUpload.has(a.gzipSha256))
          toUpload.set(a.gzipSha256, a);
      }
      await runBatched([...toUpload.values()], PARALLEL_UPLOADS, async (a) => {
        await uploadAsset(this.#url(), a, assetSourcePath(references, a), this.#token);
      });
      assetUploads += toUpload.size;
    }
    timer.lap("upload-assets");

    // The redirects table rides the version config — Hosting ignores the
    // `_redirects` file the generator writes. Every build carries that
    // file; a build without it is not one the generator produced.
    if (this.#redirectsFile === null) {
      throw new Error(
        "static-publisher-firebase: the build has no _redirects file. The static generator writes it on every build; re-run the build instead of deploying a partial one.",
      );
    }
    const served = new Set([...this.#paths, ...assets.map((a) => a.path)]);
    const config = siteConfig(
      target,
      firebaseRedirectsFromFile(this.#redirectsFile, target.pageUrlStyle ?? "directory", served),
    );
    // Config and status in one update, as firebase-tools finalizes.
    await firebaseFetch(
      `sites/${this.#site}/versions/${this.#versionId}?updateMask=status,config`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "FINALIZED", config }),
        token: this.#token,
      },
    );
    timer.lap("finalize");
    this.#state = "finished";
    const uploadedCount = this.#uploaded + assetUploads;
    return {
      versionName: this.#versionName,
      uploadedCount,
      skippedUnchangedCount: served.size - uploadedCount,
    };
  }

  async abort(): Promise<void> {
    if (this.#state !== "open") return;
    this.#state = "aborted";
    try {
      await firebaseFetch(`sites/${this.#site}/versions/${this.#versionId}`, {
        method: "DELETE",
        token: this.#token,
      });
    } catch (e) {
      // An unfinalized version is never served; one left behind is only clutter.
      console.error("[deploy] could not delete an abandoned Hosting version", {
        version: this.#versionName,
        error: messageOf(e),
      });
    }
  }

  /** The token the upload authenticated with (for the release calls after it). */
  get token(): string {
    return this.#token;
  }

  get site(): string {
    return this.#site;
  }
}

/**
 * The Hosting config of a build for `target`: the redirects, the `/api/**`
 * rewrite to the gateway, the cache headers and the env-level robots header.
 *
 * Gateway service name + region come from env vars set by the gcp-firebase
 * Pulumi stack on the admin Cloud Run service. No fallback per CLAUDE.md §2
 * — failing to set these env vars means the stack is misconfigured. Without
 * the rewrites `/api/**` (visitor forms, comments, ratings) would 404
 * against the static site (the v0.3.0 launch blocker the v0.3.1 audit found).
 */
function siteConfig(target: DeployTarget, redirects: unknown): FirebaseVersionConfig {
  const gatewayService = process.env.CAELO_GATEWAY_SERVICE;
  const gatewayRegion = process.env.CAELO_GATEWAY_REGION;
  if (!gatewayService || !gatewayRegion) {
    throw new Error(
      "static-publisher-firebase: CAELO_GATEWAY_SERVICE / CAELO_GATEWAY_REGION not set. The gcp-firebase Pulumi stack must set these env vars on the admin Cloud Run service.",
    );
  }
  return withTargetRobotsHeader(
    {
      redirects,
      rewrites: [{ glob: "/api/**", run: { serviceId: gatewayService, region: gatewayRegion } }],
      headers: VERSION_CONFIG_HEADERS,
    },
    target.robotsDefault,
  );
}

/**
 * The upload of a build: the one the generator streamed into, or — for a
 * build on disk (a test, a build made before the upload existed) — a new
 * one fed from `buildDir`, {@link CPU_PARALLELISM} files at a time.
 */
async function uploadOf(
  upload: BuildUpload | undefined,
  buildDir: string,
): Promise<FirebaseBuildUpload> {
  if (upload !== undefined) {
    if (!(upload instanceof FirebaseBuildUpload)) {
      throw new Error("static-publisher-firebase: the build was streamed into another publisher");
    }
    return upload;
  }
  const opened = await FirebaseBuildUpload.open();
  try {
    const build = await readBuildFiles(buildDir);
    await runBatched([...build.built], CPU_PARALLELISM, async (f) => {
      await opened.put({ relPath: f.relativePath, body: await readFile(f.absolutePath) });
    });
  } catch (e) {
    await opened.abort();
    throw e;
  }
  return opened;
}

/**
 * Stream one referenced media / font file to Hosting, gzipped on the way,
 * with the stored gzip length as Content-Length — never buffered whole.
 * The bytes are hashed as they pass: a file that no longer matches its
 * stored digest (replaced outside Caelo) fails with the repair, not with
 * Hosting's bare hash mismatch.
 */
async function uploadAsset(
  uploadUrlBase: string,
  asset: AssetReference,
  absolutePath: string,
  token: string,
): Promise<void> {
  const hash = createHash("sha256");
  let sentBytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      sentBytes += chunk.byteLength;
      done(null, chunk);
    },
  });
  const source = chunkedFileStream(absolutePath);
  const gzipped = source.pipe(hostingGzip()).pipe(tap);
  let readError: NodeJS.ErrnoException | null = null;
  source.on("error", (e: NodeJS.ErrnoException) => {
    readError = e;
    gzipped.destroy(e);
  });
  let res: Response;
  try {
    res = await fetch(`${uploadUrlBase}/${asset.gzipSha256}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(asset.gzipSize),
      },
      // node:stream/web and the DOM lib name the same stream type differently.
      body: Readable.toWeb(gzipped) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit);
  } catch (e) {
    const code = (readError as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `static-publisher-firebase: the stored file of ${asset.path} is missing (${absolutePath}). Find it with list_missing_media and restore it, or remove it from the pages that use it, then Stage again.`,
      );
    }
    // More bytes than the stored length declared: the file changed.
    if (sentBytes > asset.gzipSize) throw changedOutsideCaelo(asset);
    throw e;
  }
  // Every byte passed the tap once the stream ended (or, with the length
  // declared up front, once that many bytes went out).
  const sent = tap.readableEnded || sentBytes === asset.gzipSize;
  // Hosting refuses a body whose hash is not the one named in the URL; say
  // why, with the repair, instead of passing on its bare refusal.
  if (sent && hash.digest("hex") !== asset.gzipSha256) throw changedOutsideCaelo(asset);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `firebase-hosting upload ${asset.path} (${asset.gzipSha256}) → ${res.status}: ${detail}`,
    );
  }
  if (!sent) {
    throw new Error(
      `firebase-hosting upload ${asset.path} (${asset.gzipSha256}): Hosting answered before the whole file was sent. Stage again.`,
    );
  }
}

/** The refusal for a stored file that no longer matches its stored digest. */
function changedOutsideCaelo(asset: AssetReference): Error {
  return new Error(
    `static-publisher-firebase: the stored file of ${asset.path} no longer matches its stored digest (it was changed outside Caelo, in the media store). Next step: restore the original file in the media store (or re-upload the image as a new asset and point the pages at it), then Stage again.`,
  );
}

/** A `runid-*` preview channel Stage created, with when Firebase deletes it (null: never). */
interface RunPreviewChannel {
  readonly id: string;
  readonly expireTime: string | null;
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
      if (id.startsWith(RUN_CHANNEL_PREFIX)) found.push({ id, expireTime: c.expireTime ?? null });
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
 * #969 — whether a preview about to be retired outlives the regular preview
 * TTL from `nowMs` on (it was the served one, refreshed to 30 days, or it
 * carries no expiry at all), so it must get the short TTL back before the
 * delete: a failed delete then still takes it offline within a week.
 */
export function outlivesRetiredPreviewTtl(expireTime: string | null, nowMs: number): boolean {
  if (expireTime === null) return true;
  const expiresAt = Date.parse(expireTime);
  if (Number.isNaN(expiresAt)) {
    throw new Error(
      `firebase publisher: Firebase reported an unparseable channel expireTime ${JSON.stringify(expireTime)}`,
    );
  }
  return expiresAt > nowMs + PREVIEW_CHANNEL_TTL_DAYS * DAY_MS;
}

/**
 * Set a channel's TTL (`expireTime` = now + `ttl`) — the only way Firebase
 * changes a preview channel's lifetime; `updateMask=expireTime` with a null
 * expireTime is refused with 400 "mask included expire_time, while channel
 * has no expire time assigned" (#969). Returns the expireTime Firebase now
 * reports, and fails loudly when it reports none.
 */
async function setChannelTtl(
  site: string,
  channelId: string,
  ttl: string,
  token: string,
): Promise<string> {
  const updated = await firebaseFetch<{ expireTime?: string | null }>(
    `sites/${site}/channels/${channelId}?updateMask=ttl`,
    { method: "PATCH", body: JSON.stringify({ ttl }), token },
  );
  if (!updated.expireTime) {
    throw new Error(
      `firebase publisher: setting ttl=${ttl} on preview channel ${channelId} returned no expireTime, so its lifetime is unknown. Check the channel in the Firebase console (Hosting → preview channels).`,
    );
  }
  return updated.expireTime;
}

/** The error for a served preview Firebase no longer has. */
function servedPreviewGone(servedRunId: string, channelId: string): Error {
  return new Error(
    `staging serves build ${servedRunId}, but its preview channel ${channelId} no longer exists on Firebase Hosting (it expired or was deleted), so staging cannot serve it. Stage again, then retry.`,
  );
}

/**
 * Retire a preview that staging no longer serves. One that outlives the
 * regular TTL (the previously served one) first gets the short TTL back:
 * if the delete then fails (transient API error), the preview still
 * disappears within a week instead of staying publicly reachable for a
 * month. Already gone counts as retired.
 */
async function retirePreviewChannel(
  site: string,
  channel: RunPreviewChannel,
  token: string,
): Promise<void> {
  let ttlError: unknown = null;
  if (outlivesRetiredPreviewTtl(channel.expireTime, Date.now())) {
    try {
      await setChannelTtl(site, channel.id, PREVIEW_CHANNEL_TTL, token);
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
      `${messageOf(e)}; shortening its TTL failed too (${messageOf(ttlError)}), so it stays reachable until its current expiry (${channel.expireTime ?? "none"}) or until a later Stage or Publish live retires it`,
    );
  }
}

export const firebaseHostingPublisher: StaticPublisher = {
  servesCurrentDir: false,
  openBuildUpload: () => FirebaseBuildUpload.open(),

  async publishStaging({ buildDir, runId, target, upload }) {
    const timer = PhaseTimer.withMemory();
    try {
      const filled = await uploadOf(upload, buildDir);
      const site = filled.site;
      const token = filled.token;
      timer.lap("upload-files");
      const version = await filled.finish({
        references: await readAssetReferences(buildDir),
        target,
        timer,
      });
      const versionName = version.versionName;

      // 6. Create a per-runId preview channel with a 7-day TTL.
      //    Firebase channel IDs must be lowercase alphanumeric +
      //    dashes; sanitise the runId UUID (already alphanumeric+dashes).
      //    #650 — the channel URL is an internal origin: the gateway proxies
      //    staging.<domain> to it behind the access gate, and it is never
      //    shown to operators or the AI. Firebase cannot lock a channel
      //    (preview channels are public by URL), so older channels are
      //    deleted as soon as a newer Stage succeeds. The 7-day TTL stays
      //    until the Stage selects the channel as the one staging serves
      //    (selectStagingPreview refreshes it to 30 days), so a Stage that
      //    fails after this point leaves nothing public beyond a week.
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
      timer.lap("channel");

      // 7. Release the version to the preview channel.
      await firebaseFetch(
        `sites/${site}/channels/${channelId}/releases?versionName=${versionName}`,
        {
          method: "POST",
          body: JSON.stringify({}),
          token,
        },
      );
      timer.lap("release");

      const summary: PublishSummary = {
        provider: "gcp-firebase",
        uploadedCount: version.uploadedCount,
        skippedUnchangedCount: version.skippedUnchangedCount,
        location: versionName,
        previewUrl: channel.url,
        phases: timer.phases(),
      };
      return summary;
    } finally {
      timer.close();
    }
  },

  async publishLiveBuild({ buildDir, target, sourceRunId, beforeRelease, upload }) {
    const timer = PhaseTimer.withMemory();
    try {
      const filled = await uploadOf(upload, buildDir);
      const site = filled.site;
      const token = filled.token;
      timer.lap("upload-files");
      const version = await filled.finish({
        references: await readAssetReferences(buildDir),
        target,
        timer,
      });
      // The upload above changes nothing that is served; the release does.
      await beforeRelease?.();
      await firebaseFetch(`sites/${site}/releases?versionName=${version.versionName}`, {
        method: "POST",
        body: JSON.stringify({}),
        token,
      });
      timer.lap("release");
      const summary: PromoteSummary = {
        provider: "gcp-firebase",
        uploadedCount: version.uploadedCount,
        skippedUnchangedCount: version.skippedUnchangedCount,
        location: version.versionName,
        // The staged run this live build was checked against — the same id a
        // copy-promote records, so "live matches staging" keeps working.
        destinationBuildId: sourceRunId,
        phases: timer.phases(),
      };
      return summary;
    } finally {
      timer.close();
    }
  },

  async selectStagingPreview({ servedRunId, retireUntil }): Promise<StagingPreviewSelection> {
    const site = siteName();
    const token = await googleAuthToken();
    const channels = await listRunPreviewChannels(site, token);
    const servedId = servedRunId === null ? null : channelIdFor(servedRunId);

    // The served preview first: staging.<domain> proxies to it until the
    // next Stage — after Publish live too, where it shows the published
    // state — so an idle period must not expire it into a 404 on every
    // page. #969 — Firebase cannot make a preview channel permanent; its
    // TTL is refreshed to the 30-day maximum here and by the periodic
    // keep-alive (refreshStagingPreview).
    let servedExpiresAt: string | null = null;
    if (servedRunId !== null && servedId !== null) {
      if (!channels.some((c) => c.id === servedId)) {
        throw servedPreviewGone(servedRunId, servedId);
      }
      servedExpiresAt = await setChannelTtl(site, servedId, SERVED_PREVIEW_CHANNEL_TTL, token);
    }

    const retired: string[] = [];
    const notRetired: { preview: string; error: string }[] = [];
    for (const channel of channels) {
      if (channel.id === servedId) continue;
      if (retireUntil !== undefined && Date.now() >= retireUntil) {
        notRetired.push({
          preview: channel.id,
          error:
            "not retired: the Stage selecting the served preview could no longer prove it holds the staging publish slot; the next Stage or Publish live retires it",
        });
        continue;
      }
      try {
        await retirePreviewChannel(site, channel, token);
        retired.push(channel.id);
      } catch (e) {
        notRetired.push({ preview: channel.id, error: messageOf(e) });
      }
    }
    return { retired, notRetired, servedExpiresAt };
  },

  async refreshStagingPreview({ servedRunId }): Promise<StagingPreviewRefresh> {
    const site = siteName();
    const token = await googleAuthToken();
    const channelId = channelIdFor(servedRunId);
    // Read first: a PATCH on a missing channel would implicitly create an
    // empty one, and staging would serve 404s without anyone noticing.
    try {
      await firebaseFetch(`sites/${site}/channels/${channelId}`, { token });
    } catch (e) {
      if (isNotFound(e)) throw servedPreviewGone(servedRunId, channelId);
      throw e;
    }
    const expiresAt = await setChannelTtl(site, channelId, SERVED_PREVIEW_CHANNEL_TTL, token);
    return { expiresAt };
  },

  async promoteToProduction({ sourceRunId, fromTarget, toTarget, siteBaseUrl, beforeRelease }) {
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
      ...(beforeRelease ? { beforeRelease } : {}),
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

  async syncRedirects({ target, rows, servedRunId }) {
    const site = siteName();
    const token = await googleAuthToken();
    return syncFirebaseRedirects({
      call: (path, init) => firebaseFetch(path, { ...init, token }),
      site,
      // Production is the live channel; staging is the preview channel the
      // staging host serves (#650), named after its run.
      channelId: target.env === "production" ? "live" : channelIdFor(servedRunId),
      target,
      rows,
    });
  },

  async readLiveFiles({ live, paths }) {
    const site = siteName();
    const token = await googleAuthToken();
    await assertLiveIs(site, token, live.location);
    const origin = await firebaseLiveChannelUrl();
    const out = new Map<string, Buffer | null>();
    await runBatched([...paths], PARALLEL_UPLOADS, async (path) => {
      const file = await readFirebaseBuiltFile(origin, path);
      // Only "not there" means absent (a 404, or the redirect Hosting
      // answers for a path the build lacks). Anything else — a 429, a 5xx —
      // is a failed read: thrown, so the build fails and its marks stay
      // pending for the next tick instead of being consumed unbaked.
      if (!file.found && file.status !== 404 && !(file.status >= 300 && file.status < 400)) {
        throw new Error(
          `firebase publisher: reading ${path} from the live channel answered HTTP ${file.status}; try again on the next tick`,
        );
      }
      out.set(path, file.found ? file.body : null);
    });
    return out;
  },

  async publishPluginData({ live, runId, files, beforeRelease }) {
    const site = siteName();
    const token = await googleAuthToken();
    const liveVersionName = await assertLiveIs(site, token, live.location);
    const released = await releasePluginDataVersion({
      site,
      token,
      liveVersionName,
      files,
      ...(beforeRelease ? { beforeRelease } : {}),
    });
    return {
      provider: "gcp-firebase",
      uploadedCount: released.uploadedCount,
      skippedUnchangedCount: released.skippedUnchangedCount,
      location: released.versionName,
      destinationBuildId: runId,
    };
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

/**
 * #1155 — the live channel serves the version the live run recorded, or
 * throw: plugin data is never published on top of a release no deploy run
 * recorded. Returns that version's name.
 */
async function assertLiveIs(site: string, token: string, recorded: string | null): Promise<string> {
  if (!recorded || !/^sites\/[^/]+\/versions\/[^/]+$/.test(recorded)) {
    throw new Error(
      `firebase publisher: the live production run recorded no Hosting version (${JSON.stringify(recorded)}), so plugin data cannot be published on top of it. Publish live again.`,
    );
  }
  const served = await liveChannelVersion(site, token);
  if (served !== recorded) {
    throw new Error(
      `firebase publisher: the live channel serves ${served ?? "nothing"}, but the last recorded production run released ${recorded} — something was released outside Caelo. Publish live again; plugin data is not published on top of an unrecorded release.`,
    );
  }
  return recorded;
}
