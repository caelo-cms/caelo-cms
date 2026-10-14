// SPDX-License-Identifier: MPL-2.0

/**
 * Put a redirect plan live on the `gcp` provider's load balancer (#587).
 *
 * The site host's path matcher in the URL map gets one `urlRedirect` path
 * rule per planned redirect (redirect-emit-gcp.ts in @caelo-cms/shared has
 * the shape, the quota and why URL-map rules). Confirm-publish and rollback
 * call {@link applyGcpRedirectPlan} after the files are live.
 *
 * The URL map is found by the site host rather than by name: the stack's
 * URL map name carries a Pulumi suffix, and the admin service is created
 * before the load balancer, so the name cannot be handed to it as env.
 * Exactly one URL map must route the host; anything else fails loudly.
 *
 * The update is a read-modify-write guarded by the URL map's fingerprint
 * (a concurrent change makes the PUT fail instead of being overwritten),
 * then waits for the global operation. An unchanged rule set is not
 * written at all.
 *
 * Rights: the admin's run SA holds the stack's `caeloUrlMapRedirects`
 * custom role (stacks/gcp/index.ts; `cms-provision upgrade` ensures it on
 * older installs).
 */

import {
  type GcpPathMatcher,
  type GcpPathRule,
  isGcpRedirectRule,
  type RedirectPlan,
  withGcpRedirects,
} from "@caelo-cms/shared";

/** A URL map as the Compute REST API returns it (fields we read). */
export interface GcpUrlMap {
  readonly name: string;
  readonly fingerprint?: string;
  readonly hostRules?: readonly {
    readonly hosts: readonly string[];
    readonly pathMatcher: string;
  }[];
  readonly pathMatchers?: readonly GcpPathMatcher[];
  readonly [key: string]: unknown;
}

/** A Compute global operation (fields we read). */
export interface GcpOperation {
  readonly name: string;
  readonly status: "PENDING" | "RUNNING" | "DONE";
  readonly error?: {
    readonly errors?: readonly { readonly code?: string; readonly message?: string }[];
  };
}

/** The three Compute calls the applier needs (injectable for tests). */
export interface GcpComputeApi {
  listUrlMaps(): Promise<GcpUrlMap[]>;
  updateUrlMap(name: string, body: GcpUrlMap): Promise<GcpOperation>;
  waitOperation(name: string): Promise<GcpOperation>;
}

/** What {@link applyGcpRedirectPlan} did. */
export interface GcpRedirectApplyResult {
  readonly urlMap: string;
  readonly pathMatcher: string;
  readonly redirectRules: number;
  readonly changed: boolean;
}

/** How long to wait for the URL-map update to finish. */
const OPERATION_DEADLINE_MS = 5 * 60_000;

/**
 * Replace the redirect rules of the URL map routing `siteHost` with the
 * plan's. Throws `GcpUrlMapBudgetError` (nothing changed) when the plan
 * does not fit the quota.
 */
