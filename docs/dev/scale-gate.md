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
| Lock waits | `deadlock_timeout=100ms`, `log_lock_waits=on` | every wait over 100 ms is logged as `still waiting for`, which the gate counts |
| `pg_stat_statements` | preloaded | so a red run can be diagnosed from the same database |
| Plugins | shipped plugins dev-signed at boot (`NODE_ENV=development`), like the E2E suite | the international-site plugin must run |

## Fixture

`scripts/scale-gate/fixture.ts`, size `SCALE_GATE_PAGES` (default 50,000). It refuses to run unless `CAELO_SCALE_GATE_THROWAWAY_DB=1`, and refuses a database that already holds pages.

Structure goes through the real operations: users and their logins, an AI provider row (Live Mode refuses to open without one; the load never calls the model), the international-site plugin (active) with `en` (default) and `de` (subdirectory), a `news` page type with a categories vocabulary, an article module, a page-query feed module, a mega-menu list type and list with a query node, twenty open chats on the shared draft, one chat per editor, and twenty admin-scoped MCP tokens (`mcp_tokens.create`). Volume is bulk SQL (`generate_series`), because seeding 50,000 pages through `pages.create` would measure `pages.create`.

For N pages:

| Dimension | Amount |
|---|---|
| English pages (published, type `news`) | 0.7·N |
| German variants of the first ones, in variant groups | 0.3·N |
| Article placements, each with its own content instance | N |
| Overview pages with the shared page-query feed | every 50th English page |
| Category terms, SEO rows | one per page |
| Staged snapshots of history on the draft branch | 4·N |
| Pending snapshots on the shared draft, spread over 20 chats | 0.4·N |

It writes a JSON file with the editors' session tokens and chats, the MCP tokens, the draft branch, the English pages still without a German variant (the agents' work queue) and the pages editors open. Placement content is in `content_instances` (the legacy `page_module_content` table is not written by any operation any more, so the fixture leaves it empty).

## Load

`scripts/scale-gate/run.ts`, for `--duration` seconds (default 300):

- **20 agents**, one per MCP token, each with its own work session (`POST /api/mcp/session`, `newSession: true`), translating one page at a time with the full context and no batching (#1253 decisions): `inspect_page_render` (read), `create_variant` (write), `set_page_module_content_many` on the new variant (write), all through `POST /api/mcp/tool`.
- **5 editors**, each with a session cookie: open Live Mode on a page (`GET /edit?page=…&chat=…`), preview a page on the shared draft (`GET /edit/preview-by-path/<path>?branch=<draft>`), then preview it again unchanged.

Every call has a timeout (`--call-timeout`, default 30 s), so a run against a slow build finishes and records numbers instead of hanging: a timed-out call counts as one sample at the timeout and is counted separately.

## Definitions and SLOs

- **First paint**: the `/edit` HTML document received in full, every awaited load done. Streamed parts are excluded because the document ends without them.
- **Preview**: the `preview-by-path` response received in full.
- **Unchanged-page preview**: the same preview requested again with no change to that page in between.
- **MCP write / read**: one `/api/mcp/tool` call of a writing / reading tool, until its JSON answer.

| Measurement (p95) | Target |
|---|---|
| `/edit` first paint | < 1 s |
| Preview | < 1.5 s |
| Unchanged-page preview | < 200 ms |
| MCP write | < 1 s |
| MCP read | < 500 ms |

Plus **zero pool-acquire timeouts** (a `PoolAcquireTimeoutError` in the admin log, or a call answering that the pool had no free connection) and **zero lock waits over 100 ms** (`still waiting for` in the Postgres log). A measurement with no samples, an error or a timeout fails too. `--baseline` records without failing (for a run on `main` before a change).

## Run it locally

Use a throwaway Postgres cluster, never a database with data you need: the fixture rewrites site settings and the harness writes thousands of rows.

```sh
# a throwaway cluster on its own port, with the flags above in postgresql.conf
initdb -D /tmp/sg/pgdata -U caelo --auth=trust
pg_ctl -D /tmp/sg/pgdata -o "-p 5563 -k ''" -l /tmp/sg/pg.log start
export PGHOST=localhost PGPORT=5563 POSTGRES_USER=caelo POSTGRES_DB=postgres \
  ADMIN_ROLE_PASSWORD=a PUBLIC_ROLE_PASSWORD=p \
  ADMIN_DATABASE_URL=postgres://admin_role:a@localhost:5563/cms_admin \
  PUBLIC_ADMIN_DATABASE_URL=postgres://admin_role:a@localhost:5563/cms_public \
  PUBLIC_DATABASE_URL=postgres://public_role:p@localhost:5563/cms_public \
  CAELO_SECRET_KEK=0000000000000000000000000000000000000000000000000000000000000001
sh packages/migrations/src/bootstrap.sh && bun run db:migrate

CAELO_SCALE_GATE_THROWAWAY_DB=1 SCALE_GATE_PAGES=50000 \
  bun scripts/scale-gate/fixture.ts --out /tmp/sg/fixture.json

bun run --filter '@caelo-cms/shared' build && bun run --filter '@caelo-cms/mcp-server' build
(cd apps/admin && bun run plugins:build && ORIGIN=http://localhost:4391 bun run build)
(cd apps/admin && PORT=4391 ORIGIN=http://localhost:4391 NODE_ENV=development \
  CAELO_RELEASE_CHECK=off CAELO_UPDATE_SCHEDULER=off bun run build/index.js > /tmp/sg/admin.log 2>&1 &)

bun scripts/scale-gate/run.ts --fixture /tmp/sg/fixture.json --base-url http://localhost:4391 \
  --duration 300 --admin-log /tmp/sg/admin.log --pg-log /tmp/sg/pg.log \
  --report /tmp/sg/report.json --baseline
```

A laptop run cannot pin the admin to one vCPU, so its numbers are better than the gate's; compare runs on the same machine only. Re-seeding needs a fresh database (drop `cms_admin` and `cms_public`, bootstrap, migrate).
