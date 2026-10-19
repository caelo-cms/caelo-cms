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
 * every unchanged asset. Only files the staged build contains fall
 * back (#842): a page the build deleted is still live until
 * Confirm-publish prunes it, and must 404 here like it will live.
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
 *
 * The request handling (incl. mapping failures to HTTP errors that keep
 * their message) lives in `#lib/server/staging-preview.ts`; this file only
 * wires in the real GCS buckets.
 */

import {
  createStagingPreviewHandler,
  gcsStagingPreviewBuckets,
} from "#lib/server/staging-preview.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = createStagingPreviewHandler(gcsStagingPreviewBuckets);
