// SPDX-License-Identifier: MPL-2.0

/**
 * The `gcp` stack's URL map, and who may write its redirect rules (#587).
 *
 * The admin writes the redirects table into the site host's path matcher
 * as `urlRedirect` path rules on every Confirm-publish (admin-core
 * deploy/gcp-url-map-redirects.ts). Those rules change at runtime, not with
 * `pulumi up`, so the stack must not own them: the URL map ignores changes
 * to the public path matcher's `pathRules` after creation. Otherwise a
 * `pulumi refresh` + `up` would wipe every redirect until the next publish.
 * The admin's writer keeps every non-redirect rule (`/api/*`) as it finds
 * it.
 *
 * The admin's run SA gets a project custom role with only the permissions
 * that read-modify-write needs (`URL_MAP_REDIRECTS_PERMISSIONS`, gcp-names.ts);
 * the CLI creates it (url-map-redirects-access.ts), not the stack.
 *
 * Imported by the stack from `dist/`; keep it free of CLI dependencies.
 */

import { GCP_GATEWAY_PATHS } from "@caelo-cms/shared";
import * as gcp from "@pulumi/gcp";
import type * as pulumi from "@pulumi/pulumi";

/** Name of the site host's path matcher. */
export const PUBLIC_PATH_MATCHER = "public";

/** #1330 — name of the staging host's path matcher (gcp-names.ts stagingGatewayEdgeNames). */
export const STAGING_PATH_MATCHER = "staging";

/**
 * The URL map's `ignoreChanges`: the public path matcher (index 0, see
 * {@link siteUrlMapArgs}) holds the admin-managed redirect rules, and the
 * staging matcher's (index 2) target is the CLI's: the stack creates it as a
 * redirect, and staging-gateway-setup.ts ensureStagingGatewayEdge (#1330)
 * replaces that with the staging gateway's backend once it exists.
 */
export const SITE_URL_MAP_IGNORE_CHANGES: readonly string[] = [
  "pathMatchers[0].pathRules",
  "pathMatchers[2].defaultService",
  "pathMatchers[2].defaultUrlRedirect",
];

/** Inputs of {@link siteUrlMapArgs}. */
export interface SiteUrlMapInputs {
  readonly domain: string;
  readonly adminDomain: string;
  /** #1330 — the protected staging site's host. */
  readonly stagingHost: string;
  readonly staticBackend: pulumi.Input<string>;
  readonly gatewayBackend: pulumi.Input<string>;
  readonly adminBackend: pulumi.Input<string>;
}

/**
 * The URL map's arguments: the site host to the static bucket with `/api/*`
 * to the gateway; the admin host to the IAP-gated admin; (#1330) the staging
 * host, every path, to the staging gateway. The public path matcher comes
 * first and the staging one third — {@link SITE_URL_MAP_IGNORE_CHANGES}
 * addresses them by index.
 *
 * The staging matcher fails closed until the staging gateway's backend
 * exists (it is the CLI's, created after the first `up`): it serves nothing
 * at all, it redirects every staging request to the live site's home page.
 * Never a backend — above all never the static bucket — so a failed edge
 * step can never show a file on the staging host. The CLI then routes it to
 * the staging gateway, and the stack leaves it there.
 */
export function siteUrlMapArgs(i: SiteUrlMapInputs): gcp.compute.URLMapArgs {
  return {
    defaultService: i.staticBackend,
    hostRules: [
      { hosts: [i.domain], pathMatcher: PUBLIC_PATH_MATCHER },
      { hosts: [i.adminDomain], pathMatcher: "admin" },
      { hosts: [i.stagingHost], pathMatcher: STAGING_PATH_MATCHER },
    ],
    pathMatchers: [
      {
        name: PUBLIC_PATH_MATCHER,
        defaultService: i.staticBackend,
        // #1328 — the MCP-Auth-Proxy's rule (GCP_MCP_AUTH_PROXY_PATHS) is the
        // CLI's: it creates the proxy's backend after the first `up`
        // (remote-mcp.ts ensureRemoteMcpEdge), and the stack ignores
        // `pathRules` after creation anyway.
        pathRules: [{ paths: [...GCP_GATEWAY_PATHS], service: i.gatewayBackend }],
      },
      {
        name: "admin",
        defaultService: i.adminBackend,
      },
      {
        name: STAGING_PATH_MATCHER,
        defaultUrlRedirect: {
          hostRedirect: i.domain,
          pathRedirect: "/",
          httpsRedirect: true,
          redirectResponseCode: "FOUND",
          stripQuery: true,
        },
      },
    ],
  };
}

/** The stack's URL map (see the module comment for the ignored field). */
export function createSiteUrlMap(
  name: string,
  inputs: SiteUrlMapInputs,
  opts: pulumi.CustomResourceOptions,
): gcp.compute.URLMap {
  return new gcp.compute.URLMap(name, siteUrlMapArgs(inputs), {
    ...opts,
    ignoreChanges: [...(opts.ignoreChanges ?? []), ...SITE_URL_MAP_IGNORE_CHANGES],
  });
}
