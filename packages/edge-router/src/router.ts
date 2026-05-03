// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — generic edge-router request handler. The provider-specific
 * shims (gcp.ts, aws.ts, azure.ts) wrap this in their respective
 * runtime contracts (Cloud Run handler, Lambda@Edge handler, Front
 * Door rules engine), but the routing decision itself is identical.
 *
 * One function. Three runtimes. Same hash → same variant → same path
 * rewrite, every time.
 */

import { assignVariant, buildAssignmentLog, mintVisitorId } from "./assignment.js";
import { findExperimentForUrl, type RoutingManifest } from "./manifest.js";

export interface EdgeRequestSummary {
  /** URL pathname only (e.g. "/about"). Query string ignored for routing. */
  readonly pathname: string;
  /** The current request's `caelo_visitor_id` cookie value, if any. */
  readonly visitorIdCookie: string | null;
}

export interface EdgeRouteDecision {
  /** Final pathname the runtime should serve (control or variant). */
  readonly rewritePathname: string;
  /** Visitor id the runtime should set as `caelo_visitor_id` (mint when absent). */
  readonly setVisitorId: string;
  /**
   * Assignment-log payload to emit through the runtime's logger.
   * Null when the request didn't match any experiment — runtime should
   * NOT emit anything in that case (avoids log spam on every static asset).
   */
  readonly logEntry: ReturnType<typeof buildAssignmentLog> | null;
}

export function routeRequest(
  manifest: RoutingManifest,
  req: EdgeRequestSummary,
): EdgeRouteDecision {
  const visitorId = req.visitorIdCookie ?? mintVisitorId();
  const experiment = findExperimentForUrl(manifest, req.pathname);
  if (!experiment) {
    return {
      rewritePathname: req.pathname,
      setVisitorId: visitorId,
      logEntry: null,
    };
  }
  const variant = assignVariant({
    visitorId,
    manifestVersion: manifest.manifestVersion,
    experiment,
  });
  return {
    rewritePathname: variant.path,
    setVisitorId: visitorId,
    logEntry: buildAssignmentLog({
      experimentId: experiment.experimentId,
      variant,
      visitorId,
      manifestVersion: manifest.manifestVersion,
    }),
  };
}
