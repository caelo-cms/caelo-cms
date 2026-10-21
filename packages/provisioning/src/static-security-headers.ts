// SPDX-License-Identifier: MPL-2.0

/**
 * #891 — the public site's security response headers at each provider's
 * Tier-1 edge (CLAUDE.md §11.B): every response `nosniff`, every SVG the
 * sandboxing CSP (`SVG_DOCUMENT_CSP`, @caelo-cms/shared). An uploaded SVG
 * opened directly is a document that runs script in the site's origin —
 * the origin that also serves `/api/*` through the same load balancer — so
 * the header must come from the edge that serves the file, not from page
 * HTML. `sanitizeSvg` at upload stays the first line; this is the second.
 *
 * The provider configs below are plain data the stacks pass to Pulumi
 * (imported from `dist/`, so this file stays free of provider SDKs), and
 * the unit tests pin them:
 *
 *   - AWS: CloudFront response headers policies — one with nosniff on every
 *     behavior, one adding the CSP on `*.svg` behaviors of both S3 origins.
 *   - Azure: a stack-owned Front Door rule set next to the deploy-owned
 *     redirects set — nosniff on every response, the CSP when the URL file
 *     extension is `svg`.
 *   - Self-hosted: the Caddyfile generator (caddy.ts).
 *   - Firebase Hosting: version-config headers the publisher writes
 *     (admin-core static-publisher-firebase.ts).
 *   - GCP (`gcp` stack): the static backend bucket's custom response header
 *     carries nosniff; the CSP cannot be attached per file on that load
 *     balancer (see `gcsObjectMetadata` in admin-core for why), so SVG
 *     objects are stored `Content-Disposition: attachment` instead and the
 *     converge backfills them (static-svg-gcp.ts).
 */

import { NOSNIFF, SVG_DOCUMENT_CSP } from "@caelo-cms/shared";

// ===========================================================================
// GCP — Cloud CDN backend bucket
// ===========================================================================

/**
 * `customResponseHeaders` of the `gcp` stack's static backend bucket, in
 * the `Name: value` form the Compute API and `gcloud compute backend-buckets
 * update --custom-response-header` take. The converge (stack-converge.ts)
 * brings existing installs to exactly this list.
 */
export const GCP_STATIC_RESPONSE_HEADERS: readonly string[] = [
  `X-Content-Type-Options: ${NOSNIFF}`,
];

// ===========================================================================
// AWS — CloudFront
// ===========================================================================

/** The two response headers policies the AWS stack attaches. */
export type CloudFrontHeadersPolicyKind = "site" | "svg";

/**
 * `aws.cloudfront.ResponseHeadersPolicy` arguments (minus `name`). `site`
 * goes on every cache behavior; `svg` on the `*.svg` behaviors
 * ({@link CLOUDFRONT_SVG_BEHAVIORS}). `override: true` so an origin header
 * can never weaken them.
 */
export function cloudFrontHeadersPolicy(kind: CloudFrontHeadersPolicyKind): {
  readonly comment: string;
  readonly securityHeadersConfig: {
    readonly contentTypeOptions: { readonly override: true };
    readonly contentSecurityPolicy?: {
      readonly contentSecurityPolicy: string;
      readonly override: true;
    };
  };
} {
  if (kind === "site") {
    return {
      comment: "Caelo static site: nosniff on every response (#891)",
      securityHeadersConfig: { contentTypeOptions: { override: true } },
    };
  }
  return {
    comment: "Caelo static site: sandboxing CSP on SVG documents (#891)",
    securityHeadersConfig: {
      contentTypeOptions: { override: true },
      contentSecurityPolicy: { contentSecurityPolicy: SVG_DOCUMENT_CSP, override: true },
    },
  };
}

/**
 * The SVG cache behaviors, in CloudFront precedence order (first match
 * wins): `/media/*.svg` must come before the generic `*.svg` (which would
 * route media SVGs to the static origin) and both before `/media/*`.
 * CloudFront path patterns are case-sensitive; the static generator writes
 * every media extension in lower case (media-asset-path.ts).
 */
export const CLOUDFRONT_SVG_BEHAVIORS: ReadonlyArray<{
  readonly pathPattern: string;
  readonly targetOriginId: "media" | "static";
}> = [
  { pathPattern: "/media/*.svg", targetOriginId: "media" },
  { pathPattern: "*.svg", targetOriginId: "static" },
];

// ===========================================================================
// Azure — Front Door rules engine
// ===========================================================================

/** Name of the stack-owned Front Door rule set (the redirects set is the deploy's). */
export const FRONT_DOOR_SECURITY_RULE_SET = "caeloSecurityHeaders";

/** One `ModifyResponseHeader` action that overwrites `headerName`. */
function overwriteResponseHeader(headerName: string, value: string) {
  return {
    name: "ModifyResponseHeader" as const,
    parameters: {
      typeName: "DeliveryRuleHeaderActionParameters" as const,
      headerAction: "Overwrite",
      headerName,
      value,
    },
  };
}

/**
 * The rules of {@link FRONT_DOOR_SECURITY_RULE_SET}, as `azure.cdn.Rule`
 * arguments (minus the resource group / profile / rule set the stack
 * fills in). A rule without conditions runs on every request; the SVG rule
 * matches the URL's file extension lower-cased, so `.SVG` is covered.
 * `Continue` lets both rules (and the redirects set) apply.
 */
export function frontDoorSecurityRules() {
  return [
    {
      ruleName: "nosniff",
      order: 1,
      matchProcessingBehavior: "Continue",
      actions: [overwriteResponseHeader("X-Content-Type-Options", NOSNIFF)],
    },
    {
      ruleName: "svgCsp",
      order: 2,
      matchProcessingBehavior: "Continue",
      conditions: [
        {
          name: "UrlFileExtension" as const,
          parameters: {
            typeName: "DeliveryRuleUrlFileExtensionMatchConditionParameters" as const,
            operator: "Equal",
            negateCondition: false,
            matchValues: ["svg"],
            transforms: ["Lowercase"],
          },
        },
      ],
      actions: [overwriteResponseHeader("Content-Security-Policy", SVG_DOCUMENT_CSP)],
    },
  ];
}
