# The scale gate

Issue #1267. Caelo must serve 50,000 pages to 20 parallel MCP agents and 5 editors on the smallest Google Cloud install: a db-f1-micro Postgres and a 1-vCPU / 2 GiB admin. The only acceptable limit is real CPU or database capacity, never programmatic blocking. The scale gate measures that promise end to end against a running admin, so a change that makes a request read the whole site or the whole history fails before it ships.

It complements the per-op rows-read test in PR CI (which catches the same class earlier and per operation); the gate catches what only shows under concurrency: pool exhaustion, lock waits, a request that is cheap alone and slow next to nineteen others.

## When it runs

`.github/workflows/scale-gate.yml`:

- **nightly** (02:17 UTC), on `main`;
- on a **pull request with the `perf-gate` label** (and on every push to it while the label is set);
- manually (`workflow_dispatch`).

A release is blocked while the nightly run is red. The JSON report, the markdown table and both logs are uploaded as the run's artifact; the table is also in the job summary.

## Environment

| Part | Setting | Why |
|---|---|---|
| Admin | the production build (`apps/admin` `bun run build`) in `oven/bun:1.4.4`, `--cpus=1 --memory=2g` | the Cloud Run admin's size |
| Postgres | `postgres:17-alpine`, `--memory=614m`, `max_connections=100`, `shared_buffers=128MB`, `effective_cache_size=400MB`, `work_mem=4MB` | db-f1-micro (0.6 GB, 100 connections) |
| Postgres CPU | `docker update --cpus=0.2` after the fixture is seeded, before the admin starts (cgroup `cpu.max` = `20000 100000`, checked) | db-f1-micro's CPU share (#1390), see below |
| Lock waits | `deadlock_timeout=100ms`, `log_lock_waits=on` | every wait over 100 ms is logged as `still waiting for`, which the gate counts |
| `pg_stat_statements` | preloaded | so a red run can be diagnosed from the same database |
| `auto_explain` | preloaded; `log_min_duration=2s`, `log_analyze`, `log_buffers`, `log_timing=off`, `log_nested_statements`, `log_format=json` | the plan of every statement over 2 s, with actual rows and buffers per node (#1269): a statement's cost under load and in a local repro can come from different plans. Per-node timing is off because it is what makes analyze expensive on a fifth of a core |
| Plugins | every shipped plugin active (the fixture), dev-signed at boot (`NODE_ENV=development`), like the E2E suite | their change consumers, workers and render hooks are part of the load (#1390) |
| Scheduler | `CAELO_SCHEDULER_CLOCK=off`; the load calls `POST /api/internal/scheduler/tick` every 60 s with an internal token (`CAELO_INTERNAL_SECRET`) | like an install's scheduler at its shortest interval (`schedulerIntervalMinutes` 1), so every plugin worker runs during the load |

### The db-f1-micro CPU share

Cloud SQL's `db-f1-micro` is a shared-core machine type (Cloud SQL instance settings: "configured to use a shared-core CPU"). Its Compute Engine counterpart `f1-micro` has a *fractional vCPU of 0.2*, with one vCPU exposed to the guest; shared-core N1 machines may burst above their share for short periods at no extra charge, and Google documents no burst budget for them (Compute Engine, general-purpose machine families, N1 shared-core table). The gate models the **sustained** share: a CFS quota of 20 ms per 100 ms period, no burst. That is what production ran at when it stalled: on 2026-11-03 searchVIU's Cloud SQL CPU utilisation sat flat at 0.20–0.25 while 20 agents worked, and a cached index lookup took 30 ms. A model with bursts would let a short gate run pass on credit that a sustained load does not have.

The cap is applied after seeding, not at `docker run`: the fixture's bulk SQL is not measured, and seeding 50,000 pages at a fifth of a core would cost the job most of its time budget. The admin starts, the plugins' first rebuild and the load run on the capped database.

## Fixture

`scripts/scale-gate/fixture.ts`, size `SCALE_GATE_PAGES` (default 50,000). It refuses to run unless `CAELO_SCALE_GATE_THROWAWAY_DB=1`, and refuses a database that already holds pages.

Structure goes through the real operations: users and their logins, an AI provider row (Live Mode refuses to open without one; the load never calls the model), a mail transport (`email_config.set`, SMTP to a port nothing listens on: newsletter cannot be activated without one, #1332, and the load subscribes nobody), **every shipped plugin** active (`scripts/scale-gate/plugins.ts`, handed to the plugin host as an explicit activation, dependencies first; `scripts/scale-gate-workflow.test.ts` fails when a directory under `packages/plugins/` is missing there), international-site's `en` (default) and `de` (subdirectory), one form (forms `create_form`), a `news` page type with a categories vocabulary, an article module, a page-query feed module, a video module embedding a third-party player (`youtube-nocookie.com`, so the consent-manager's scans and change consumer have a vendor to judge), one placeholder module per plugin component and page (the `add_plugin_to_page` shape), a mega-menu list type and list with a query node, twenty open chats on the shared draft, one chat per editor, and twenty admin-scoped MCP tokens (`mcp_tokens.create`). Volume is bulk SQL (`generate_series`), because seeding 50,000 pages through `pages.create` would measure `pages.create`.

For N pages:

| Dimension | Amount |
|---|---|
| English pages (published, type `news`) | 0.7·N |
| German variants of the first ones, in variant groups | 0.3·N |
| Article placements, each with its own content instance | N |
| Overview pages with the shared page-query feed | every 50th English page |
| Video placements (third-party iframe), each with its own content instance | about one page in 20 |
| Plugin component placements (auth, comments, forms, newsletter, ratings) | 20 pages each, among the first pages editors open |
| Ratings (cms_public, for the ratings worker) | 3 on every 10th English page |
| Category terms, SEO rows | one per page |
| Staged snapshots of history on the draft branch | 4·N |
| Pending snapshots on the shared draft, spread over 20 chats | 0.4·N |

It writes a JSON file with the editors' session tokens and chats, the MCP tokens, the draft branch, the English pages still without a German variant (the agents' work queue) and the pages editors open. Placement content is in `content_instances` (the legacy `page_module_content` table is not written by any operation any more, so the fixture leaves it empty).

## Load

`scripts/scale-gate/run.ts`, for `--duration` seconds (default 300):

- **20 agents**, one per MCP token, each with its own work session (`POST /api/mcp/session`, `newSession: true`), translating one page at a time with the full context and no batching (#1253 decisions): `inspect_page_render` (read), `create_variant` (write), `set_page_module_content_many` on the new variant (write), all through `POST /api/mcp/tool`.
- **5 editors**, each with a session cookie: open Live Mode on a page (`GET /edit?page=…&chat=…`), preview a page on the shared draft (`GET /edit/preview-by-path/<path>?branch=<draft>`), then preview it again unchanged.

Every call has a timeout (`--call-timeout`, default 30 s), so a run against a slow build finishes and records numbers instead of hanging: a timed-out call counts as one sample at the timeout and is counted separately.

Before the load (#1390) the harness refuses to start until `list_plugins` reports every shipped plugin `running`, and (`--settle-consumers`) waits up to `--settle-timeout` (default 900 s) until every plugin change consumer has finished the first rebuild a fresh activation starts with: that rebuild is a one-off over the whole site, and the gate measures the steady state. The wait is reported; not settling in time fails the gate.

During the load it also:

- samples the Postgres container's own cgroup every `--cpu-interval` seconds (default 5) through `docker exec <--pg-container> cat /sys/fs/cgroup/cpu.stat`, and reads the share it runs under from `cpu.max` (`scripts/scale-gate/observe.ts`);
- calls the scheduler tick every `--tick-every` seconds, the first one at once (a worker the due-table has not seen is due then), and records each plugin worker's runs and failures from the tick's answer;
- resets `pg_stat_statements` at the start of the settle wait and again at the start of the load, and reports the 15 statements with the most execution time of each phase (calls, total and mean ms, rows, buffers, the normalised text; JSON `dbStatements.settle` / `.load`, the top ten in the table), so a saturated CPU share names the statements it went to;
- afterwards reads the plans `auto_explain` wrote into the Postgres log during each phase (`scripts/scale-gate/plans.ts`), groups them by statement text and reports the ten with the most logged time per phase: count, total and slowest duration, and the slowest occurrence's plan as a tree with actual rows, loops, buffers, conditions and rows removed by a filter (JSON `slowPlans.settle` / `.load`, collapsed blocks under the table);
- afterwards reads the admin log written since the preflight for plugin failures: `[plugin-host] <slug> <phase> failed (…)` (a failed load, operation or render, `recordPluginError`), `change consumer of "<slug>" stopped`, and the host-level consumer and heartbeat failures.

## Definitions and SLOs

- **First paint**: the `/edit` HTML document received up to `</html>`, every awaited load done. SvelteKit appends the load's streamed parts (`apps/admin/src/lib/server/edit-streamed.ts`, #1268) to the same response after `</html>`, so the harness stops the clock there and drains the rest untimed.
- **Preview**: the `preview-by-path` response received in full.
- **Unchanged-page preview**: the same preview requested again with no change to that page in between.
- **MCP write / read**: one `/api/mcp/tool` call of a writing / reading tool, until its JSON answer. An agent obeys back-pressure as a real MCP client does (#1375): a 429 ("Caelo is at capacity … Wait N s") is waited out and the same call sent again, and the sample is the whole time until it ran. Each refusal is counted in the table's `refused (429)` column.

| Measurement (p95) | Target |
|---|---|
| `/edit` first paint | < 1 s |
| Preview | < 1.5 s |
| Unchanged-page preview | < 200 ms |
| MCP write | < 1 s |
| MCP read | < 500 ms |

Plus **zero pool-acquire timeouts** (a `PoolAcquireTimeoutError` in the admin log, or a call answering that the pool had no free connection), **zero lock waits over 100 ms** (`still waiting for` in the Postgres log) and, since #1390, **zero plugin failures**: no plugin failure line in the admin log (a plugin's background work failing under load, such as a change consumer whose site-sized read hit the statement timeout and stopped, is exactly what stalled production on 2026-11-03), no failed or timed-out plugin worker run, no failed tick, and the change consumers settled before the load. A failure in an agent's own plugin call is counted here as well as in its measurement. A measurement with no samples, an error, a timeout or a refusal fails too. `--baseline` records without failing (for a run on `main` before a change).

**DB CPU** is reported, not a pass/fail of its own: mean, p95 and max CPUs used over the samples next to the share, the share of samples at ≥ 95 % of it (the database was CPU-bound) and the mean fraction of scheduler periods that hit the quota. A saturated share is what the latency SLOs then fail on; the CPU line says why. The JSON report carries it as `dbCpu`, the plugin side as `plugins` (`failures` per slug, `sampleFailures`, `settleSeconds`, `ticks.workers`).

## Run it locally

Use a throwaway Postgres container, never a database with data you need: the fixture rewrites site settings and the harness writes thousands of rows. Postgres runs in Docker because the CPU share and the CPU readings come from the container's cgroup (cgroup v2; Docker Desktop has it).

```sh
docker run -d --name sg-pg -p 127.0.0.1:5563:5432 --memory=614m \
  -e POSTGRES_USER=caelo -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=postgres postgres:17-alpine \
  -c shared_preload_libraries=pg_stat_statements,auto_explain -c max_connections=100 \
  -c auto_explain.log_min_duration=2s -c auto_explain.log_analyze=on -c auto_explain.log_buffers=on \
  -c auto_explain.log_timing=off -c auto_explain.log_nested_statements=on -c auto_explain.log_format=json \
  -c shared_buffers=128MB -c effective_cache_size=400MB -c work_mem=4MB \
  -c maintenance_work_mem=64MB -c deadlock_timeout=100ms -c log_lock_waits=on
export PGHOST=localhost PGPORT=5563 PGPASSWORD=pg POSTGRES_USER=caelo POSTGRES_DB=postgres \
  ADMIN_ROLE_PASSWORD=a PUBLIC_ROLE_PASSWORD=p PUBLIC_STAGING_ROLE_PASSWORD=s \
  ADMIN_DATABASE_URL=postgres://admin_role:a@localhost:5563/cms_admin \
  PUBLIC_ADMIN_DATABASE_URL=postgres://admin_role:a@localhost:5563/cms_public \
  PUBLIC_DATABASE_URL=postgres://public_role:p@localhost:5563/cms_public \
  PUBLIC_STAGING_ADMIN_DATABASE_URL=postgres://admin_role:a@localhost:5563/cms_public_staging \
  PUBLIC_STAGING_DATABASE_URL=postgres://public_staging_role:s@localhost:5563/cms_public_staging \
  CAELO_SECRET_KEK=0000000000000000000000000000000000000000000000000000000000000001 \
  CAELO_INTERNAL_SECRET=scale-gate-internal-secret-0000000000000001
sh packages/migrations/src/bootstrap.sh && bun run db:migrate

CAELO_SCALE_GATE_THROWAWAY_DB=1 SCALE_GATE_PAGES=50000 \
  bun scripts/scale-gate/fixture.ts --out /tmp/sg/fixture.json
docker update --cpus=0.2 sg-pg    # the db-f1-micro share, after seeding

bun run --filter '@caelo-cms/shared' build && bun run --filter '@caelo-cms/mcp-server' build
(cd apps/admin && bun run plugins:build && ORIGIN=http://localhost:4391 bun run build)
(cd apps/admin && PORT=4391 ORIGIN=http://localhost:4391 NODE_ENV=development \
  CAELO_RELEASE_CHECK=off CAELO_UPDATE_SCHEDULER=off CAELO_SCHEDULER_CLOCK=off \
  bun run build/index.js > /tmp/sg/admin.log 2>&1 &)
docker logs -f sg-pg > /tmp/sg/pg.log 2>&1 &

bun scripts/scale-gate/run.ts --fixture /tmp/sg/fixture.json --base-url http://localhost:4391 \
  --duration 300 --admin-log /tmp/sg/admin.log --pg-log /tmp/sg/pg.log \
  --pg-container sg-pg --tick-every 60 --settle-consumers \
  --report /tmp/sg/report.json --baseline
```

A laptop run cannot pin the admin to one vCPU, so its numbers are better than the gate's; compare runs on the same machine only. A run leaves the variants it created, so re-seeding needs a fresh database (`docker rm -f sg-pg`, then from the top).
