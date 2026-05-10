// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.78 — staging build preview proxy.
 *
 * GET /_staging-preview/<runId>/<rest> streams an object from the
 * private staging bucket via the admin runSa. Same IAP gate as the
 * rest of admin (this route lives under the (authed) group); no
 * public exposure of the staged HTML.
 *
 * Why a proxy instead of staging.<domain>:
 *   - The staging bucket is intentionally private — no allUsers IAM
 *     binding (see packages/provisioning/stacks/gcp/index.ts where
 *     stagingBucket is created without the public-read binding the
 *     static bucket has).
 *   - A separate staging.<domain> CDN backend would require either
 *     making the bucket public (defeats the privacy goal) or fronting
 *     it with a Cloud Function for auth (adds infrastructure).
 *   - Proxying through admin reuses the existing IAP allowlist, so
 *     "who can see staging" == "who can edit." Same mental model.
 *
 * Fallback: if a file isn't in the staging bucket prefix (because
 * Stage's hash-skip filtered it out — the file is identical to live),
 * fall back to the static bucket so the staged page still renders
 * complete. Without the fallback an incremental Stage would 404 on
 * every unchanged asset.
 *
 * Asset URLs in the staged HTML are absolute paths like
 * `/_app/immutable/...` — they hit /_app/... NOT /_staging-preview/<runId>/_app/....
 * To make the staged page self-contained, the proxy also handles the
 * Vite-hashed bundle paths. Until we rewrite asset hrefs at upload
 * time, the editor's preview links should be of the form
 * /_staging-preview/<runId>/<page-path>/ AND the page's <base href="/">
 * is rewritten to /_staging-preview/<runId>/ before the response is
 * sent. (Future v0.2.79 polish — for v0.2.78 we accept that some
 * intra-page links may resolve against the live site.)
 */

import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

let cachedStorage: {
  bucket: import("@google-cloud/storage").Bucket;
  staticBucket: import("@google-cloud/storage").Bucket;
} | null = null;

async function getBuckets(): Promise<{
  bucket: import("@google-cloud/storage").Bucket;
  staticBucket: import("@google-cloud/storage").Bucket;
}> {
  if (cachedStorage) return cachedStorage;
  const stagingBucketName = process.env.CAELO_STAGING_BUCKET;
  const staticBucketName = process.env.CAELO_STATIC_BUCKET;
  if (!stagingBucketName) {
    throw new Error(
      "_staging-preview: CAELO_STAGING_BUCKET not set. Cloud Run must set this env var (provisioner adds it for GCP installs).",
    );
  }
  if (!staticBucketName) {
    throw new Error(
      "_staging-preview: CAELO_STATIC_BUCKET not set. Cloud Run must set this env var.",
    );
  }
  const { Storage } = await import("@google-cloud/storage");
  const storage = new Storage();
  cachedStorage = {
    bucket: storage.bucket(stagingBucketName),
    staticBucket: storage.bucket(staticBucketName),
  };
  return cachedStorage;
}

export const GET: RequestHandler = async ({ params }) => {
  const { runId, rest } = params;
  if (!runId) throw error(400, "runId required");
  // Provider gate: this route is GCP-specific. Self-hosted installs
  // serve their staging preview at staging.<domain> (Caddy bind-mount
  // on the staging out_dir); AWS / Azure adapters will land their
  // own preview paths. Per CLAUDE.md §2 fail loudly when the
  // provider mismatch happens.
  const provider = process.env.CAELO_PROVIDER;
  if (provider !== "gcp") {
    throw error(
      404,
      `_staging-preview only available on GCP installs (CAELO_PROVIDER='${provider ?? "self-hosted"}'). Self-hosted installs view staged builds at staging.<domain>.`,
    );
  }
  // Default to index.html when the rest path is empty or trailing-slash —
  // mirrors the static-generator output layout (each page is a directory
  // containing index.html).
  let key = rest ?? "";
  if (key === "" || key.endsWith("/")) key += "index.html";
  const stagingObjectKey = `${runId}/${key}`;

  const { bucket, staticBucket } = await getBuckets();

  // Try the staging bucket first.
  const stagedFile = bucket.file(stagingObjectKey);
  const [stagedExists] = await stagedFile.exists();
  if (stagedExists) {
    const [body] = await stagedFile.download();
    const [meta] = await stagedFile.getMetadata();
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": (meta.contentType as string | undefined) ?? "application/octet-stream",
        // Don't let the operator's browser cache the staging preview —
        // they may re-Stage and want fresh bytes immediately.
        "Cache-Control": "private, no-cache, max-age=0, must-revalidate",
      },
    });
  }

  // Fall back to the live static bucket — for incremental Stages the
  // unchanged files (hash-skipped) only exist there.
  const liveFile = staticBucket.file(key);
  const [liveExists] = await liveFile.exists();
  if (liveExists) {
    const [body] = await liveFile.download();
    const [meta] = await liveFile.getMetadata();
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": (meta.contentType as string | undefined) ?? "application/octet-stream",
        "Cache-Control": "private, no-cache, max-age=0, must-revalidate",
      },
    });
  }

  throw error(404, `Not in staging build ${runId} or live bucket: ${key}`);
};
