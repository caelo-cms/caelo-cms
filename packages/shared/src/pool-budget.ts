// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1254 — the database connection budget of an install.
 *
 * Every Caelo process that talks to Postgres holds connection pools, and
 * they all draw from ONE server-wide `max_connections` (cms_admin and
 * cms_public live on the same server). Before #1254 every pool took Bun's
 * default of 10, so the admin alone asked for `adminMaxInstances × 2 × 10`
 * — exactly the 100 slots of a default install, with nothing left for the
 * gateway, the static generator, migrations or the provider's own agents.
 * Under load the last admin instance to scale up could not connect at all.
 *
 * The budget turns that around: provisioning states how many connections
 * the server has and how many instances may run, every fixed consumer is
 * named as a {@link PoolBudgetReserve}, and what is left is split across
 * the admin instances' cms_admin pools — the pool the write path uses.
 * The admin's cms_public pool is small and fixed: the admin only reads
 * plugin data there and publishes the gateway projection.
 *
 * Why not simply raise the pool: a larger pool only moves the wait from
 * the pool to the server. A pool sized past the budget fails with "too
 * many clients" at the worst moment (scale-out under load) instead of
 * waiting a bounded time for a free connection of its own pool
 * (query-api pool-guard.ts). docs/dev/connection-budget.md has the long
 * version.
 *
 * Pure module — no I/O. Used by the provisioning stacks (which set the
 * resulting env on each service) and re-exported by `@caelo-cms/query-api`.
 */

/** Env var sizing every pool of a `DatabaseAdapter` (both pools, unless the next one is set). */
export const DB_POOL_MAX_ENV = "CAELO_DB_POOL_MAX";

/**
 * Env var sizing the cms_public pool of a `DatabaseAdapter` on its own. It
 * wins over {@link DB_POOL_MAX_ENV} for that pool, so the admin can run a
 * large cms_admin pool next to a small cms_public one.
 */
export const DB_PUBLIC_POOL_MAX_ENV = "CAELO_DB_PUBLIC_POOL_MAX";

/** Smallest pool a `DatabaseAdapter` accepts: one connection self-deadlocks it. */
export const MIN_POOL_MAX = 2;

/**
 * Smallest cms_admin pool the budget hands an admin instance. Below it a
 * handful of concurrent editors and agents queue on every write; an install
 * whose server cannot afford it must get a larger tier or fewer instances,
 * so {@link computePoolBudget} refuses instead of shipping a starved pool.
 */
export const ADMIN_POOL_FLOOR = 4;

/** The admin's cms_public pool: plugin-data reads and the gateway projection. */
export const ADMIN_PUBLIC_POOL_MAX = 4;

/**
 * #1329 — the admin's cms_public_staging pool: the staging database's
 * plugin schemas and its half of the two-target projection. Fixed at the
 * minimum pool, set by the admin in code (no env var): its work is a few
 * short DDL and publish transactions, one at a time per instance.
 */
export const ADMIN_PUBLIC_STAGING_POOL_MAX = MIN_POOL_MAX;

/** The gateway's only pool (public_role on cms_public), per instance. */
export const GATEWAY_POOL_MAX = 2;

/**
 * Each pool of one static-generator subprocess. A build runs in ONE
 * transaction (pool-guard.ts LONG_TRANSACTION_ALLOWLIST) and takes no
 * second checkout, so the minimum pool ({@link MIN_POOL_MAX}) is enough.
 */
export const GENERATOR_POOL_MAX = 2;

/**
 * #1267 — the dedicated connection each admin instance keeps open for
 * `LISTEN` on the change journal's wake-up channel. A LISTEN connection is
 * held for the instance's lifetime and can never serve a query of the pool,
 * so it is budgeted outside the pools, one per admin instance.
 */
export const LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE = 1;

/**
 * The connection each gateway instance keeps open for `LISTEN
 * caelo_gateway_settings` on cms_public (api-gateway server.ts): outside the
 * gateway's pool, held for the instance's lifetime.
 */
