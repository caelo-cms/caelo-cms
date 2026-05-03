// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo AWS Lambda@Edge handler — viewer-request event.
 *
 * Imports the SAME `routeRequest` from `@caelo-cms/edge-router` that the
 * P13 self-hosted Caddy gateway uses, so the assignment hash is
 * byte-identical across all four runtimes (P13 Caddy + GCP + AWS + Azure).
 * The byte-identity test in packages/edge-router/src/index.test.ts
 * locks the contract.
 *
 * Bundled by `bun run build:edge-aws` (see this stack's README) into
 * `edge-handler-bundle.js` which Pulumi uploads as the Lambda code.
 * The routing manifest is embedded into the bundle at build time —
 * Lambda@Edge has no DB access (no IAM, no network egress to RDS), so
 * a fresh bundle is built + deployed on every routing-manifest bump.
 */

import type { RoutingManifest } from "@caelo-cms/edge-router";
import { routeRequest } from "@caelo-cms/edge-router";

// Bundled at build time. The build script reads the latest
// routing-manifest.json from the static-output bucket and inlines it.
// Empty manifest = pass-through (no experiments active).
declare const __INLINE_MANIFEST__: RoutingManifest;

const MANIFEST: RoutingManifest = __INLINE_MANIFEST__;
const COOKIE_NAME = "caelo_visitor_id";

interface CloudFrontHeaderEntry {
  readonly key: string;
  readonly value: string;
}

interface CloudFrontRequest {
  uri: string;
  querystring: string;
  headers: Record<string, ReadonlyArray<CloudFrontHeaderEntry>>;
}

interface CloudFrontEvent {
  Records: Array<{ cf: { request: CloudFrontRequest } }>;
}

function readCookie(req: CloudFrontRequest, name: string): string | null {
  const raw = req.headers.cookie?.[0]?.value ?? "";
  for (const pair of raw.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}

export const handler = async (event: CloudFrontEvent): Promise<CloudFrontRequest> => {
  const req = event.Records[0]?.cf.request;
  if (!req) throw new Error("edge-handler: malformed event");

  const visitorIdCookie = readCookie(req, COOKIE_NAME);
  const decision = routeRequest(MANIFEST, {
    pathname: req.uri,
    visitorIdCookie,
  });

  // Path rewrite — Lambda@Edge mutates request.uri in-place.
  req.uri = decision.rewritePathname;

  // Set the cookie for the response. L@E viewer-request can't set
  // response headers directly; we have to rely on a complementary
  // viewer-response function, OR (simpler) include the cookie in the
  // forwarded request so the origin (S3 / ECS) can echo it. v1 takes
  // the simpler path: bake the visitor id into a custom header that
  // the static origin's Set-Cookie config picks up. CloudFront's
  // "function" tier supports response-header rewrites without a
  // second Lambda — that's the operator's setup step.
  req.headers["x-caelo-visitor-id"] = [{ key: "X-Caelo-Visitor-Id", value: decision.setVisitorId }];

  // Emit assignment log via console.log; CloudWatch picks it up,
  // Kinesis Firehose ships to S3, Athena queries it, P12A analytics
  // plugin's AWS adapter normalises into ab_assignment_aggregates.
  if (decision.logEntry) {
    // biome-ignore lint/suspicious/noConsole: structured log → CloudWatch
    console.log(JSON.stringify(decision.logEntry));
  }

  return req;
};
