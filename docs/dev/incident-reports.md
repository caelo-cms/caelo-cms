# Incident reports: an admin stall files one bug report

Issue #1595. When the admin stalls on its database, Caelo files **one** automatic bug report per incident (`ai_bug_reports`, `source: 'auto'`). The report carries what is needed to find the cause: which transactions failed, what held the pool, and the database's own session list, which shows who waits on whom.

Before this, a stall left only log lines. The searchVIU stall of 2026-11-11 (#1594) took reading three sources afterwards: Cloud Logging, Cloud Monitoring and the Postgres log. Even then the logs could not say whether it was a lock queue, an idle transaction or a CPU-starved database.

## Signals

| Signal | Where it comes from | Reportable |
|---|---|---|
| statement past `statement_timeout`, lock wait past `lock_timeout`, session ended for idling in a transaction, no free pooled connection within the acquire deadline | `DatabaseAdapter.onDatabaseTrouble` (query-api `database-trouble.ts`): every transaction of the adapter that fails on one of them, with its holder (op name or `withAdminTransaction` label) | at once |
| MCP call refused with 429 | the back-pressure gate (`mcp-back-pressure.ts`) | once refusals have lasted 30 s (`SUSTAINED_REFUSAL_MS`); a short burst is load the gate exists to absorb |
| Stage, build or Publish live failed on something other than a refusal | `logRunTimings` (`ops/deploy-common.ts`) | only as evidence of an incident that is already open; it raises the report to `blocking` |

The thresholds and timeouts come from cms_admin migration 0392 and `pool-guard.ts`.

## One incident, one report

An incident spans signals until two minutes (`INCIDENT_QUIET_MS`) pass without one; the next signal opens a new incident. The capture (`admin-core/src/incident/capture.ts`) works like this:

- **First write:** when the incident becomes reportable, the capture files the report.
- **Rewrites:** it rewrites the report as the incident grows, through `ai_bug_reports.update_incident`. That op is system-only and changes only an automatic report nobody closed.
- **One write at a time:** a signal during a write marks the report dirty, and the write repeats once it finished.
- **Failed writes:** a failed write (the pool is still full) waits for the next signal. There is no timer (CLAUDE.md §11.B Tier 5).
- **No self-feeding:** failures of the capture's own operations are no signals, so a report write that waits out the pool deadline does not feed the incident it reports.
- **Stable fingerprint:** `whatHappened` stays the same for the same first sign, so the bug intake's fingerprint (#901) merges the same stall across incidents and installs. The numbers live in `evidence`.

## What the report contains

`evidence`, at most 8000 characters, in the order a reader needs it:

1. **Header:** the instance (Cloud Run revision), the version, the time range and the first sign.
2. **Signal counts.**
3. **Failing transactions:** each holder, what it met, how often, and its longest run.
4. **The admin pool at its fullest:** in use, waiting, and the holders longest first.
5. **Failed builds:** their message and slowest phases.
6. **Database snapshots** (`diagnostics.database_activity`, system-only). One is taken when the report is filed; a second is taken once the pool got fuller than at the first. Each shows:
   - session counts by state;
   - the blocked sessions and the pids they wait for;
   - where the lock queue starts;
   - the longest open sessions;
   - a **diagnosis** in plain sentences (`diagnose` in `incident/evidence.ts`):
     - **Lock queue:** sessions blocked by another session; the blocker is named.
     - **Idle transactions:** sessions idle inside an open transaction. Their holder waits on something outside the database while it keeps its locks.
     - **CPU-bound:** statements that run without waiting on anything. On a shared-core tier this is its CPU ceiling.
     - **IO-bound:** statements that wait on disk.

The snapshot reads `pg_stat_activity` under a 5-second statement timeout of its own, so it cannot become part of the stall. admin_role sees the statement text of its own sessions on every admin instance; other roles' sessions show their state only.

## Privacy

- **Statement text:** it is stripped of every literal (`sanitizeStatement`) and cut to one line.
- **Parameters:** they never appear, because Bun sends every value as a bound parameter.
- **Content:** no content value or visitor data is read.
- **Forwarding:** the bug forwarder redacts the text once more before anything leaves the install, and forwards only after the Owner opted in (#901).

## Not covered

- **Client-side timeouts:** a client that gives up before the server answers never reaches the server as a failure. The server's long operation still shows as pool holding.
- **Database CPU from the provider's monitoring:** it is not read. The CPU-bound diagnosis comes from the session list instead.
