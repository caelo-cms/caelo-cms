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
| `gateway` | `gatewayMaxInstances` × `GATEWAY_POOL_MAX` (2) | the gateway's only pool (`public_role` on `cms_public`). The database caps `public_role` at `GATEWAY_ROLE_CONNECTION_LIMIT` (30) connections, pool and LISTEN together (#1338, [gateway-hardening.md](./gateway-hardening.md)), so `computePoolBudget` refuses more than 10 gateway instances |
| `listen` | `adminMaxInstances` × 1 | the change journal's `LISTEN` connection, one per admin instance (#1267, `LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE`). A LISTEN connection stays open for the instance's lifetime and never serves a pool query, so it is budgeted outside the pools |
| `gateway-listen` | `gatewayMaxInstances` × 1 | the gateway's `LISTEN caelo_gateway_settings` connection on `cms_public` (`LISTEN_CONNECTIONS_PER_GATEWAY_INSTANCE`), held outside its pool |
| `admin-public` | `adminMaxInstances` × `ADMIN_PUBLIC_POOL_MAX` (4) | the admin's `cms_public` pool: plugin-data reads and the gateway projection |
| `staging-gateway` | `stagingGatewayMaxInstances` (1) × (`GATEWAY_POOL_MAX` + 1 LISTEN) | the staging gateway (#1329, served from #1330): the same image on `cms_public_staging` as `public_staging_role`, capped by that role's `CONNECTION LIMIT` of 30 like the live one (`STAGING_GATEWAY_ROLE_CONNECTION_LIMIT`) |
| `admin-public-staging` | `adminMaxInstances` × `ADMIN_PUBLIC_STAGING_POOL_MAX` (2) | the admin's `cms_public_staging` pool (#1329): the staging database's plugin tables and its half of the projection. Fixed in code at the minimum pool, no env var |

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
| `gcp`, `gcp-firebase` | 100 (`maxConnections`, Cloud SQL flag) | 4 (`adminMaxInstances`, 5 before #1329) | 10 (`gatewayMaxInstances`, was a fixed 100), staging 1 | 5 |
| `aws` | 100 (`maxConnections`, RDS parameter group) | 4 (5 before #1329) | 10, staging 1 | 5, exported as `poolBudgetEnvOut` until the task definitions exist (#749) |
| `azure` | 429 (`maxConnections`, server parameter; the Standard_B2s limit) | 30 (admin, orchestrator and runner apps, 10 replicas each) | 10, staging 1 | 5 (7 before #1329) |
| `self-hosted` | 100 (Compose `command`) | 1 | 1, staging 1 | 72 (77 before #1329) |

### #1329: the staging database, and why `max_connections` stayed at 100

The staging database added two reserves: the staging gateway (3 connections at one instance) and the admin's `cms_public_staging` pool (2 per admin instance). On the default GCP server the five admin instances before then no longer got the minimum `cms_admin` pool (5 × 2 + 3 more reserved leaves 10 for 5 instances, below `ADMIN_POOL_FLOOR`). Two ways out were weighed:

- **Raise `max_connections` to about 150.** Not taken for the default `db-f1-micro` (shared core, 614 MB). Cloud SQL's own default for that memory is 25 connections, and the stack already runs it at 100. Each Postgres backend takes a few MB of private memory before any query (more under `work_mem`), next to the shared buffers, so 150 backends at full scale-out leave a 614 MB instance no headroom; the risk is the server being OOM-killed under load, which takes every environment down at once. A larger tier can take a larger `maxConnections` together with more instances; the formula checks any combination at `pulumi preview`.
- **Lower the instance counts.** Taken: the GCP and AWS stacks start at most four admin instances (`DEFAULT_ADMIN_MAX_INSTANCES`), and the staging gateway at most one (`DEFAULT_STAGING_GATEWAY_MAX_INSTANCES`, staging serves the team, the audit and admitted crawlers, never the public). Each admin instance keeps its five `cms_admin` connections; the default server is fully assigned (0 left over).

An install whose operator set `adminMaxInstances` to 5 explicitly gets the formula's refusal at the next `pulumi preview`, naming the connections it needs.

On the GCP stacks the pool env sits next to the env contract, like the remote-MCP identity env. It is derived from stack config that an upgrade roll cannot see, so `upgrade` never sets it. A roll never removes a var the contract does not own, so an install keeps its pool sizes across app releases. A new budget reaches an existing install with the next converge (`pulumi up`).

## Why the pool is not just raised

A pool larger than its share does not create connections the server does not have. It only moves the wait from the pool, where it is bounded (`POOL_ACQUIRE_TIMEOUT_MS`) and says which caller waited, to the server, where it fails with "too many clients" for whichever process connects last, often a migration or a fresh instance. A pool that is full while the database idles is a code problem: a transaction holding a connection while it waits for a second one, or for the network. The pool guard (query-api `pool-guard.ts`) and #1254's render-hook and redirect-sync work fix those. The budget only makes sure that when the pools are full, the server really is.

## When the pool is full anyway: MCP back-pressure (#1375)

The adapter counts its own checkouts (`DatabaseAdapter.poolPressure`, query-api `pool-pressure.ts`): connections in use and by which holder, callers waiting and for how long. Bun.SQL keeps no such count. While callers wait for an admin connection and the oldest has waited a second (or as many wait as the pool has connections), every request under `/api/mcp/*` is answered at once with `429` and `Retry-After` (admin-core `mcp-back-pressure.ts`, called first in the admin's `hooks.server.ts`), before it touches the database. The remote endpoints answer with a JSON-RPC error, the stdio bridge turns the 429 into a tool error, and both tell the agent to wait the named seconds and send the same call again unchanged. The editor, the chat and the workers are not refused; they keep the bounded acquire wait. An op whose own checkout runs into the acquire deadline fails with `HandlerError.busy` (not `internal`: load is not a defect) and the MCP routes answer it with the same 429.

Why only MCP: external agents are the traffic that grows without bound (every parallel session adds a stream of calls) and the only callers that can wait and retry. On 2026-11-03 up to ten sessions ran against one admin; each new call waited the 10 s deadline, failed with a 500 and was sent again, so the queue never drained. The first refusal per 30 s window is logged with the pool's longest holders, which names what kept the connections.

Back-pressure does not replace fixing what holds the pool. In that incident it was reads that walked the shared draft's whole pending history (every pending content-instance snapshot, sorted, per `content_instances.get`); they now read the draft head (`draft_pending_entities`) instead.
