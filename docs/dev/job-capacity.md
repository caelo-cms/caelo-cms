# Job capacity

Issue #1776, follow-up to #1764. Every execution Caelo starts on a job runner books its CPU in one ledger first and gives it back at its end. What does not fit waits, by class and then first come first served. The search index uses whatever CPU is free and grows when a quality check ends. Plugins say only what their jobs need, in the manifest. Caelo decides when they run and how wide.

## Why

Cloud Run has one CPU quota per project and region, shared by the services and every job task. A new project has 20 vCPU; projects created before 2026 have thousands. Cloud Run does not arbitrate between our jobs and the services: a job that fills the quota can leave the admin without room for another instance, and Google documents only that "the actual number of concurrent tasks might be lower than the configured parallelism maximum". The admin starts every execution itself, so it can book them all. Before this, #1766 split the quota statically: the search index stayed on one task for its whole build even after the quality check had ended, and the build carrier, the crawl, the captures and plugin batches were not counted at all.

## The pieces

| Piece | Where |
|---|---|
| Admission rules (pure) | `packages/admin-core/src/job-capacity/plan.ts` (`planAdmission`, `lighthouseGrant`) |
| Budget and the quotas an Owner asks for | `job-capacity/budget.ts` |
| Booking, admission, helpers, the sweep | `job-capacity/ledger.ts`, ops in `ops/job_capacity.ts` |
| Pieces of elastic work | `ops/job_pieces.ts` |
| Tables (migration 0920) | `job_capacity_bookings`, `job_capacity_budget`, `job_pieces` |
| What a kind books | `ReportingJobKindDef.capacity` (`reporting-jobs/kind.ts`) |
| The Owner's view | Settings → Deployments → Job capacity (`apps/admin/src/lib/components/CloudCapacityCard.svelte`) |

## The budget

| Install | Budget |
|---|---|
| Google Cloud | the project's Cloud Run CPU quota in the region, minus `SERVICE_RESERVE_VCPU` (6: the admin's up to 4 instances of 1 vCPU and one instance each of the live and the staging gateway). The services scale on their own and book nothing. |
| Self-hosted | no limit. The jobs run inside the admin's process, whose lines run one job of each kind at a time (`reporting-jobs/in-line.ts`); a CPU budget on top would count a job waiting in its line as running and hold back the other kinds for nothing. The ledger still records what runs, for the Owner's card, and elastic work runs on its lead alone. |
| AWS, Azure | none yet: their jobs do not exist (#749, #750). |

A start of a job that may wait reads the budget again (on Google Cloud through Service Usage, `roles/serviceusage.serviceUsageViewer`, #1764) and records it in `job_capacity_budget`. A raised quota counts from that start on. The claims of running work use the recorded value, so a claim never calls Google.

## Classes and rules

| Class | Jobs | Rule |
|---|---|---|
| immediate | build carrier, quality check (runner and Lighthouse batches), site import crawl, capture | always starts; someone waits for it |
| stage | search index | starts when its first task fits; Publish live waits for it |
| background | plugin batches | starts after the stage class, leaving `HEADROOM_VCPU` (2) for immediate jobs |

1. A job that waits holds back every job behind it (class first, then booking time), so a large job is never overtaken for good by a stream of small ones.
2. A quality check keeps its Lighthouse share free from its start to its end (`auditReserveVcpu`: 5 runs of 2 vCPU on 14 vCPU, all 15 from 34). Each Lighthouse batch books its width out of it (`job_capacity.reserve_lighthouse`, the runner's `lighthouse-reserve` report) and gives it back when the batch ends. A batch always gets at least one run.
3. Elastic work (a search index, a plugin batch in pieces) runs its lead task and gets helpers while CPU is free, up to what it wants (its unfinished pieces, capped by its `maxTasks`). Helpers leave the headroom. When the budget is over, or a waiting job of a higher class needs room, helpers stop after their current piece: lowest class and newest work first.
4. Widening happens only above the headroom and cutting only below zero, so a short capture does not stop and restart helpers.
5. A background job that cannot give CPU back (a batch without pieces) starts only if a quality check still fits after it: its runner and one Lighthouse run (`CHECK_MINIMUM_VCPU`, 3). Room for a check at full width would keep a large job from ever starting on a small quota; the check then runs its batch in more rounds.
6. Nothing waits for good: a job that needs more than the whole budget (a tiny quota) starts once nothing else holds any of it. On a budget of 3 vCPU a batch without pieces would otherwise need 6.

On a new project's 20 vCPU (14 for the jobs) a Stage runs the check (1 + 10 vCPU) and one index task (2); once the check ends, the index widens to 6 tasks (12, plus the headroom). The next Stage's check makes the helpers stop after their piece.

## Elastic work and pieces

A helper is another execution of the same Cloud Run job, for the attempt that runs (`job_capacity.admit` adds it only while the work's attempt is launched and its lease alive). Its order carries `helper` (its booking) and a token of its own, which `reporting_jobs.authorize` admits for that attempt while its booking holds it. Its reports and heartbeats keep its booking's lease, a `defer` gives back only its own task, and it never reports a result.

Every task claims pieces from the admin (`job_pieces.claim`): the next open piece, `wait` while others hold the rest, `none` when all are done, and for a helper `stop` when its work holds more tasks than the ledger grants it. A claim runs out after its lease, and the piece is open again, so a task that dies costs its piece and nothing more. A new attempt's lead registers the pieces again (`resetClaims`), which opens the claims of the attempt before.

- **Search index:** a piece is a vector shard (`docs/plugin-collections.md`). The lead registers the build's shards and which exist already, claims too, and builds the release once every shard is done.
- **Plugin batch in pieces:** a piece is a key the batch's plan named (`docs/plugin-batches.md`).

## Admission

Admission runs inside requests, never on a timer of its own (CLAUDE.md §11.B Tier 5): after a report that ends a work (`done`), after one that changes what a work wants or holds (`readmit`: pieces registered, a helper stopped or left), and on the scheduler tick (the reporting-job backstop, which first sweeps). One transaction-scoped advisory lock serialises every decision across admin instances. A lead that may start goes through `startReportingJob`; a helper that does not launch gives its booking back and the next admission tries again.

A work's bookings and pieces end with it (`reporting_jobs.finish`, also for work given up while it waited); a new attempt drops the helpers and batches of the attempt before. The sweep gives back helpers, batches and captures whose lease passed, and leads whose work no longer runs (15 minutes after their start). A stopped plugin batch that still waited leaves the queue at once (`job_capacity.cancel`).

## What people and the AI see

- Settings → Deployments → Job capacity: the budget, what it gives each kind, the jobs that run and wait now with their reason, and, when the quota is small, the steps to raise it.
- `get_stage_status` and the Publish live gate: a search index whose job waits for CPU names why; one the quota keeps narrow names the quota that would give it its tasks.
- `list_plugin_batches`: a queued run whose job waits for CPU says so and that it starts by itself.
- `job_capacity.list` is human and system only: the AI reads the waits where it can act on them (above).

## Adding a kind

A new reporting-job kind declares `capacity` in its definition: its class, the vCPU of one task (the same as its catalog entry; `scripts/reporting-job-catalog-parity.test.ts` checks it), whether it is elastic and how wide it may run. Any other execution Caelo starts books through the ledger too (`bookCapture` shows the pattern); none may bypass it.
