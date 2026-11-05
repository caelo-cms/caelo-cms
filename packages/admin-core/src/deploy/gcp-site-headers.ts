// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — the headers of the live build on the `gcp` provider.
 *
 * GCS serves only a fixed set of metadata headers, and a URL-map header
 * action on the site's path matcher would also reach `/api/*` (the gateway's
 * own headers must stay authoritative). The static backend bucket's custom
 * response headers reach exactly the bucket's files, which is what
 * nosniff already rides on (#891).
 *
 * The backend bucket is found through the URL map routing the site host: its
 * Pulumi name carries a suffix, and the admin is created before it (see
 * gcp-url-map-redirects.ts). Publish live and rollback call this after the
 * files are live, so for the few minutes the load balancer takes to apply the
 * list, the previous build's headers sit on the new files. That is why an
 * enforced CSP names `'self'` for page scripts instead of per-build hashes.
 *
 * Rights: `compute.backendBuckets.get` and `.update` in the
 * `caeloUrlMapRedirects` role (contract 23).
 */

import { gcpBackendBucketHeaders, type SiteHeaderSet } from "@caelo-cms/shared";
import type { GcpComputeApi, GcpOperation } from "./gcp-url-map-redirects.js";

/** A backend bucket as the Compute REST API returns it (fields we read). */
export interface GcpBackendBucket {
  readonly name: string;
  readonly customResponseHeaders?: readonly string[];
}

/** The calls beyond the URL-map applier's. */
export interface GcpBackendBucketApi extends Pick<GcpComputeApi, "listUrlMaps" | "waitOperation"> {
  getBackendBucket(name: string): Promise<GcpBackendBucket>;
  patchBackendBucket(
    name: string,
    body: { readonly customResponseHeaders: readonly string[] },
  ): Promise<GcpOperation>;
}

const OPERATION_DEADLINE_MS = 5 * 60_000;

async function siteBackendBucket(api: GcpBackendBucketApi, siteHost: string): Promise<string> {
  const maps = await api.listUrlMaps();
  const services = maps.flatMap((map) =>
    (map.hostRules ?? [])
      .filter((rule) => rule.hosts.includes(siteHost))
      .map((rule) => map.pathMatchers?.find((m) => m.name === rule.pathMatcher)?.defaultService)
      .map((service) => (typeof service === "string" ? service : "")),
  );
  const name = services.length === 1 ? services[0]?.match(/\/backendBuckets\/([^/]+)$/)?.[1] : null;
  if (!name) {
    throw new Error(
      `gcp-site-headers: no single static backend bucket serves ${siteHost} (URL maps name ${JSON.stringify(services)}), so the site's security headers cannot be set. Re-run the installer to restore the load balancer, then publish again.`,
    );
  }
  return name;
}

/**
 * Put `set` on the bucket serving `siteHost`. An unchanged list is not
 * written.
 *
 * @returns whether the list changed.
 */
export async function applyGcpSiteHeaders(args: {
  readonly set: SiteHeaderSet;
  readonly siteHost: string;
  readonly api: GcpBackendBucketApi;
  readonly now?: () => number;
}): Promise<boolean> {
  const now = args.now ?? Date.now;
  const name = await siteBackendBucket(args.api, args.siteHost);
  const wanted = gcpBackendBucketHeaders(args.set);
  const live = await args.api.getBackendBucket(name);
  if (JSON.stringify(live.customResponseHeaders ?? []) === JSON.stringify(wanted)) return false;
  let op = await args.api.patchBackendBucket(name, { customResponseHeaders: wanted });
  const deadline = now() + OPERATION_DEADLINE_MS;
  while (op.status !== "DONE") {
    if (now() > deadline) {
      throw new Error(
        `gcp-site-headers: the update ${op.name} of backend bucket ${name} did not finish within ${OPERATION_DEADLINE_MS / 60_000} minutes. It may still apply; check the load balancer's operations, then publish again.`,
      );
    }
    op = await args.api.waitOperation(op.name);
  }
  const errors = op.error?.errors ?? [];
  if (errors.length > 0) {
    throw new Error(
      `gcp-site-headers: updating backend bucket ${name} failed: ${errors.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ")}. The files are live with the previous headers; publish again once the cause is fixed.`,
    );
  }
  return true;
}
