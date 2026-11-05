// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #763 E11 — one shape for every provider: the three public services,
 * which edge sits in front of each, whether a WAF is part of it, and who
 * provisions it. Only the primitive differs per provider. aws and azure
 * host the shape once #749 / #750 land; until then they refuse honestly
 * (no service, or a service that answers the fixed 404).
 *
 * Two rules hold for every row (E14 a): a public service is always
 * provisioned at zero minimum instances (the gateway's minimum is the
 * operator's `gatewayMinInstances` knob, default 0), and while its feature
 * is off it answers a fixed 404 before it reads the request. No row needs
 * a WAF (E3): `cloud-armor` is an extra layer where the provider has one.
 *
 * public-service-shape.test.ts pins every stack, CLI setup module and the
 * Compose file to this table, and the GCP cost table to its billable rows.
 */

import type { SupportedProvider } from "./adapter.js";

/** The public services of an install (CLAUDE.md §11.B Tier 3 and the MCP-Auth-Proxy). */
export type PublicService = "gateway" | "staging-gateway" | "mcp-auth-proxy";

/** One provider's primitive for one public service. */
export interface PublicServiceShape {
  /**
   * Who creates it: the Pulumi stack, the CLI's setup module (named), the
   * self-hosted Compose file, or nobody yet (`refused`, with the issue).
   */
  readonly owner:
    | { readonly kind: "stack" }
    | { readonly kind: "cli"; readonly module: string }
    | { readonly kind: "compose"; readonly service: string }
    | { readonly kind: "refused"; readonly issue: string };
  /** What is in front of it on the public internet. */
  readonly edge: string;
  /** A WAF in front of it, as an extra layer only. */
  readonly waf: "cloud-armor" | "none";
}

/** The E11 table. */
export const PUBLIC_SERVICE_SHAPE: Readonly<
  Record<SupportedProvider, Readonly<Record<PublicService, PublicServiceShape>>>
> = {
  gcp: {
    gateway: {
      owner: { kind: "stack" },
      edge: "the site's load balancer: /api/* → serverless NEG → backend service",
      waf: "cloud-armor",
    },
    "staging-gateway": {
      owner: { kind: "cli", module: "staging-gateway-setup.ts" },
      edge: "the site's load balancer: the staging host's rule → its own backend service",
      waf: "cloud-armor",
    },
    "mcp-auth-proxy": {
      owner: { kind: "cli", module: "mcp-auth-proxy-setup.ts" },
      edge: "the site's load balancer: the MCP paths → its own backend service",
      waf: "cloud-armor",
    },
  },
  "gcp-firebase": {
    gateway: {
      owner: { kind: "stack" },
      edge: "Firebase Hosting rewrite of /api/**, and its run.app URL",
      waf: "none",
    },
    "staging-gateway": {
      owner: { kind: "cli", module: "staging-gateway-setup.ts" },
      edge: "a second Firebase Hosting site's ** rewrite, and its run.app URL",
      waf: "none",
    },
    "mcp-auth-proxy": {
      owner: { kind: "stack" },
      edge: "its own run.app URL",
      waf: "none",
    },
  },
  "self-hosted": {
    gateway: {
      owner: { kind: "compose", service: "caelo-gateway" },
      edge: "Caddy: /api/* on the site's host",
      waf: "none",
    },
    "staging-gateway": {
      owner: { kind: "compose", service: "caelo-staging-gateway" },
      edge: "Caddy: every path of the staging host",
      waf: "none",
    },
    "mcp-auth-proxy": {
      owner: { kind: "compose", service: "caelo-mcp-auth-proxy" },
      edge: "none until remote MCP is available on self-hosted (fixed 404 on the Compose network)",
      waf: "none",
    },
  },
  aws: {
    gateway: {
      owner: { kind: "refused", issue: "#749" },
      edge: "CloudFront → ALB → Fargate, with #749",
      waf: "none",
    },
    "staging-gateway": {
      owner: { kind: "refused", issue: "#749" },
      edge: "with #749",
      waf: "none",
    },
    "mcp-auth-proxy": {
      owner: { kind: "refused", issue: "#749" },
      edge: "its own origin, with #749",
      waf: "none",
    },
  },
  azure: {
    gateway: {
      owner: { kind: "stack" },
      edge: "Front Door route to its Container App, with #750",
      waf: "none",
    },
    "staging-gateway": {
      owner: { kind: "refused", issue: "#750" },
      edge: "with #750",
      waf: "none",
    },
    "mcp-auth-proxy": {
      owner: { kind: "stack" },
      edge: "its own Container App FQDN (fixed 404: remote MCP needs Google IAP)",
      waf: "none",
    },
  },
};
