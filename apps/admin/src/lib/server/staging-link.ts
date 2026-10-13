// SPDX-License-Identifier: MPL-2.0

import { providerHasStagingDomain } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error } from "@sveltejs/kit";
import { getQueryContext } from "./query.js";

/**
 * #650 — the admin's link to a page on the protected staging site: the
 * "Open staging" route, which signs the operator in on staging.<domain>
 * and lands on the page. Never the provider's preview origin.
 */
export function openStagingHref(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p === "/" ? "/staging/open" : `/staging/open?path=${encodeURIComponent(p)}`;
}

/**
 * A 303 to the signed staging link on the staging host. SvelteKit 3's
 * `redirect()` refuses cross-origin targets (`redirect_external_not_allowed`,
 * a 500), and the staging host is never the admin's origin, so the route
 * builds the response itself. Only an absolute https URL is accepted, and
 * the response is never cached because the URL carries a one-time token.
 */
export function stagingOpenRedirect(target: string): Response {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw error(500, `staging_access.issue_open_link returned an invalid URL: ${target}`);
  }
  if (url.protocol !== "https:") {
    throw error(500, `staging_access.issue_open_link returned a non-https URL (${url.protocol})`);
  }
  return new Response(null, {
    status: 303,
    headers: { location: url.toString(), "cache-control": "no-store" },
  });
}

/**
 * #650 — the protected staging site's origin (`https://<staging host>`)
 * when this install has one, else null. Fails loudly when the provider
 * serves staging at its own host but no host is configured.
 */
export async function stagingOriginForAdmin(ctx: ExecutionContext): Promise<string | null> {
  if (!providerHasStagingDomain(process.env.CAELO_PROVIDER)) return null;
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "staging_access.get", {});
  const url = r.ok ? (r.value as { stagingUrl: string | null }).stagingUrl : null;
  if (!url) {
    throw error(
      409,
      "No staging host is configured. Set it under Settings → Domains, or run `cms-provision upgrade`.",
    );
  }
  return url;
}
