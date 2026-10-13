// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — generic edge-router request handler. The provider-specific
 * shims (gcp.ts, aws.ts, azure.ts) wrap this in their respective
 * runtime contracts (Cloud Run handler, Lambda@Edge handler, Front
 * Door rules engine), but the routing decision itself is identical.
 *
 * One function. Three runtimes. Same hash → same variant → same path
 * rewrite, every time.
 *
 * ## Consent first (#674)
 *
 * The visitor id is only ever minted, set or logged for a request that
 * is actually bucketed, and a request is only bucketed when the
 * visitor's consent cookie grants the manifest's consent rule. Every
 * other request — an asset, a page without an experiment, a visitor who
 * has not agreed — passes through untouched and gets no cookie. A
 * visitor who withdrew consent but still carries the id is told to drop
 * it (`clearVisitorId`).
 */

import { assignVariant, buildAssignmentLog, mintVisitorId } from "./assignment.js";
import { consentGranted } from "./consent.js";
import { findExperimentForUrl, type RoutingManifest } from "./manifest.js";

export interface EdgeRequestSummary {
  /** URL pathname only (e.g. "/about"). Query string ignored for routing. */
  readonly pathname: string;
  /** The current request's `caelo_visitor_id` cookie value, if any. */
  readonly visitorIdCookie: string | null;
  /**
   * The decoded value of the consent cookie the manifest's `consent.cookie`
   * names, or null when absent. Read it with `readCookie(header,
   * manifest.consent.cookie)`.
   */
  readonly consentCookie: string | null;
}

export interface EdgeRouteDecision {
  /** Final pathname the runtime should serve (control or variant). */
  readonly rewritePathname: string;
  /**
   * Visitor id the runtime should set as `caelo_visitor_id`, or null to
   * set nothing. Non-null only for a consented, bucketed request.
   */
  readonly setVisitorId: string | null;
  /**
   * True when an experiment request carries a visitor id the visitor has
   * not (or no longer) agreed to: the runtime expires the cookie.
   */
  readonly clearVisitorId: boolean;
  /**
   * Assignment-log payload to emit through the runtime's logger.
   * Null when the request was not bucketed — runtime should NOT emit
   * anything in that case (no consent, or no experiment on this URL).
   */
  readonly logEntry: ReturnType<typeof buildAssignmentLog> | null;
}

export function routeRequest(
  manifest: RoutingManifest,
  req: EdgeRequestSummary,
): EdgeRouteDecision {
  const experiment = findExperimentForUrl(manifest, req.pathname);
  const consented =
    manifest.consent !== undefined && consentGranted(manifest.consent, req.consentCookie);
  if (!experiment || !consented) {
    return {
      rewritePathname: req.pathname,
      setVisitorId: null,
      // Only an experiment request decides about the id: a page outside
      // any experiment (or an asset) has no reason to touch it.
      clearVisitorId: experiment !== null && req.visitorIdCookie !== null,
      logEntry: null,
    };
  }
  const visitorId = req.visitorIdCookie ?? mintVisitorId();
  const variant = assignVariant({
    visitorId,
    manifestVersion: manifest.manifestVersion,
    experiment,
  });
  return {
    rewritePathname: variant.path,
    setVisitorId: visitorId,
    clearVisitorId: false,
    logEntry: buildAssignmentLog({
      experimentId: experiment.experimentId,
      variant,
      visitorId,
      manifestVersion: manifest.manifestVersion,
    }),
  };
}