export async function applyGcpRedirectPlan(args: {
  readonly plan: RedirectPlan;
  readonly siteHost: string;
  readonly api: GcpComputeApi;
  readonly now?: () => number;
}): Promise<GcpRedirectApplyResult> {
  const now = args.now ?? Date.now;
  const maps = await args.api.listUrlMaps();
  const routing = maps.flatMap((m) =>
    (m.hostRules ?? [])
      .filter((h) => h.hosts.includes(args.siteHost))
      .map((h) => ({ map: m, pathMatcher: h.pathMatcher })),
  );
  if (routing.length !== 1) {
    throw new Error(
      routing.length === 0
        ? `gcp-url-map-redirects: no URL map in this project routes ${args.siteHost}, so its redirects cannot be served. The load balancer the gcp stack creates routes the site's domain (CAELO_SITE_URL); re-run the installer to restore it, then publish again.`
        : `gcp-url-map-redirects: ${routing.length} URL maps route ${args.siteHost} (${routing.map((r) => r.map.name).join(", ")}); cannot tell which one serves the site. Remove the extra one, then publish again.`,
    );
  }
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const { map, pathMatcher } = routing[0]!;
  const matchers = map.pathMatchers ?? [];
  const current = matchers.find((m) => m.name === pathMatcher);
  if (!current) {
    throw new Error(
      `gcp-url-map-redirects: URL map ${map.name} routes ${args.siteHost} to path matcher ${JSON.stringify(pathMatcher)}, which it does not define. Re-run the installer to restore the load balancer, then publish again.`,
    );
  }
  const next = withGcpRedirects(current, args.plan);
  const redirectRules = (next.pathRules ?? []).filter(isGcpRedirectRule).length;
  if (sameRules(current.pathRules ?? [], next.pathRules ?? [])) {
    return { urlMap: map.name, pathMatcher, redirectRules, changed: false };
  }
  const body: GcpUrlMap = {
    ...map,
    pathMatchers: matchers.map((m) => (m.name === pathMatcher ? next : m)),
  };
  let op = await args.api.updateUrlMap(map.name, body);
  const deadline = now() + OPERATION_DEADLINE_MS;
  while (op.status !== "DONE") {
    if (now() > deadline) {
      throw new Error(
        `gcp-url-map-redirects: the URL-map update ${op.name} did not finish within ${OPERATION_DEADLINE_MS / 60_000} minutes. It may still apply; check the load balancer's operations, then publish again.`,
      );
    }
    op = await args.api.waitOperation(op.name);
  }
  const errors = op.error?.errors ?? [];
  if (errors.length > 0) {
    throw new Error(
      `gcp-url-map-redirects: the URL-map update failed: ${errors.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ")}. The live redirects are unchanged; publish again once the cause is fixed.`,
    );
  }
  return { urlMap: map.name, pathMatcher, redirectRules, changed: true };
}

function sameRules(a: readonly GcpPathRule[], b: readonly GcpPathRule[]): boolean {
  return JSON.stringify(a.map(canonical)) === JSON.stringify(b.map(canonical));
}

/** The fields that decide routing, in a fixed key order (the API may
 *  return extra defaults on read, e.g. `httpsRedirect: false`). */
function canonical(rule: GcpPathRule): unknown {
  return {
    paths: rule.paths,
    service: rule.service ?? null,
    urlRedirect: rule.urlRedirect
      ? {
          pathRedirect: rule.urlRedirect.pathRedirect ?? null,
          redirectResponseCode: rule.urlRedirect.redirectResponseCode ?? null,
          stripQuery: rule.urlRedirect.stripQuery ?? false,
        }
      : null,
  };
}

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";

/**
 * The Compute REST API as the admin's run SA (ADC), for the project ADC
 * resolves to — the install's project on Cloud Run.
 */
export async function adcComputeApi(): Promise<GcpComputeApi> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/compute"] });
  const project = await auth.getProjectId();
  const client = await auth.getClient();
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const token = (await client.getAccessToken()).token;
    if (!token) throw new Error("gcp-url-map-redirects: failed to obtain an ADC access token");
    const res = await fetch(`${COMPUTE_API}/projects/${project}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 2000);
      const hint =
        res.status === 403
          ? " The admin's service account lacks the caeloUrlMapRedirects role; run `cms-provision upgrade` (it grants it), then publish again."
          : "";
      throw new Error(
        `gcp-url-map-redirects: ${method} ${path} → HTTP ${res.status}: ${detail}.${hint}`,
      );
    }
    return (await res.json()) as T;
  };
  return {
    async listUrlMaps() {
      const out: GcpUrlMap[] = [];
      let pageToken: string | undefined;
      do {
        const page = await call<{ items?: GcpUrlMap[]; nextPageToken?: string }>(
          "GET",
          `global/urlMaps${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        );
        out.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
    updateUrlMap: (name, body) =>
      call<GcpOperation>("PUT", `global/urlMaps/${encodeURIComponent(name)}`, body),
    waitOperation: (name) =>
      call<GcpOperation>("POST", `global/operations/${encodeURIComponent(name)}/wait`),
  };
}
