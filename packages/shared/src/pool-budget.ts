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

/** What the budget is computed from: the server and the scale-out limits. */
export interface PoolBudgetInput {
  /** The server's `max_connections`, as provisioning sets it. */
  readonly maxConnections: number;
  /** Most admin instances that may run at once (Cloud Run `maxInstanceCount`, …). */
  readonly adminMaxInstances: number;
  /** Most gateway instances that may run at once. */
  readonly gatewayMaxInstances: number;
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
  | "admin-public";

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
 * `listen = adminMaxInstances × LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE` and
 * `admin-public = adminMaxInstances × ADMIN_PUBLIC_POOL_MAX`.
 *
 * @throws Error naming what to change when the server cannot give every
 *   admin instance at least {@link ADMIN_POOL_FLOOR} cms_admin connections.
 *
 * @example
 *   computePoolBudget({ maxConnections: 100, adminMaxInstances: 5,
 *     gatewayMaxInstances: 10, concurrentBuilds: 2, maintenanceReserve: 5,
 *     migrationsReserve: 2, jobsReserve: 4 }).adminPoolMax // → 7
 */
export function computePoolBudget(input: PoolBudgetInput): PoolBudget {
  positiveInteger(input.maxConnections, "maxConnections", 1);
  positiveInteger(input.adminMaxInstances, "adminMaxInstances", 1);
  positiveInteger(input.gatewayMaxInstances, "gatewayMaxInstances", 0);
  positiveInteger(input.concurrentBuilds, "concurrentBuilds", 0);
  positiveInteger(input.maintenanceReserve, "maintenanceReserve", 0);
  positiveInteger(input.migrationsReserve, "migrationsReserve", 0);
  positiveInteger(input.jobsReserve, "jobsReserve", 0);

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
    { name: "admin-public", connections: input.adminMaxInstances * ADMIN_PUBLIC_POOL_MAX },
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
        "or lower adminMaxInstances / gatewayMaxInstances.",
    );
  }
  return {
    adminPoolMax,
    adminPublicPoolMax: ADMIN_PUBLIC_POOL_MAX,
    gatewayPoolMax: GATEWAY_POOL_MAX,
    generatorPoolMax: GENERATOR_POOL_MAX,
    reserves,
    unassigned: forAdmin - adminPoolMax * input.adminMaxInstances,
  };
}

/** Which service's pool env {@link poolBudgetEnv} returns. */
export type PoolBudgetService = "admin" | "gateway";

/**
 * The env that sizes `service`'s pools from `budget`, for the stacks to set.
 * The admin gets both pools; the gateway, whose only pool is cms_public,
 * gets just that one.
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