export const LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE = 1;

/**
 * #1338 — public_role's `CONNECTION LIMIT` (cms_admin migration 0500,
 * bootstrap.sh; the role audit's `PUBLIC_ROLE_LIMITS` pins the same value):
 * the gateway's share at ten instances, `10 × (GATEWAY_POOL_MAX +
 * LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE)`. The database refuses the
 * gateway's connections beyond it, so {@link computePoolBudget} refuses a
 * scale-out that would need more instead of letting instances fail to
 * connect under load.
 */
export const GATEWAY_ROLE_CONNECTION_LIMIT = 30;

/**
 * #1329 — public_staging_role's `CONNECTION LIMIT` (cms_admin migration
 * 0530, bootstrap.sh): the same bound as the live gateway's login. The
 * database refuses the staging gateway's connections beyond it.
 */
export const STAGING_GATEWAY_ROLE_CONNECTION_LIMIT = GATEWAY_ROLE_CONNECTION_LIMIT;

/**
 * #1329 — staging gateway instances the stacks let start. Staging serves
 * the team, the audit and the crawlers the Owner admits, never the public,
 * so one instance (Cloud Run: 80 concurrent requests) carries it, and the
 * budget leaves the admin its cms_admin pool on the default server
 * (docs/dev/connection-budget.md has the numbers).
 */
export const DEFAULT_STAGING_GATEWAY_MAX_INSTANCES = 1;

/** What the budget is computed from: the server and the scale-out limits. */
export interface PoolBudgetInput {
  /** The server's `max_connections`, as provisioning sets it. */
  readonly maxConnections: number;
  /** Most admin instances that may run at once (Cloud Run `maxInstanceCount`, …). */
  readonly adminMaxInstances: number;
  /** Most gateway instances that may run at once. */
  readonly gatewayMaxInstances: number;
  /**
   * #1329 — most staging gateway instances that may run at once (the same
   * image on cms_public_staging, its own pool and LISTEN connection each).
   */
  readonly stagingGatewayMaxInstances: number;
  /**
   * Static-generator subprocesses that may run at once across the install
   * (a Stage, a Publish live and a plugin-data build can overlap).
   */
  readonly concurrentBuilds: number;
  /**
   * Connections the server keeps for itself and the provider's agents:
   * `superuser_reserved_connections`, Cloud SQL's `cloudsqladmin`, RDS's
   * `rdsadmin`, Azure's replication and monitoring slots.
   */
  readonly maintenanceReserve: number;
  /** Connections a migration run opens (one per database). */
  readonly migrationsReserve: number;
  /**
   * Connections of the install's other jobs (operator-access sync,
   * upgrader, converge). They run one query at a time.
   */
  readonly jobsReserve: number;
}

/** The named consumers the budget sets aside before it sizes the admin's cms_admin pool. */
export type PoolBudgetReserveName =
  | "maintenance"
  | "migrations"
  | "jobs"
  | "generator"
  | "gateway"
  /** #1267 — one LISTEN connection per admin instance ({@link LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE}). */
  | "listen"
  /** The gateway's settings LISTEN, one per gateway instance ({@link LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE}). */
  | "gateway-listen"
  | "admin-public"
  /** #1329 — the staging gateway's pool + LISTEN, per staging gateway instance. */
  | "staging-gateway"
  /** #1329 — the admin's cms_public_staging pool ({@link ADMIN_PUBLIC_STAGING_POOL_MAX}), per admin instance. */
  | "admin-public-staging";

/** One consumer of the server's connections the budget sets aside. */
export interface PoolBudgetReserve {
  readonly name: PoolBudgetReserveName;
  readonly connections: number;
}

