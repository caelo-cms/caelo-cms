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
 *     per-runId preview channel with a 7-day TTL — Firebase
 *     generates the URL automatically. Replaces v0.2.78's
 *     /_staging-preview/ proxy on `gcp` installs.
 *   - Atomic promote: Confirm-publish creates a release on the
 *     live channel pointing at the staged version. Native rollback
 *     is `POST releases:create` with an older version.
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
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { PromoteSummary, PublishSummary, StaticPublisher } from "./static-publisher.js";

const FIREBASE_HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const PARALLEL_UPLOADS = 50;
const PREVIEW_CHANNEL_TTL_DAYS = 7;

function siteName(): string {
  const site = process.env.CAELO_FIREBASE_SITE;
  if (!site) {
    throw new Error(
      "static-publisher-firebase: CAELO_FIREBASE_SITE not set. The gcp-firebase Pulumi stack must set this env var on the admin Cloud Run service.",
    );
  }
  return site;
}

async function googleAuthToken(): Promise<string> {
  // Use google-auth-library to fetch an ADC access token. On Cloud
  // Run this picks up the service account identity automatically.
  // Lazy-import so self-hosted installs don't pull the dep.
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/firebase.hosting"],
  });
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

async function firebaseFetch<T>(
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
    throw new Error(`firebase-hosting ${path} → ${res.status} ${res.statusText}: ${detail}`);
  }
  return (await res.json()) as T;
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

export const firebaseHostingPublisher: StaticPublisher = {
  async publishStaging({ buildDir, runId, target: _target }) {
    const site = siteName();
    const token = await googleAuthToken();

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

    // 2. Create a new version.
    const created = await firebaseFetch<CreateVersionResponse>(`sites/${site}/versions`, {
      method: "POST",
      body: JSON.stringify({ config: {} }),
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

    // 6. Create a per-runId preview channel with a 7-day TTL.
    //    Firebase channel IDs must be lowercase alphanumeric +
    //    dashes; sanitise the runId UUID (already alphanumeric+dashes).
    const channelId = `runid-${runId.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`.slice(0, 63);
    const channel = await firebaseFetch<CreateChannelResponse>(
      `sites/${site}/channels?channelId=${channelId}`,
      {
        method: "POST",
        body: JSON.stringify({
          ttl: `${PREVIEW_CHANNEL_TTL_DAYS * 24 * 60 * 60}s`,
          // Channels default to public — for IAP-equivalent privacy
          // we'd need Firebase Hosting's "private preview" feature
          // (still in preview as of Jan 2026). For v0.3.0 the
          // channel URL is operator-only (surfaced through the admin
          // UI which is IAP-gated); recipients have to know the
          // hash-suffixed URL. Acceptable for the dogfood phase.
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
      uploadedCount: toUpload.length,
      skippedUnchangedCount: fileEntries.length - toUpload.length,
      location: versionName,
      previewUrl: channel.url,
    };
    return summary;
  },

  async promoteToProduction({ sourceRunId, fromTarget: _from, toTarget: _to }) {
    const site = siteName();
    const token = await googleAuthToken();
    // Find the preview channel for the source runId + its latest
    // release. The release's version is what we promote.
    const channelId = `runid-${sourceRunId.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`.slice(0, 63);
    type Release = { name: string; version: { name: string } };
    type ListReleasesResponse = { releases?: Release[] };
    const releases = await firebaseFetch<ListReleasesResponse>(
      `sites/${site}/channels/${channelId}/releases`,
      { token },
    );
    const head = releases.releases?.[0];
    if (!head) {
      throw new Error(
        `firebase publisher promote: no releases found on channel ${channelId}. Run Stage first.`,
      );
    }
    // Release the version on the live channel.
    await firebaseFetch(`sites/${site}/releases?versionName=${head.version.name}`, {
      method: "POST",
      body: JSON.stringify({}),
      token,
    });
    const summary: PromoteSummary = {
      provider: "gcp-firebase",
      uploadedCount: 0, // Firebase server-side promotion; no client-side uploads.
      skippedUnchangedCount: 0,
      location: head.version.name,
      destinationBuildId: sourceRunId,
    };
    return summary;
  },

  async rollback({ targetBuildId, target: _target }): Promise<PublishSummary> {
    const site = siteName();
    const token = await googleAuthToken();
    // Look up the version-name for the source runId via the channel's
    // release history. Same shape as promoteToProduction.
    const channelId = `runid-${targetBuildId.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`.slice(
      0,
      63,
    );
    type Release = { name: string; version: { name: string } };
    type ListReleasesResponse = { releases?: Release[] };
    const releases = await firebaseFetch<ListReleasesResponse>(
      `sites/${site}/channels/${channelId}/releases`,
      { token },
    );
    const head = releases.releases?.[0];
    if (!head) {
      throw new Error(
        `firebase publisher rollback: no releases found on channel ${channelId} for runId=${targetBuildId}.`,
      );
    }
    await firebaseFetch(`sites/${site}/releases?versionName=${head.version.name}`, {
      method: "POST",
      body: JSON.stringify({}),
      token,
    });
    return {
      provider: "gcp-firebase",
      uploadedCount: 0,
      skippedUnchangedCount: 0,
      location: head.version.name,
    };
  },
};

// Suppress unused import warning — Readable is referenced from the type
// signature of `createReadStream` consumers but not used directly.
void Readable;
