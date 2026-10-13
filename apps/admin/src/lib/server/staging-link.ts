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
