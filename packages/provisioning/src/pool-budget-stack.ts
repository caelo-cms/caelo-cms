// SPDX-License-Identifier: MPL-2.0

/**
 * #1254 — each adapter's connection budget (CLAUDE.md §11.B / §11.C): what
 * its Postgres reserves for itself, which jobs it runs, and the default
 * `max_connections` it provisions. The formula itself is shared
 * (`@caelo-cms/shared` pool-budget.ts); this file only states each
 * provider's inputs, so every stack sizes its pools the same way and a
 * stack that sets a number the formula refuses fails at `pulumi preview`,
 * not under load.
 *
 * docs/dev/connection-budget.md explains the reserves.
 */

import {
  computePoolBudget,
  DB_PUBLIC_POOL_MAX_ENV,
  DEFAULT_STAGING_GATEWAY_MAX_INSTANCES,
  GATEWAY_POOL_MAX,
  type PoolBudget,
  type PoolBudgetInput,
  poolBudgetEnv,
} from "@caelo-cms/shared";

export { DEFAULT_STAGING_GATEWAY_MAX_INSTANCES };

/** The adapters that provision a Postgres server. */
export type BudgetProvider = "gcp" | "gcp-firebase" | "aws" | "azure" | "self-hosted";

/** The fixed reserves of one provider (the part of {@link PoolBudgetInput} it decides). */
export interface ProviderReserves {
  readonly maintenanceReserve: number;
  readonly migrationsReserve: number;
  readonly jobsReserve: number;
  readonly concurrentBuilds: number;
}

/**
 * Reserves per provider.
 *
 * - maintenance: Postgres keeps `superuser_reserved_connections` (3) for
 *   itself; Cloud SQL's `cloudsqladmin` and RDS's `rdsadmin` agents take
 *   about two more; Azure Flexible Server keeps 15 for replication and
 *   monitoring.
 * - migrations: one connection per database of a migration run.
 * - jobs: the GCP installs run the operator-access sync, upgrader and
 *   converge jobs (one serial query stream each, plus one spare); the other
 *   adapters run lifecycle commands from the operator's machine (backup).
 * - builds: a Stage, a Publish live and a plugin-data build can overlap.
 */
export const PROVIDER_RESERVES: Readonly<Record<BudgetProvider, ProviderReserves>> = {
  gcp: { maintenanceReserve: 5, migrationsReserve: 2, jobsReserve: 4, concurrentBuilds: 2 },
  "gcp-firebase": {
    maintenanceReserve: 5,
    migrationsReserve: 2,
    jobsReserve: 4,
    concurrentBuilds: 2,
  },
  aws: { maintenanceReserve: 5, migrationsReserve: 2, jobsReserve: 2, concurrentBuilds: 2 },
  azure: { maintenanceReserve: 15, migrationsReserve: 2, jobsReserve: 2, concurrentBuilds: 2 },
  "self-hosted": {
    maintenanceReserve: 3,
    migrationsReserve: 2,
    jobsReserve: 2,
    concurrentBuilds: 2,
  },
};

/**
 * `max_connections` each adapter provisions unless the operator sets the
 * `maxConnections` knob. Every stack sets the server parameter to this value
 * explicitly, so the budget never depends on a tier's implicit default
 * (db-f1-micro's is 25, RDS derives it from instance memory).
 */
export const DEFAULT_MAX_CONNECTIONS: Readonly<Record<BudgetProvider, number>> = {
  gcp: 100,
  "gcp-firebase": 100,
  aws: 100,
  // The default Standard_B2s server allows up to 429.
  azure: 429,
  "self-hosted": 100,
};

/**
 * Gateway instances a GCP stack lets Cloud Run start (`gatewayMaxInstances`
 * knob). Before #1254 it was a hard-coded 100, which at even the minimum
 * pool of 2 asks for twice the server's 100 slots; ten instances serve
 * 800 concurrent visitor requests at Cloud Run's default concurrency.
 */
export const DEFAULT_GATEWAY_MAX_INSTANCES = 10;

/**
 * #1463 — the most instances each gateway may run, for what `upgrade` applies
 * to an existing install. An upgrade reads no stack config, so this is a
 * ceiling, not a target: the live value is lowered to it and never raised
 * (app-roll.ts), which keeps a smaller `gatewayMaxInstances` an operator set.
 * Above it the database refuses the gateway's connections (`public_role`'s
 * CONNECTION LIMIT, pool-budget.ts).
 */
export const GATEWAY_MAX_INSTANCES_CEILING = {
  gateway: DEFAULT_GATEWAY_MAX_INSTANCES,
  "staging-gateway": DEFAULT_STAGING_GATEWAY_MAX_INSTANCES,
} as const;

/**
 * #1463 — the pool env of one gateway instance, live or staging: what the
 * stacks set from {@link stackPoolBudget} and `upgrade` sets on an install
 * that has none. It does not depend on the scale-out, so a roll that cannot
 * see stack config still sets the right value.
 */
export const GATEWAY_POOL_ENV: readonly { readonly name: string; readonly value: string }[] = [
  { name: DB_PUBLIC_POOL_MAX_ENV, value: String(GATEWAY_POOL_MAX) },
];

/**
 * Admin instances a GCP or AWS stack lets start (`adminMaxInstances` knob).
 * Five before #1329; the staging database added the admin's
 * cms_public_staging pool and the staging gateway to the budget, and on the
 * default server (100 connections) five instances no longer get the
 * minimum cms_admin pool. Raising `max_connections` instead was ruled out
 * for db-f1-micro (docs/dev/connection-budget.md, "#1329").
 */
export const DEFAULT_ADMIN_MAX_INSTANCES = 4;

/** The server and scale-out a stack sizes its pools for. */
export interface StackScale {
  readonly maxConnections: number;
  /** Every instance that opens the admin's pools (admin-side services included). */
  readonly adminMaxInstances: number;
  readonly gatewayMaxInstances: number;
  /** #1329 — the staging gateway's scale-out ({@link DEFAULT_STAGING_GATEWAY_MAX_INSTANCES}). */
  readonly stagingGatewayMaxInstances: number;
}

/** A stack's budget plus the env each service sets from it. */
export interface StackPoolBudget {
  readonly budget: PoolBudget;
  readonly env: {
    readonly admin: { readonly name: string; readonly value: string }[];
    readonly gateway: { readonly name: string; readonly value: string }[];
  };
}

/**
 * The budget of a `provider` install at `scale`.
 *
 * @throws Error (from the shared formula) naming the connections needed when
 *   the server is too small for the configured scale-out.
 */
export function stackPoolBudget(provider: BudgetProvider, scale: StackScale): StackPoolBudget {
  const budget = computePoolBudget({ ...PROVIDER_RESERVES[provider], ...scale });
  return {
    budget,
    env: { admin: poolBudgetEnv(budget, "admin"), gateway: poolBudgetEnv(budget, "gateway") },
  };
}
