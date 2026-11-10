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
 *   - Staging (#1330): a Stage's version is finalized and never released —
 *     an unreleased version is served nowhere. The staging gateway serves
 *     the build behind the gate from a full mirror in the private staging
 *     bucket (staging-slots.ts), which the upload fills file by file as
 *     the generator writes it (only files that differ from the slot).
 *     There are no preview channels any more (#1331); those an older
 *     release left are deleted ({@link retireLegacyPreviewChannels}).
 *   - Publish live: a copy — the staged version released on the live
 *     channel with the live robots, security headers and gateway rewrite
 *     (promoteToProduction, #1003: nothing is rebuilt). Rollback
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
import { readFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  PhaseTimer,
  parseSiteHeaderSet,
  parseStaticFilesManifest,
  runBatched,
  SECURITY_HEADERS_BUILD_FILE,
  SITE_DOCUMENT_PATH_PATTERN,
  type SiteHeaderSet,
  STATIC_FILES_MANIFEST_FILE,
  type StaticFileManifestEntry,
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
import {
  currentGatewayRewrite,
  hasCurrentGatewayRewrite,
  withCurrentGatewayRewrite,
} from "./firebase-gateway-rewrite.js";
import { servedChannelFiles, syncFirebaseRedirects } from "./firebase-redirect-sync.js";
import { firebaseRedirectsFromFile } from "./firebase-redirects.js";
import {
  type FirebaseHeaderEntry,
  type FirebaseVersionConfig,
  hasCurrentFixedHeaders,
  VERSION_CONFIG_HEADERS,
  withCurrentFixedHeaders,
} from "./firebase-version-headers.js";
import { GcsSlotSync, stagedSlotFiles, stagingBucket } from "./staging-slots.js";
import { contentTypeFor } from "./static-file-policy.js";
import type {
  BuildUpload,
  BuildUploadFile,
  PromoteSummary,
  PublishSummary,
  StaticPublisher,
} from "./static-publisher.js";

const FIREBASE_HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const PARALLEL_UPLOADS = 50;
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
 * Response header that keeps a non-indexable target (staging) out of
 * search engines at the serving layer — CMS_REQUIREMENTS §16.5, same
 * rule as the Caddy staging vhost. The generator no longer bakes the
 * env's `noindex` into page HTML (a staging build is what production
 * gets), so on Firebase this version-config header is what marks a
 * staging version non-indexable — together with its robots.txt.
 */
const ROBOTS_HEADER = "X-Robots-Tag";

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

/**
 * #1454 — the entry with a build's page headers. It belongs to the build (a
 * CSP names what that build ships), so a promote or rollback keeps it from
 * the version it copies, and a version from before it simply has none.
 */
export function siteHeaderEntry(set: SiteHeaderSet): FirebaseHeaderEntry {
  return { regex: SITE_DOCUMENT_PATH_PATTERN, headers: set.headers };
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

/** Every channel an older Stage created is named `runid-<runId>`; nothing else is. */
const RUN_CHANNEL_PREFIX = "runid-";

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
 * Whether the live release's config is what this release writes: its
 * `/api/**` rewrite names the gateway the admin's env names now
 * (`CAELO_GATEWAY_SERVICE`, #1380) and it carries the current fixed headers
 * (hasCurrentFixedHeaders — a release before the whole-path patterns sent
 * nosniff only on `/` and no SVG CSP). Null when nothing is live. One
 * channel read and one version read.
 */
export async function liveReleaseConfigIsCurrent(): Promise<boolean | null> {
  const site = siteName();
  const token = await googleAuthToken();
  const live = await liveChannelVersion(site, token);
  if (live === null) return null;
  const config = await versionConfig(site, live, token);
  return hasCurrentGatewayRewrite(config) && hasCurrentFixedHeaders(config);
}

/**
 * #1155 — release `liveVersionName` again with `files` replaced: same
 * config (headers, redirects, rewrites) verbatim except the `/api/**`
 * rewrite, which names the current gateway (withCurrentGatewayRewrite,
 * #1328), and the fixed headers, which are the current ones
 * (withCurrentFixedHeaders); same files by hash except the replaced ones,
 * which are the only uploads.
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
    body: JSON.stringify({
      config: withCurrentGatewayRewrite(
        withCurrentFixedHeaders(await versionConfig(site, args.liveVersionName, token)),
      ),
    }),
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
 * withTargetRobotsHeader) and the current fixed headers (see
 * withCurrentFixedHeaders — a version from before #891 lacks the SVG CSP,
 * one from before the whole-path patterns has entries Hosting matched only
 * on `/` or never) and
 * the `/api/**` rewrite to the current gateway (withCurrentGatewayRewrite —
 * a version from before #1328 names the service that is now the
 * MCP-Auth-Proxy). Page HTML + sitemap.xml are reused by hash —
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
      config: withCurrentGatewayRewrite(
        withCurrentFixedHeaders(
          withTargetRobotsHeader(args.sourceConfig, args.target.robotsDefault),
        ),
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

/**
 * Gzipped bytes a batch reaches before it is told to Hosting even with
 * fewer than {@link POPULATE_BATCH} files: 250 large pages would otherwise
 * sit in the admin at once (the generator's stream window does not see
 * them — a file is acknowledged once it is in the batch).
 */
const POPULATE_BATCH_BYTES = 8 * 1024 * 1024;

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
  /** Gzipped bytes of the waiting batch. */
  #batchBytes = 0;
  /** Batches are told to Hosting one after another. */
  #flushing: Promise<void> = Promise.resolve();
  #uploadUrl: string | null = null;
  #uploaded = 0;
  #redirectsFile: string | null = null;
  /** #1461 — the build's static files; their Content-Types ride the version config. */
  #staticFiles: readonly StaticFileManifestEntry[] | null = null;
  #siteHeaders: SiteHeaderSet | null = null;
  #state: "open" | "finished" | "aborted" = "open";
  /** #1330 — a Stage's mirror into the staging slot it fills; null for other targets. */
  readonly #slot: GcsSlotSync | null;

  private constructor(site: string, token: string, versionName: string, slot: GcsSlotSync | null) {
    this.#site = site;
    this.#token = token;
    this.#versionName = versionName;
    this.#versionId = versionName.split("/").pop() ?? "";
    this.#slot = slot;
  }

  /**
   * Create the (empty) version the build goes into. A staging build also
   * opens the sync of the staging slot `servedStagingLocation` does not name.
   */
  static async open(args: {
    target: DeployTarget;
    servedStagingLocation: string | null;
  }): Promise<FirebaseBuildUpload> {
    const site = siteName();
    const token = await googleAuthToken();
    const slot =
      args.target.env === "staging"
        ? await GcsSlotSync.open(await stagingBucket(), args.servedStagingLocation)
        : null;
    const created = await firebaseFetch<CreateVersionResponse>(`sites/${site}/versions`, {
      method: "POST",
      body: JSON.stringify({}),
      token,
    });
    return new FirebaseBuildUpload(site, token, created.name, slot);
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
    if (file.relPath === STATIC_FILES_MANIFEST_FILE) {
      this.#staticFiles = parseStaticFilesManifest(Buffer.from(file.body).toString("utf8"));
    }
    if (file.relPath === SECURITY_HEADERS_BUILD_FILE) {
      this.#siteHeaders = parseSiteHeaderSet(Buffer.from(file.body).toString("utf8"));
    }
    const raw = Buffer.from(file.body);
    const { body, sha256 } = await gzipAndHashBytes(raw);
    // #1330 — the slot keeps the plain bytes; the gzip hash names them.
    const type = file.contentType ?? contentTypeFor(file.relPath);
    await this.#slot?.take(file.relPath, { type, hash: sha256 }, (destination) =>
      destination.save(raw, { contentType: type, resumable: false }),
    );
    this.#batch.push({ path: file.relPath, sha256, gzipped: body });
    this.#batchBytes += body.byteLength;
    if (this.#batch.length >= POPULATE_BATCH || this.#batchBytes >= POPULATE_BATCH_BYTES) {
      await this.#flush();
    }
  }

  /** Tell Hosting about the waiting files and upload the ones it lacks. */
  #flush(): Promise<void> {
    const batch = this.#batch;
    this.#batch = [];
    this.#batchBytes = 0;
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
    runId: string;
  }): Promise<{
    versionName: string;
    uploadedCount: number;
    skippedUnchangedCount: number;
    /** The staging slot this upload filled; null for other targets. */
    stagingLocation: string | null;
  }> {
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
    // #1330 — the slot gets every asset it lacks, streamed from its store.
    if (this.#slot) {
      for (const asset of assets) {
        const type = contentTypeFor(asset.path);
        await this.#slot.take(asset.path, { type, hash: asset.gzipSha256 }, (destination) =>
          pipeline(
            createReadStream(assetSourcePath(references, asset)),
            destination.createWriteStream({ contentType: type, resumable: false }),
          ),
        );
      }
    }

    // The redirects table rides the version config — Hosting ignores the
    // `_redirects` file the generator writes. Every build carries that
    // file; a build without it is not one the generator produced.
    if (this.#redirectsFile === null) {
      throw new Error(
        "static-publisher-firebase: the build has no _redirects file. The static generator writes it on every build; re-run the build instead of deploying a partial one.",
      );
    }
    if (this.#staticFiles === null) {
      throw new Error(
        `static-publisher-firebase: the build has no ${STATIC_FILES_MANIFEST_FILE}. The static generator writes it on every build; re-run the build instead of deploying a partial one.`,
      );
    }
    if (this.#siteHeaders === null) {
      throw new Error(
        `static-publisher-firebase: the build has no ${SECURITY_HEADERS_BUILD_FILE}. The static generator writes it on every build; re-run the build instead of deploying a partial one.`,
      );
    }
    const served = new Set([...this.#paths, ...assets.map((a) => a.path)]);
    const config = siteConfig(
      target,
      firebaseRedirectsFromFile(this.#redirectsFile, target.pageUrlStyle ?? "directory", served),
      this.#staticFiles,
      this.#siteHeaders,
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
    const slot = this.#slot
      ? await this.#slot.finish({
          runId: args.runId,
          pageUrlStyle: target.pageUrlStyle ?? "directory",
          siteHeaders: this.#siteHeaders,
        })
      : null;
    if (slot) timer.lap("staging-slot");
    this.#state = "finished";
    const uploadedCount = this.#uploaded + assetUploads;
    return {
      versionName: this.#versionName,
      uploadedCount,
      skippedUnchangedCount: served.size - uploadedCount,
      stagingLocation: slot?.location ?? null,
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
 * Pulumi stack on the admin Cloud Run service (currentGatewayRewrite). No
 * fallback per CLAUDE.md §2 — failing to set these env vars means the stack
 * is misconfigured. Without the rewrites `/api/**` (visitor forms,
 * comments, ratings) would 404 against the static site (the v0.3.0 launch
 * blocker the v0.3.1 audit found).
 */
function siteConfig(
  target: DeployTarget,
  redirects: unknown,
  staticFiles: readonly StaticFileManifestEntry[],
  siteHeaders: SiteHeaderSet,
): FirebaseVersionConfig {
  return withTargetRobotsHeader(
    {
      redirects,
      rewrites: [currentGatewayRewrite()],
      headers: [
        ...VERSION_CONFIG_HEADERS,
        ...staticFileHeaderEntries(staticFiles),
        siteHeaderEntry(siteHeaders),
      ],
    },
    target.robotsDefault,
  );
}

/**
 * #1461 — one Content-Type entry per static file. Hosting types a file by
 * its name, which says nothing for `/.well-known/apple-app-site-association`
 * and cannot tell `text/xml` from `application/xml`. The path rules refuse
 * `.ico`, so no file meets the other Content-Type entry.
 */
export function staticFileHeaderEntries(
  files: readonly StaticFileManifestEntry[],
): { regex: string; headers: { "Content-Type": string } }[] {
  return files.map((f) => ({
    regex: `^/${f.path.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&")}$`,
    headers: { "Content-Type": f.contentType },
  }));
}

/**
 * The upload of a build: the one the generator streamed into, or — for a
 * build on disk (a test, a build made before the upload existed) — a new
 * one fed from `buildDir`, {@link CPU_PARALLELISM} files at a time.
 */
async function uploadOf(
  upload: BuildUpload | undefined,
  buildDir: string,
  open: { target: DeployTarget; servedStagingLocation: string | null },
): Promise<FirebaseBuildUpload> {
  if (upload !== undefined) {
    if (!(upload instanceof FirebaseBuildUpload)) {
      throw new Error("static-publisher-firebase: the build was streamed into another publisher");
    }
    return upload;
  }
  const opened = await FirebaseBuildUpload.open(open);
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

/** Every `runid-*` preview channel an older release's Stage created on the site. */
async function listRunPreviewChannels(site: string, token: string): Promise<string[]> {
  type ListChannelsResponse = { channels?: { name: string }[]; nextPageToken?: string };
  const found: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await firebaseFetch<ListChannelsResponse>(
      `sites/${site}/channels?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      { token },
    );
    for (const c of page.channels ?? []) {
      const id = c.name.split("/").pop() ?? "";
      if (id.startsWith(RUN_CHANNEL_PREFIX)) found.push(id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return found;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * #1331 — delete the preview channels older releases staged to. A preview
 * channel is public to anyone with its URL, so one left behind would be a
 * second, ungated path to staged pages. Run at the admin's boot and by every
 * Stage; already gone counts as deleted. Returns the channels that are still
 * there, each with why.
 */
export async function retireLegacyPreviewChannels(): Promise<
  readonly { readonly channel: string; readonly error: string }[]
> {
  const site = siteName();
  const token = await googleAuthToken();
  const left: { channel: string; error: string }[] = [];
  for (const channel of await listRunPreviewChannels(site, token)) {
    try {
      await firebaseFetch(`sites/${site}/channels/${channel}`, { method: "DELETE", token });
    } catch (e) {
      if (e instanceof FirebaseHostingHttpError && e.status === 404) continue;
      left.push({ channel, error: messageOf(e) });
    }
  }
  return left;
}

export const firebaseHostingPublisher: StaticPublisher = {
  servesCurrentDir: false,
  openBuildUpload: ({ target, servedStagingLocation }) =>
    FirebaseBuildUpload.open({ target, servedStagingLocation }),

  async publishStaging({ buildDir, runId, target, upload, servedStagingLocation }) {
    const timer = PhaseTimer.withMemory();
    try {
      const filled = await uploadOf(upload, buildDir, { target, servedStagingLocation });
      timer.lap("upload-files");
      // Finalized, never released: an unreleased version is served nowhere.
      // Publish live releases exactly this version (promoteToProduction).
      const version = await filled.finish({
        references: await readAssetReferences(buildDir),
        target,
        timer,
        runId,
      });
      // #1331 — no preview channel of an older release stays reachable.
      // A channel left behind is a public, ungated path to staged pages, so
      // the Stage does not succeed while one is still there.
      if (target.env === "staging") {
        const left = await retireLegacyPreviewChannels();
        timer.lap("retire-previews");
        if (left.length > 0) {
          throw new Error(
            `${left.length} preview channel(s) an older Caelo release staged to could not be deleted (${left.map((l) => `${l.channel}: ${l.error}`).join("; ")}). They are public by URL, so this Stage is not recorded; staging keeps the previous build. Stage again; if it persists, delete the channels under Firebase Hosting → preview channels.`,
          );
        }
      }
      const summary: PublishSummary = {
        provider: "gcp-firebase",
        uploadedCount: version.uploadedCount,
        skippedUnchangedCount: version.skippedUnchangedCount,
        location: version.versionName,
        ...(version.stagingLocation ? { stagingLocation: version.stagingLocation } : {}),
        phases: timer.phases(),
      };
      return summary;
    } finally {
      timer.close();
    }
  },

  async promoteToProduction({
    sourceRunId,
    sourceLocation,
    fromTarget,
    toTarget,
    siteBaseUrl,
    beforeRelease,
  }) {
    const site = siteName();
    const token = await googleAuthToken();
    // The Hosting version the Stage finalized — a copy of it goes live.
    if (!sourceLocation || !/^sites\/[^/]+\/versions\/[^/]+$/.test(sourceLocation)) {
      throw new Error(
        `firebase publisher promote: staged run ${sourceRunId} recorded no Hosting version (publish_summary.location = ${JSON.stringify(sourceLocation)}), so there is nothing to put live. Stage again, then Publish live.`,
      );
    }
    const sourceConfig = await versionConfig(site, sourceLocation, token);
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
      sourceVersionName: sourceLocation,
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

  async readStagedBuildFiles({ runId, location }) {
    // #1330 — the slot manifest the staging gateway serves the build by.
    return stagedSlotFiles(location, runId);
  },

  async readServedFiles({ target }) {
    if (target.env !== "production") {
      throw new Error(
        `static-publisher-firebase: ${target.name} (${target.env}) is served by the staging gateway from its slot; read a staged build with readStagedBuildFiles.`,
      );
    }
    const site = siteName();
    const token = await googleAuthToken();
    return servedChannelFiles({
      call: (path, init) => firebaseFetch(path, { ...init, token }),
      site,
      channelId: "live",
    });
  },

  async syncRedirects({ target, rows }) {
    // #1330 — staging's redirects are answered by the staging gateway, from
    // the table the admin publishes into the staging database.
    if (target.env !== "production") {
      return {
        outcome: "not-served",
        redirectCount: 0,
        goneCount: 0,
        shadowedCount: 0,
        unservedTargets: [],
        location: "the staging gateway (published redirects table)",
      };
    }
    const site = siteName();
    const token = await googleAuthToken();
    return syncFirebaseRedirects({
      call: (path, init) => firebaseFetch(path, { ...init, token }),
      site,
      channelId: "live",
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
