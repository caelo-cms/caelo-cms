// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/edge-router — P15.
 *
 * Provider-agnostic edge-routing logic for A/B experiments. The same
 * hash → same variant → same rewrite path holds across self-hosted
 * (P13 Caddy gateway) + GCP + AWS + Azure. Provider-specific shims
 * land in `packages/provisioning/stacks/<provider>/edge-handler.ts`
 * and import this package's `routeRequest` for the actual decision.
 */

export {
  type AssignmentLogEntry,
  assignVariant,
  buildAssignmentLog,
  fnv1a32,
  mintVisitorId,
} from "./assignment.js";
export {
  EMPTY_MANIFEST,
  findExperimentForUrl,
  type ManifestExperiment,
  type ManifestVariant,
  type RoutingManifest,
  validateManifest,
} from "./manifest.js";
export { type EdgeRequestSummary, type EdgeRouteDecision, routeRequest } from "./router.js";
