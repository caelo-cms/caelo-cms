# The scheduler tick

Issue #1140. The admin does periodic work only inside a request, so the work runs on the CPU the request is billed for and never relies on an idle instance (CLAUDE.md §11.B Tier 5). Since #1361 the admin runs on request-billed CPU (`SERVICE_CPU_IDLE.admin`): between requests it gets next to no CPU. One scheduler calls the admin every few minutes. That request runs every task that is due.

## The pieces

| Piece | Where |
|---|---|
| Entry point | `POST /api/internal/scheduler/tick` (`apps/admin/src/routes/api/internal/scheduler/tick/+server.ts`) |
| Who may call it | `authorizeSchedulerTick` (`apps/admin/src/lib/server/scheduler.ts`): the scheduler's service account through IAP (Google Cloud), or the internal token of scope `scheduler.tick` |
| The tick | `runSchedulerTick` (`packages/admin-core/src/scheduler/tick.ts`) |
| Core tasks and their cadences | `coreScheduledTasks` (`packages/admin-core/src/scheduler/core-tasks.ts`) |
| Plugin workers | `pluginWorkerTasks` (`packages/admin-core/src/scheduler/plugin-workers.ts`), over the registry in `packages/plugin-host/src/scheduler.ts` |
| Plugin change consumers | `pluginChangeConsumersTask` (same file): `core:plugin-change-consumers`, every tick |
| Due-table | `scheduled_tasks` (migration 0550), ops `scheduled_tasks.claim` / `scheduled_tasks.finish` |
| Interval | install knob `schedulerIntervalMinutes`, 1–15, default 5 |

## How a tick runs

For each task, in order:

1. `scheduled_tasks.claim` leases it. The claim succeeds only when the task is due and no other tick holds it, so concurrent ticks on several admin instances run it once. A task the table has never seen is due at once.
2. The tick runs the task. It stops waiting after the task's lease. Such a run keeps its lease until the lease expires, so no other tick starts it twice.
3. `scheduled_tasks.finish` records the outcome and the next due time. An interval task is due again `everySeconds - 60` after its start. The 60 seconds of slack keep a task with the tick's own cadence from being skipped when a tick comes early. A cron task is due at its pattern's next occurrence.

The tick stops claiming once its budget (4 minutes) is spent. Tasks it did not reach stay unclaimed and run on the next tick. Every-tick tasks come first, because they are cheap.

A task that throws is recorded as `failed` on its row and runs again at its next due time. It never stops the tick, and the scheduler gets a 200. A failing due-table op (the database) fails the tick, and the scheduler's next call retries.

## Every request starts the same way (#1361)

The tick is an ordinary request: before it runs, `hooks.server.ts` calls the plugin host's request start (`pluginHostRequestStart`, `packages/plugin-host/src/request-start.ts`), as for every admin request:

- the instance follows the plugin rows (`syncPluginHost`, throttled to one read per 2 s);
- it confirms its plugin runtime rows once they are older than 30 s (`refreshRuntimeHeartbeat`), so plugin health keeps counting a server that serves;
- it starts a change-consumer retry that came due (`resumeDueChangeConsumers`: a failed batch's backoff ended, a claim another instance held lapsed), without waiting for it.

None of this has an idle timer. On request-billed CPU a timer would not fire between requests, and an instance that serves no request does nothing a stale view could spoil. While a request is in flight (a chat turn, a Stage, the tick itself), the admin's `handle` holds the heartbeat (`holdRuntimeHeartbeat`, released when the response body ends or the client goes away: an event stream, a streamed page, a media download; at once for a page SvelteKit rendered whole; a load's own `fetch` during SSR holds nothing of its own), and the heartbeat is renewed every 30 s, so a busy server keeps counting as live for the others. Plugin health counts the server that answers a health read whatever its heartbeat says. A server that idled past the 2-minute live window counts neither as running nor as failing, so idling is never read as "not running" and never blocks Publish live (#1008).

The tick's `core:plugin-change-consumers` task drains every change consumer and waits for the drain. So a quiet site also delivers a retry, a consumer whose claim another instance held, or a wake-up the LISTEN never got. A consumer in its failure backoff still waits it out; the task's summary names it. On an instance whose boot could not start the consumer loop, the task starts it.

## Adding a task

- **Core maintenance:** add an entry to `coreScheduledTasks`, with a `core:<name>` key and a cadence. The body resolves with an optional one-line summary, or throws with a message that names the cause. Do not add a `setInterval`: `scripts/no-background-timers.test.ts` fails on any new one.
- **A plugin's periodic work:** declare it in `manifest.workers[]` with a cron pattern. It runs at that cadence, rounded up to the tick. A run must finish within its 5-minute lease, so the plugin chunks larger work (the `_run_pending_units` pattern). A worker that recomputes published rows from visitor data declares `publicDatabases: "each"`: it runs once against cms_public and once against cms_public_staging, each run seeing only that database (#1333). A failed run fails the task row.
- **Long work** (minutes, a browser, a crawl) does not belong on the tick. It runs in a container job that reports back by request (#1359, #1360).

No task may build or publish production (CLAUDE.md §2). `scripts/no-automatic-production-deploy.test.ts` pins that, and pins the plugin-data task as the one caller of `runPluginDataBuildIfDue`.

## Who calls the tick

- **Google Cloud (`gcp`, `gcp-firebase`):** one Cloud Scheduler job starts one Cloud Workflows execution per tick. The workflow signs a service-account JWT as the install's scheduler account (`caelo-<env>-scheduler`) and posts through the admin's IAP. The admin accepts the request when IAP's signed assertion names `CAELO_SCHEDULER_SERVICE_ACCOUNT`. The tick must be sent as JSON: SvelteKit answers a POST with no content type and no `Origin` with a 403 before the route runs. Cloud Scheduler's own OIDC token is not used, for two reasons. IAP accepts an OIDC ID token only with an OAuth client ID as audience, and installs on the Google-managed IAP client have none they could use. And Cloud Scheduler sends OAuth access tokens only to `*.googleapis.com`. The provisioner sets everything up, on install and on every converge (`packages/provisioning/src/scheduler-setup.ts`). The operator-access sync job keeps the scheduler account on the admin's IAP policy.
- **Self-hosted:** the `caelo-scheduler` Compose service runs `packages/admin-core/src/scheduler/clock.ts` from the admin image. It posts with a fresh internal token. It does no work itself and reaches no database.
- **AWS / Azure:** nothing yet. The admin task itself does not exist (#749 / #750). The same shape will be an EventBridge Scheduler rule or a Container Apps job that calls the same endpoint.
- **Dev and test runs** (`NODE_ENV` other than `production`) have no scheduler. There the admin ticks itself every 5 minutes (`bootstrapDevSchedulerClock` in `hooks.server.ts`). `CAELO_SCHEDULER_CLOCK=off` turns that off.

## What is not on the tick yet

- The quality audit's in-process worker: #1359.
- The site-import crawl worker: #1360.
