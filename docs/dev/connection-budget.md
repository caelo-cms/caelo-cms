# Database connection budget

Issue #1254. Every Caelo process that talks to Postgres holds connection pools, and all of them draw from one server-wide `max_connections`: `cms_admin` and `cms_public` live on the same server. This page explains how each pool's size is derived, and why the answer to "the pool is full" is not a bigger pool.

## The problem it fixes

Before #1254 every pool took Bun's default of 10. A default GCP install runs up to 5 admin instances with two pools each, so the admin alone asked for 5 × 2 × 10 = 100 connections, exactly the server's `max_connections`. The gateway (up to 100 instances, one pool each), the static generator, migrations, the jobs and Cloud SQL's own agents had nothing left. Under load, the last instance to scale up could not connect at all, and it failed with "too many clients" at the worst moment.

## The formula

`@caelo-cms/shared` `pool-budget.ts` (`computePoolBudget`, re-exported by `@caelo-cms/query-api`) names every fixed consumer as a reserve, then splits what is left across the admin instances' `cms_admin` pools, the pools the write path uses:

```
adminPoolMax = floor((maxConnections − Σ reserves) / adminMaxInstances)
```

| Reserve | Connections | What it covers |
|---|---|---|
| `maintenance` | per provider: 5 (Cloud SQL, RDS), 15 (Azure), 3 (self-hosted) | `superuser_reserved_connections`, plus the provider's own agents (`cloudsqladmin`, `rdsadmin`, Azure replication and monitoring) |
| `migrations` | 2 | one connection per database during a migration run |
| `jobs` | 4 (GCP), 2 (others) | operator-access sync, upgrader and converge jobs, or the operator's lifecycle commands |
| `generator` | `concurrentBuilds` (2) × 2 pools × `GENERATOR_POOL_MAX` (2) | static-generator subprocesses: a Stage, a Publish live and a plugin-data build can overlap. A build runs in one transaction, so the admin sets the minimum pool on the child (`generatorEnv`, admin-core `deploy/generator-subprocess.ts`) |
| `gateway` | `gatewayMaxInstances` × `GATEWAY_POOL_MAX` (2) | the gateway's only pool (`public_role` on `cms_public`) |
| `listen` | `adminMaxInstances` × 1 | the change journal's `LISTEN` connection, one per admin instance (#1267, `LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE`). A LISTEN connection stays open for the instance's lifetime and never serves a pool query, so it is budgeted outside the pools |
| `admin-public` | `adminMaxInstances` × `ADMIN_PUBLIC_POOL_MAX` (4) | the admin's `cms_public` pool: plugin-data reads and the gateway projection |

If the remainder cannot give every admin instance at least `ADMIN_POOL_FLOOR` (4) connections, the formula throws. The message names the breakdown and the `max_connections` that would be needed, so a stack fails at `pulumi preview`, never under load.

Adding a consumer (a new job, a second LISTEN connection) means adding a reserve entry here, not raising a pool.

## Where the numbers are set

The pools read two env vars (query-api `adapter.ts`):

- `CAELO_DB_POOL_MAX` sizes every pool of the process;
- `CAELO_DB_PUBLIC_POOL_MAX` sizes the `cms_public` pool alone and wins over the first for it.

Both fail loudly on a malformed value or a value below 2. With neither set (a local dev server), Bun's default of 10 applies.

Each adapter computes the budget from its own inputs (provisioning `src/pool-budget-stack.ts`) and sets the env on its services. Each adapter also sets `max_connections` on the server explicitly, so the budget never depends on a tier's implicit default (db-f1-micro allows 25; RDS derives the value from instance memory).

| Adapter | `max_connections` | Admin-side instances | Gateway instances | cms_admin pool per admin instance |
|---|---|---|---|---|
| `gcp`, `gcp-firebase` | 100 (`maxConnections`, Cloud SQL flag) | 5 (`adminMaxInstances`) | 10 (`gatewayMaxInstances`, was a fixed 100) | 7 |
| `aws` | 100 (`maxConnections`, RDS parameter group) | 5 | 10 | 7, exported as `poolBudgetEnvOut` until the task definitions exist (#749) |
| `azure` | 429 (`maxConnections`, server parameter; the Standard_B2s limit) | 30 (admin, orchestrator and runner apps, 10 replicas each) | 10 | 7 |
| `self-hosted` | 100 (Compose `command`) | 1 | 1 | 78 |

On the GCP stacks the pool env sits next to the env contract, like the remote-MCP identity env. It is derived from stack config that an upgrade roll cannot see, so `upgrade` never sets it. A roll never removes a var the contract does not own, so an install keeps its pool sizes across app releases. A new budget reaches an existing install with the next converge (`pulumi up`).

## Why the pool is not just raised

A pool larger than its share does not create connections the server does not have. It only moves the wait from the pool, where it is bounded (`POOL_ACQUIRE_TIMEOUT_MS`) and says which caller waited, to the server, where it fails with "too many clients" for whichever process connects last, often a migration or a fresh instance. A pool that is full while the database idles is a code problem: a transaction holding a connection while it waits for a second one, or for the network. The pool guard (query-api `pool-guard.ts`) and #1254's render-hook and redirect-sync work fix those. The budget only makes sure that when the pools are full, the server really is.