/** The computed budget: pool sizes per process, and where every connection goes. */
export interface PoolBudget {
  /** cms_admin pool of each admin instance ({@link DB_POOL_MAX_ENV} on the admin). */
  readonly adminPoolMax: number;
  /** cms_public pool of each admin instance ({@link DB_PUBLIC_POOL_MAX_ENV} on the admin). */
  readonly adminPublicPoolMax: number;
  /** The gateway's cms_public pool ({@link DB_PUBLIC_POOL_MAX_ENV} on the gateway). */
  readonly gatewayPoolMax: number;
  /** #1329 — the admin's cms_public_staging pool (fixed, {@link ADMIN_PUBLIC_STAGING_POOL_MAX}). */
  readonly adminPublicStagingPoolMax: number;
  /** Each pool of a generator subprocess (the admin sets it on the child). */
  readonly generatorPoolMax: number;
  readonly reserves: readonly PoolBudgetReserve[];
  /** Connections no pool may use (the remainder of the per-instance split). */
  readonly unassigned: number;
}

function positiveInteger(value: number, name: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`pool budget: ${name} must be an integer >= ${min} (got ${value})`);
  }
}

/**
 * Split `maxConnections` across every process of the install.
 *
 * `adminPoolMax = floor((maxConnections − Σ reserves) / adminMaxInstances)`,
 * where the reserves are the fixed consumers of {@link PoolBudgetInput} plus
 * `gateway = gatewayMaxInstances × GATEWAY_POOL_MAX`,
 * `generator = concurrentBuilds × 2 × GENERATOR_POOL_MAX`,
 * `listen = adminMaxInstances × LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE`,
 * `gateway-listen = gatewayMaxInstances × LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE`,
 * `admin-public = adminMaxInstances × ADMIN_PUBLIC_POOL_MAX`,
 * `staging-gateway = stagingGatewayMaxInstances × (GATEWAY_POOL_MAX +
 * LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE)` and
 * `admin-public-staging = adminMaxInstances × ADMIN_PUBLIC_STAGING_POOL_MAX` (#1329).
 *
 * @throws Error naming what to change when the server cannot give every
 *   admin instance at least {@link ADMIN_POOL_FLOOR} cms_admin connections.
 *
 * @example
 *   computePoolBudget({ maxConnections: 100, adminMaxInstances: 4,
 *     gatewayMaxInstances: 10, stagingGatewayMaxInstances: 1, concurrentBuilds: 2,
 *     maintenanceReserve: 5, migrationsReserve: 2, jobsReserve: 4 }).adminPoolMax // → 5
 */
