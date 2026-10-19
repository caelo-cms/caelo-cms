// SPDX-License-Identifier: MPL-2.0

/**
 * The request handling behind GET /_staging-preview/<runId>/<rest> (see the
 * route for why staging is proxied through admin). Separate from the route
 * so the bucket access can be injected: the route passes
 * {@link gcsStagingPreviewBuckets}, tests pass fakes.
 *
 * Error mapping: the admin has no `handleError` hook, so a plain thrown
 * Error reaches the operator as SvelteKit's generic 500 "Internal Error"
 * and the loud, actionable message (CLAUDE.md §2, "...Run Stage again") is
 * lost. Every failure is therefore rethrown as an HttpError carrying its
 * message: a run that cannot be read as its build ({@link StagedRunError})
 * is a 409 the operator fixes by re-staging; a bucket I/O failure is a 502
 * from the upstream storage; missing bucket config is a 500.
 */

import { readStagedBuildFiles, readStagedObject, StagedRunError } from "@caelo-cms/admin-core";
import type { Bucket } from "@google-cloud/storage";
import { error, type RequestHandler } from "@sveltejs/kit";

/** The private staging bucket and the live static bucket of a GCP install. */
export interface StagingPreviewBuckets {
  readonly staging: Bucket;
  readonly live: Bucket;
}

let cachedBuckets: StagingPreviewBuckets | null = null;

/**
 * The install's real buckets, named by the Cloud Run env the GCP
 * provisioner sets. Throws when either name is missing (CLAUDE.md §2: no
 * fallback bucket).
 */
export async function gcsStagingPreviewBuckets(): Promise<StagingPreviewBuckets> {
  if (cachedBuckets) return cachedBuckets;
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
  cachedBuckets = {
    staging: storage.bucket(stagingBucketName),
    live: storage.bucket(staticBucketName),
  };
  return cachedBuckets;
}

/** A staged run's file list never changes; one read per run, last few kept. */
const BUILD_FILES_CACHE_RUNS = 8;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build the GET handler for the staging preview route.
 *
 * @param getBuckets resolves the staging + live buckets; throws when the
 *   install's bucket config is missing (answered as a 500 with the message).
 */
export function createStagingPreviewHandler(
  getBuckets: () => Promise<StagingPreviewBuckets>,
): RequestHandler<{ runId: string; rest: string }> {
  const buildFilesByRun = new Map<string, Promise<ReadonlySet<string>>>();

  function buildFilesOf(staging: Bucket, runId: string): Promise<ReadonlySet<string>> {
    let files = buildFilesByRun.get(runId);
    if (!files) {
      files = readStagedBuildFiles(staging, runId);
      // A failed read (run staged by an older release) is not cached, so a
      // re-Stage under a new runId is never shadowed and a retry re-reads.
      files.catch(() => buildFilesByRun.delete(runId));
      buildFilesByRun.set(runId, files);
      const oldest = buildFilesByRun.keys().next().value;
      if (buildFilesByRun.size > BUILD_FILES_CACHE_RUNS && oldest !== undefined) {
        buildFilesByRun.delete(oldest);
      }
    }
    return files;
  }

  return async ({ params }) => {
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

    let buckets: StagingPreviewBuckets;
    try {
      buckets = await getBuckets();
    } catch (e) {
      throw error(500, errorMessage(e));
    }
    let object: Awaited<ReturnType<typeof readStagedObject>>;
    try {
      object = await readStagedObject({
        staging: buckets.staging,
        live: buckets.live,
        runId,
        buildFiles: await buildFilesOf(buckets.staging, runId),
        key,
      });
    } catch (e) {
      if (e instanceof StagedRunError) throw error(409, e.message);
      throw error(
        502,
        `_staging-preview: reading ${key} of staged run ${runId} from GCS failed: ${errorMessage(e)}`,
      );
    }
    if (!object) throw error(404, `Not in staging build ${runId}: ${key}`);
    return new Response(new Uint8Array(object.body), {
      status: 200,
      headers: {
        "Content-Type": object.contentType ?? "application/octet-stream",
        // Don't let the operator's browser cache the staging preview —
        // they may re-Stage and want fresh bytes immediately.
        "Cache-Control": "private, no-cache, max-age=0, must-revalidate",
        // Staged pages carry no env-level noindex meta (the generator
        // renders them env-independently so promote can ship them
        // verbatim) — the serving layer marks staging non-indexable,
        // as the Caddy staging vhost does (CMS_REQUIREMENTS §16.5).
        "X-Robots-Tag": "noindex",
      },
    });
  };
}
