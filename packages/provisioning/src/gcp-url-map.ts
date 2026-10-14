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
 * that read-modify-write needs (`URL_MAP_REDIRECTS_PERMISSIONS`, gcp-names.ts).
 *
 * Imported by the stack from `dist/`; keep it free of CLI dependencies.
 */

import { GCP_PUBLIC_BASE_PATHS } from "@caelo-cms/shared";
import * as gcp from "@pulumi/gcp";
import type * as pulumi from "@pulumi/pulumi";

/** Name of the site host's path matcher. */
export const PUBLIC_PATH_MATCHER = "public";

/**
 * The URL map's `ignoreChanges`: the public path matcher (index 0, see
 * {@link siteUrlMapArgs}) holds the admin-managed redirect rules.
 */
export const SITE_URL_MAP_IGNORE_CHANGES: readonly string[] = ["pathMatchers[0].pathRules"];

/** Inputs of {@link siteUrlMapArgs}. */
export interface SiteUrlMapInputs {
  readonly domain: string;
  readonly adminDomain: string;
  readonly staticBackend: pulumi.Input<string>;
  readonly gatewayBackend: pulumi.Input<string>;
  readonly adminBackend: pulumi.Input<string>;
}

/**
 * The URL map's arguments: the site host to the static bucket with `/api/*`
 * to the gateway; the admin host to the IAP-gated admin. The public path
 * matcher comes first — {@link SITE_URL_MAP_IGNORE_CHANGES} addresses it by
 * index.
 */
export function siteUrlMapArgs(i: SiteUrlMapInputs): gcp.compute.URLMapArgs {
  return {
    defaultService: i.staticBackend,
    hostRules: [
      { hosts: [i.domain], pathMatcher: PUBLIC_PATH_MATCHER },
      { hosts: [i.adminDomain], pathMatcher: "admin" },
    ],
    pathMatchers: [
      {
        name: PUBLIC_PATH_MATCHER,
        defaultService: i.staticBackend,
        pathRules: [{ paths: [...GCP_PUBLIC_BASE_PATHS], service: i.gatewayBackend }],
      },
      {
        name: "admin",
        defaultService: i.adminBackend,
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