export function computePoolBudget(input: PoolBudgetInput): PoolBudget {
  positiveInteger(input.maxConnections, "maxConnections", 1);
  positiveInteger(input.adminMaxInstances, "adminMaxInstances", 1);
  positiveInteger(input.gatewayMaxInstances, "gatewayMaxInstances", 0);
  positiveInteger(input.stagingGatewayMaxInstances, "stagingGatewayMaxInstances", 0);
  positiveInteger(input.concurrentBuilds, "concurrentBuilds", 0);
  positiveInteger(input.maintenanceReserve, "maintenanceReserve", 0);
  positiveInteger(input.migrationsReserve, "migrationsReserve", 0);
  positiveInteger(input.jobsReserve, "jobsReserve", 0);
  const gatewayConnections =
    input.gatewayMaxInstances * (GATEWAY_POOL_MAX + LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE);
  if (gatewayConnections > GATEWAY_ROLE_CONNECTION_LIMIT) {
    throw new Error(
      `pool budget: ${input.gatewayMaxInstances} gateway instances need ${gatewayConnections} connections, but the database lets the gateway's login (public_role) hold at most ${GATEWAY_ROLE_CONNECTION_LIMIT} (CONNECTION LIMIT, #1338). ` +
        `Lower gatewayMaxInstances to at most ${Math.floor(GATEWAY_ROLE_CONNECTION_LIMIT / (GATEWAY_POOL_MAX + LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE))}.`,
    );
  }
  const stagingGatewayConnections =
    input.stagingGatewayMaxInstances * (GATEWAY_POOL_MAX + LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE);
  if (stagingGatewayConnections > STAGING_GATEWAY_ROLE_CONNECTION_LIMIT) {
    throw new Error(
      `pool budget: ${input.stagingGatewayMaxInstances} staging gateway instances need ${stagingGatewayConnections} connections, but the database lets the staging gateway's login (public_staging_role) hold at most ${STAGING_GATEWAY_ROLE_CONNECTION_LIMIT} (CONNECTION LIMIT, #1329). ` +
        `Lower stagingGatewayMaxInstances to at most ${Math.floor(STAGING_GATEWAY_ROLE_CONNECTION_LIMIT / (GATEWAY_POOL_MAX + LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE))}.`,
    );
  }

  const reserves: PoolBudgetReserve[] = [
    { name: "maintenance", connections: input.maintenanceReserve },
    { name: "migrations", connections: input.migrationsReserve },
    { name: "jobs", connections: input.jobsReserve },
    { name: "generator", connections: input.concurrentBuilds * 2 * GENERATOR_POOL_MAX },
    { name: "gateway", connections: input.gatewayMaxInstances * GATEWAY_POOL_MAX },
    {
      name: "listen",
      connections: input.adminMaxInstances * LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE,
    },
    {
      name: "gateway-listen",
      connections: input.gatewayMaxInstances * LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE,
    },
    { name: "admin-public", connections: input.adminMaxInstances * ADMIN_PUBLIC_POOL_MAX },
    { name: "staging-gateway", connections: stagingGatewayConnections },
    {
      name: "admin-public-staging",
      connections: input.adminMaxInstances * ADMIN_PUBLIC_STAGING_POOL_MAX,
    },
  ];
  const reserved = reserves.reduce((sum, r) => sum + r.connections, 0);
  const forAdmin = input.maxConnections - reserved;
  const adminPoolMax = Math.floor(forAdmin / input.adminMaxInstances);
  if (adminPoolMax < ADMIN_POOL_FLOOR) {
    const needed = reserved + ADMIN_POOL_FLOOR * input.adminMaxInstances;
    const breakdown = reserves.map((r) => `${r.name} ${r.connections}`).join(", ");
    throw new Error(
      `pool budget: max_connections ${input.maxConnections} cannot give each of ${input.adminMaxInstances} admin instances the minimum of ${ADMIN_POOL_FLOOR} cms_admin connections ` +
        `(reserved: ${breakdown}; ${needed} needed). Raise maxConnections to at least ${needed} (a larger database tier may be required), ` +
        "or lower adminMaxInstances / gatewayMaxInstances / stagingGatewayMaxInstances.",
    );
  }
  return {
    adminPoolMax,
    adminPublicPoolMax: ADMIN_PUBLIC_POOL_MAX,
    gatewayPoolMax: GATEWAY_POOL_MAX,
    adminPublicStagingPoolMax: ADMIN_PUBLIC_STAGING_POOL_MAX,
    generatorPoolMax: GENERATOR_POOL_MAX,
    reserves,
    unassigned: forAdmin - adminPoolMax * input.adminMaxInstances,
  };
}

/** Which service's pool env {@link poolBudgetEnv} returns. */
export type PoolBudgetService = "admin" | "gateway";

/**
 * The env that sizes `service`'s pools from `budget`, for the stacks to set.
 * The admin gets both pools (its cms_public_staging pool is fixed in code,
 * #1329); a gateway, live or staging, whose only pool is its public
 * database's, gets just that one.
 */
export function poolBudgetEnv(
  budget: PoolBudget,
  service: PoolBudgetService,
): { readonly name: string; readonly value: string }[] {
  if (service === "gateway") {
    return [{ name: DB_PUBLIC_POOL_MAX_ENV, value: String(budget.gatewayPoolMax) }];
  }
  return [
    { name: DB_POOL_MAX_ENV, value: String(budget.adminPoolMax) },
    { name: DB_PUBLIC_POOL_MAX_ENV, value: String(budget.adminPublicPoolMax) },
  ];
}
