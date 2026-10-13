// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo GCP edge-router — Cloud Run HTTP handler.
 *
 * Imports the SAME `routeRequest` from `@caelo-cms/edge-router` that the
 * P13 self-hosted Caddy gateway, the AWS Lambda@Edge function, and the
 * future Azure Front Door rules engine use. The byte-identity test in
 * packages/edge-router/src/index.test.ts asserts a fixed corpus of
 * (visitorId, manifestVersion, experimentId) tuples produces identical
 * variant labels across every runtime.
 *
 * Differences from AWS L@E:
 *  - Cloud Run has full network egress (we fetch the manifest from GCS
 *    on a TTL-cached schedule rather than bundling at deploy time).
 *  - Cloud Run can set response headers directly (no companion handler).
 *  - Logs flow via `console.log(JSON.stringify(...))` to Cloud Logging,
 *    where the project sink filters `jsonPayload.kind="ab_assignment"`
 *    and ships to BigQuery.
 *
 * This file is meant to be the entry of a Cloud Run container; the
 * operator's image build step (`gcloud builds submit`) bundles it
 * together with the static-output bucket as the upstream for non-API
 * routes. v1 ships the source; the build pipeline lands in P15
 * review-pass.
 */

import {
  EMPTY_MANIFEST,
  type RoutingManifest,
  readCookie,
  routeRequest,
} from "@caelo-cms/edge-router";

const STATIC_BUCKET = process.env.STATIC_BUCKET ?? "";
// P15 hot-fix #1 — distinct filename from the deploy manifest. The
// static-generator writes `routing-manifest.json` (deploy provenance)
// AND `ab-routing.json` (edge-router shape — RoutingManifest).
const MANIFEST_OBJECT = process.env.MANIFEST_OBJECT ?? "ab-routing.json";
const MANIFEST_REFRESH_MS = 30_000;
const COOKIE_NAME = "caelo_visitor_id";

let manifestCache: { value: RoutingManifest; loadedAt: number } = {
  value: EMPTY_MANIFEST,
  loadedAt: 0,
};

async function fetchManifest(): Promise<RoutingManifest> {
  if (Date.now() - manifestCache.loadedAt < MANIFEST_REFRESH_MS) {
    return manifestCache.value;
  }
  if (!STATIC_BUCKET) return EMPTY_MANIFEST;
  try {
    const url = `https://storage.googleapis.com/${STATIC_BUCKET}/${MANIFEST_OBJECT}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return manifestCache.value; // keep stale on transient failure
    const m = (await r.json()) as RoutingManifest;
    manifestCache = { value: m, loadedAt: Date.now() };
    return m;
  } catch {
    return manifestCache.value;
  }
}

/**
 * Cloud Run HTTP handler. Cloud Run accepts any web framework with a
 * standard fetch-style handler; v1 uses Bun's native server for
 * portability with the rest of the Caelo runtime.
 */
const port = Number(process.env.PORT ?? 8080);
Bun.serve({
  port,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const manifest = await fetchManifest();
    const cookieHeader = req.headers.get("cookie");
    // #674 — bucketing needs the visitor's consent; the manifest names the
    // consent cookie (absent rule = nobody is bucketed).
    const decision = routeRequest(manifest, {
      pathname: url.pathname,
      visitorIdCookie: readCookie(cookieHeader, COOKIE_NAME),
      consentCookie: manifest.consent ? readCookie(cookieHeader, manifest.consent.cookie) : null,
    });

    if (decision.logEntry) {
      console.log(JSON.stringify(decision.logEntry));
    }

    // Edge-router's job is to redirect; the static origin (GCS bucket)
    // serves the rewritten path. 307 keeps method semantics intact (a
    // non-GET hitting an experiment page would otherwise lose its body).
    const target = new URL(url.toString());
    target.pathname = decision.rewritePathname;
    const headers = new Headers({
      Location: target.toString(),
      "Cache-Control": "no-store, private",
    });
    // Only a consented, bucketed request sets the id (long max-age so the
    // assignment persists across the experiment); a visitor who withdrew
    // consent has it expired instead of renewed.
    if (decision.setVisitorId) {
      headers.set(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(decision.setVisitorId)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`,
      );
    } else if (decision.clearVisitorId) {
      headers.set(
        "Set-Cookie",
        `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`,
      );
    }
    return new Response(null, { status: 307, headers });
  },
});
