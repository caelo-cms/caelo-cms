// SPDX-License-Identifier: MPL-2.0

/**
 * Seeds `site_defaults.site_base_url` from the provisioner-declared
 * public URL (`CAELO_SITE_BASE_URL`, i.e. `https://<domain>`).
 *
 * Why this exists: the column ships with the dev value
 * `http://localhost:8082` (migration 0027) and nothing on a provisioned
 * install ever replaced it, so canonical / og:url / JSON-LD / sitemap /
 * robots.txt on real sites pointed at localhost. The provisioner knows
 * the domain but cannot reach the database (private IP), so it hands
 * the URL to the admin as an env var — on first provision through the
 * stack, on existing installs through `cms-provision upgrade` — and the
 * admin writes it once, through the audited `site_defaults.set_seo` op.
 *
 * Only a stored local address is replaced (`siteBaseUrlToSeed`): an
 * operator who set a public URL at Security → SEO keeps it. This is
 * stored data written once, not a render-time fallback — the static
 * generator still refuses to build a public install whose base URL is
 * local (`localSiteBaseUrlError`).
 *
 * Bootstrapped once per process from apps/admin/src/hooks.server.ts.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, siteBaseUrlToSeed } from "@caelo-cms/shared";

/** Outcome of one seeding attempt — returned so callers and tests can assert it. */
export type SiteBaseUrlSeedResult =
  | { readonly kind: "seeded"; readonly from: string; readonly to: string }
  | { readonly kind: "unchanged" };

/**
 * Write `declared` into `site_defaults.site_base_url` when the stored
 * value is still a local address. Keeps the sitemap toggle and
 * Organization JSON as they are.
 *
 * @param declared the `CAELO_SITE_BASE_URL` value; undefined on dev boxes.
 * @throws when reading or writing the setting fails — the caller logs it.
 */
export async function seedSiteBaseUrl(opts: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly ctx: ExecutionContext;
  readonly declared: string | undefined;
}): Promise<SiteBaseUrlSeedResult> {
  if (!opts.declared?.trim()) return { kind: "unchanged" };
  const current = await execute(opts.registry, opts.adapter, opts.ctx, "site_defaults.get_seo", {});
  if (!current.ok) {
    throw new Error(`site_defaults.get_seo failed: ${JSON.stringify(current.error)}`);
  }
  const settings = current.value as {
    siteBaseUrl: string;
    sitemapEnabled: boolean;
    organizationJson: Record<string, unknown>;
  };
  const next = siteBaseUrlToSeed(settings.siteBaseUrl, opts.declared);
  if (next === null) return { kind: "unchanged" };
  const written = await execute(opts.registry, opts.adapter, opts.ctx, "site_defaults.set_seo", {
    siteBaseUrl: next,
    sitemapEnabled: settings.sitemapEnabled,
    organizationJson: settings.organizationJson,
  });
  if (!written.ok) {
    throw new Error(`site_defaults.set_seo failed: ${JSON.stringify(written.error)}`);
  }
  return { kind: "seeded", from: settings.siteBaseUrl, to: next };
}
