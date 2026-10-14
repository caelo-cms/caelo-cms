// SPDX-License-Identifier: MPL-2.0

/**
 * The redirect plan as GCP URL-map path rules (provider `gcp`: GCS backend
 * bucket behind the global external Application Load Balancer, #587).
 *
 * Why URL-map rules: the load balancer answers a `urlRedirect` path rule
 * itself, at the edge, before the backend bucket is asked — no compute on
 * the static request path (CLAUDE.md §11.B Tier 1). The alternatives do not
 * exist on this stack: GCS has no per-object redirects, and the URL map's
 * custom error responses can only point at a backend bucket, so a bucket
 * 404 cannot be handed to the gateway for a `redirects.lookup`.
 *
 * Limits (https://cloud.google.com/load-balancing/docs/quotas, "URL maps",
 * fixed — they cannot be raised): per path matcher at most 1,000 path
 * rules and 1,000 predicates, where every path of a path rule is one
 * predicate. Every host has exactly one path matcher, so the site host's
 * redirects share that budget with its own routing rules (`/api/*`). A plan
 * that does not fit is refused with {@link GcpUrlMapBudgetError} BEFORE
 * anything changes — the load balancer keeps the previous rules, and the
 * error names the counts and the ways out. Dropping redirects silently
 * would turn linked URLs into 404s without anyone noticing. Going past the
 * quota is tracked in #751.
 *
 * Rules this module owns are recognised by their `urlRedirect` (the stack's
 * own rules route to a service), so re-applying a plan replaces exactly the
 * previous plan's rules and keeps everything else in the path matcher.
 */

import type { PlannedRedirect, RedirectPlan, RedirectStatusCode } from "./redirect-plan.js";

/** Path rules per path matcher (URL map quota, global external ALB). */
export const GCP_URL_MAP_MAX_PATH_RULES = 1000;
/** Predicates (paths across all path rules) per path matcher. */
export const GCP_URL_MAP_MAX_PREDICATES = 1000;

/** `urlRedirect.redirectResponseCode` per stored status. */
const RESPONSE_CODE: Record<RedirectStatusCode, GcpRedirectResponseCode> = {
  301: "MOVED_PERMANENTLY_DEFAULT",
  302: "FOUND",
  307: "TEMPORARY_REDIRECT",
  308: "PERMANENT_REDIRECT",
};

export type GcpRedirectResponseCode =
  | "MOVED_PERMANENTLY_DEFAULT"
  | "FOUND"
  | "SEE_OTHER"
  | "TEMPORARY_REDIRECT"
  | "PERMANENT_REDIRECT";

