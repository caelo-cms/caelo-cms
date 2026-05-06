// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo Azure edge-router — Azure Container App HTTP handler.
 *
 * Imports the SAME `routeRequest` from `@caelo-cms/edge-router` that the
 * P13 self-hosted Caddy gateway, the AWS Lambda@Edge function, and the
 * GCP Cloud Run handler use. The byte-identity test in
 * packages/edge-router/src/index.test.ts asserts identical variant
 * labels across every runtime — same hash, same variant, every visitor.
 *
 * Differences from the GCP Cloud Run handler:
 *   - Logs go to stdout in JSON; Container Apps' Log Analytics integration
 *     ships them to the workspace; the P12A Azure adapter queries via
 *     Azure Monitor's Log Analytics API.
 *   - Manifest fetched from Blob storage (anonymous public read on the
 *     `$web` container's `ab-routing.json` blob).
 *
 * v1 ships the source; the build pipeline (`az acr build` per service,
 * pushing to ACR) lands in P17.0 release engineering.
 */

import { EMPTY_MANIFEST, type RoutingManifest, routeRequest } from "@caelo-cms/edge-router";

const STATIC_BUCKET_URL = process.env.STATIC_BUCKET_URL ?? "";
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
  if (!STATIC_BUCKET_URL) return EMPTY_MANIFEST;
  try {
    const url = `${STATIC_BUCKET_URL}/${MANIFEST_OBJECT}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return manifestCache.value;
    const m = (await r.json()) as RoutingManifest;
    manifestCache = { value: m, loadedAt: Date.now() };
    return m;
  } catch {
    return manifestCache.value;
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}

const port = Number(process.env.PORT ?? 8080);
Bun.serve({
  port,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const manifest = await fetchManifest();
    const visitorIdCookie = readCookie(req.headers.get("cookie"), COOKIE_NAME);
    const decision = routeRequest(manifest, {
      pathname: url.pathname,
      visitorIdCookie,
    });

    if (decision.logEntry) {
      console.log(JSON.stringify(decision.logEntry));
    }

    const target = new URL(url.toString());
    target.pathname = decision.rewritePathname;
    const headers = new Headers({
      Location: target.toString(),
      "Cache-Control": "no-store, private",
      "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(decision.setVisitorId)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`,
    });
    return new Response(null, { status: 307, headers });
  },
});
