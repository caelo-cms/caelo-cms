// SPDX-License-Identifier: MPL-2.0

/**
 * The targets of `packages/migrations/src/migrate.ts`, in the order every
 * runner applies them — the GCP migration job (migration-runner.ts), the
 * self-hosted install and upgrade (self-hosted-start.ts,
 * self-hosted-upgrade.ts) and the self-hosted stack: cms_admin first (its
 * role audit covers the whole cluster), then the two public databases,
 * which run the same cms_public files (#1329: cms_public_staging is the
 * staging site's twin, with its own gateway login).
 */
export const MIGRATION_TARGETS = ["admin", "public", "public-staging"] as const;