/** A path rule of a URL map path matcher (Compute REST shape). */
export interface GcpPathRule {
  readonly paths: readonly string[];
  readonly service?: string;
  readonly urlRedirect?: {
    readonly pathRedirect?: string;
    readonly redirectResponseCode?: GcpRedirectResponseCode;
    readonly stripQuery?: boolean;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/** A URL map path matcher (Compute REST shape; other fields kept as-is). */
export interface GcpPathMatcher {
  readonly name: string;
  readonly pathRules?: readonly GcpPathRule[];
  readonly routeRules?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** The plan does not fit the path matcher's quota; nothing was changed. */
export class GcpUrlMapBudgetError extends Error {
  constructor(
    readonly redirectCount: number,
    readonly predicatesNeeded: number,
    readonly rulesNeeded: number,
  ) {
    super(
      `The GCP load balancer serves at most ${GCP_URL_MAP_MAX_PREDICATES} redirect paths and ${GCP_URL_MAP_MAX_PATH_RULES} rules per site (a fixed URL-map quota); this site's ${redirectCount} redirect(s) need ${predicatesNeeded} paths and ${rulesNeeded} rules, counting the site's own routing. Nothing was published and the live redirects are unchanged. Next step: delete redirects nobody links to any more (find_redirects lists them, bulk_delete_redirects removes them) — every redirect whose old URL ends in '/' or not costs two paths, a file-like one ('/old.html') costs one — then publish again. Serving larger redirect sets on this provider is tracked in https://github.com/caelo-cms/caelo-cms/issues/751.`,
    );
    this.name = "GcpUrlMapBudgetError";
  }
}

/**
 * One `urlRedirect` path rule per planned redirect. 410 entries have no
 * URL-map equivalent and answer the bucket's 404.
 *
 * @throws when a planned redirect cannot be expressed as a URL-map rule
 *         (a `*` in the from path would turn it into a wildcard; a target
 *         with a query or fragment cannot be a `pathRedirect`).
 */
export function gcpRedirectPathRules(plan: RedirectPlan): GcpPathRule[] {
  return plan.redirects.map(toPathRule);
}

function toPathRule(r: PlannedRedirect): GcpPathRule {
  if (r.matchPaths.some((p) => p.includes("*"))) {
    throw new Error(
      `redirect-emit-gcp: the redirect for ${JSON.stringify(r.fromPath)} contains '*', which a GCP URL map reads as a wildcard. Percent-encode it ('%2A') with bulk_create_redirects (upsert), then publish again.`,
    );
  }
  if (!r.preserveQuery) {
    throw new Error(
      `redirect-emit-gcp: the redirect ${r.fromPath} → ${r.location} targets a URL with a query string or fragment, which a GCP URL-map redirect cannot carry. Point it at the page's path with bulk_create_redirects (upsert), then publish again.`,
    );
  }
  return {
    paths: [...r.matchPaths],
    urlRedirect: {
      pathRedirect: r.location,
      redirectResponseCode: RESPONSE_CODE[r.statusCode],
      // The visitor's query string rides along, like on every provider.
      stripQuery: false,
    },
  };
}

/** Whether a path rule is one a redirect plan wrote (see module comment). */
export function isGcpRedirectRule(rule: GcpPathRule): boolean {
  return rule.urlRedirect !== undefined && rule.service === undefined;
}

/**
 * The path matcher with its redirect rules replaced by the plan's. Rules
 * that are not redirects stay first, in their order — `/api/*` keeps
 * routing to the gateway. Path rules match the longest path, so the order
 * between them does not change routing.
 *
 * @throws {GcpUrlMapBudgetError} when the result exceeds the quota.
 */
export function withGcpRedirects(matcher: GcpPathMatcher, plan: RedirectPlan): GcpPathMatcher {
  if (matcher.routeRules && matcher.routeRules.length > 0) {
    throw new Error(
      `redirect-emit-gcp: path matcher ${JSON.stringify(matcher.name)} uses routeRules; a path matcher holds either pathRules or routeRules, and Caelo's stack writes pathRules. The URL map was changed outside the stack — restore it with the installer, then publish again.`,
    );
  }
  const kept = (matcher.pathRules ?? []).filter((r) => !isGcpRedirectRule(r));
  const redirects = gcpRedirectPathRules(plan);
  const pathRules = [...kept, ...redirects];
  const predicates = pathRules.reduce((n, r) => n + r.paths.length, 0);
  if (predicates > GCP_URL_MAP_MAX_PREDICATES || pathRules.length > GCP_URL_MAP_MAX_PATH_RULES) {
    throw new GcpUrlMapBudgetError(redirects.length, predicates, pathRules.length);
  }
  return { ...matcher, pathRules };
}

/**
 * Check a plan against the budget a path matcher with `baseRules` leaves,
 * without a URL map at hand (Stage runs it so an over-quota redirect set
 * is reported before Confirm-publish).
 *
 * @throws {GcpUrlMapBudgetError} when the plan does not fit.
 */
export function assertGcpRedirectBudget(
  plan: RedirectPlan,
  baseRules: readonly GcpPathRule[],
): void {
  withGcpRedirects({ name: "budget-check", pathRules: baseRules }, plan);
}

/** The site's own routing in the `public` path matcher (stack + budget). */
export const GCP_PUBLIC_BASE_PATHS: readonly string[] = ["/api/*"];
