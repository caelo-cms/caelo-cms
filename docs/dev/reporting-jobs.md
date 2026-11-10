# Reporting jobs

Issues #1359 and #1360 (#1140 category A). The admin only does work inside a request (CLAUDE.md §11.B Tier 5). Periodic work runs on the [scheduler tick](./scheduler-tick.md). Long, bounded work that one request cannot hold runs in a **reporting job**: a container job of its own that the admin starts once per piece of work and that reports back to the admin by request. Each report is a request, so it brings the CPU the admin needs to answer and record it. Nothing waits on an idle admin instance.

The quality audit after a Stage runs this way (#1359). The site-import crawl follows (#1360).

## The pieces

| Piece | Where |
|---|---|
| Wire format, timings, token | `packages/admin-core/src/reporting-jobs/protocol.ts` |
| Leases and uploads (migration 0680) | `reporting_jobs`, `reporting_job_uploads`; ops in `packages/admin-core/src/ops/reporting_jobs.ts` |
| What the admin does with a report | `reporting-jobs/dispatch.ts` (`handleJobReport`), per kind a `ReportingJobKindDef` (`reporting-jobs/kind.ts`, listed in `kinds.ts`) |
| Report endpoint | `POST /api/internal/jobs/<kind>/report` (`apps/admin/src/routes/api/internal/jobs/[kind]/report/+server.ts`, auth in `apps/admin/src/lib/server/reporting-jobs.ts`) |
| Starting an attempt | `reporting-jobs/launcher.ts` (`startReportingJob`) |
| Restarting a dead attempt | `reporting-jobs/backstop.ts`, core task `core:reporting-jobs` (every tick) |
| The job's side | `reporting-jobs/job-entry.ts` (container entry point), `job-reporter.ts`, `http-transport.ts`, `run-job.ts`; per kind a main in `job-mains.ts` |
| Self-hosted and development | `reporting-jobs/in-process.ts` (registered by `hooks.server.ts`) |
| Google Cloud setup | `packages/provisioning/src/reporting-job-setup.ts`, run by the wizard and every converge |

## One attempt

1. **Start.** The admin mints a token (32 random bytes) and records the attempt with the token's SHA-256 and a first lease (`reporting_jobs.begin_attempt`). It then launches the attempt. On Google Cloud that is one execution of the kind's Cloud Run job. The order (kind, work id, attempt, token, the admin's URL, the admin's version) travels as an env override. The quality audit starts in the Stage request, right after the build is recorded (`deploy.trigger`), and after `quality_audits.retry`.
2. **Reports.** The job sends one JSON POST per step, for example `start`, `source` or `result` for the audit. Every admitted report extends the lease. A heartbeat renews it while the job works (`run-job.ts`, the one interval a job keeps). An input over 1 MiB of JSON travels first in parts (`upload-part`, at most 64 parts of 2 MiB characters each). The action then names the upload. Answers stream, so a large read such as a big site's page index is not limited by a response size.
3. **End.** The action that ends the work (`result`, or `start` answering "nothing to do") finishes the row. From then on every report of the work gets `409`, and the job stops.

On another version than the admin that started it (an upgrade moved the admin first), the job sends `defer`: the lease ends at once, and the next tick starts the next attempt on the job's image as it is then.

## The backstop

A job that dies stops reporting. Its lease runs out: 15 minutes for the first report, 5 minutes after every later one (`JOB_TIMING`). The core task `core:reporting-jobs` runs on every tick and does two things per kind:

- It starts the next attempt of every job whose lease ran out, with a new token. The old attempt's reports then get `409 stale`. After the kind's last attempt (3 for the audit) it gives the work up: the audit is recorded as `errored` with code `job-failed`, and the message names where the last attempt ran.
- It starts a job for work that has none: an audit whose start was lost, or one a release before #1359 left running (`quality_audits.sweep_unstarted`).

A launch that fails (Cloud Run refused it) releases the lease at once, so the next tick tries again. An install that cannot run the job at all (aws and azure until #749 / #750, a Google Cloud admin without the job's env) records the work as failed with the reason. It never runs the work inside the admin instead.

## Who may report, and what a report can do

Two checks, both required:

1. **IAP identity.** On Google Cloud the job signs a JWT as its own service account for exactly the admin's origin (`aud = <origin>/*`, IAM `signJwt`, the path the scheduler and caelo-mcp take) and passes the admin's IAP. The endpoint takes a report of a kind only when IAP's signed assertion names that kind's account (`CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT` for the audit). An admin without that variable takes no report over HTTP: its jobs run inside it.
2. **The attempt's token** (`x-caelo-job-token`), compared as SHA-256 with the current attempt's. A per-minute cap (600) refuses a runaway job with `429`.

A report runs only its kind's actions, as the system actor, on its own work. The audit can read the check sources of the main line, ask an active plugin's audit operation, and record its own result through `quality_audits.record_result`. Nothing in a report builds or publishes anything (CLAUDE.md §2, one path to live). What follows an audit, such as the chat's card or the gate of Publish live, reads the recorded result as before.

### Threat model

- **A compromised job** can do what its reports allow for its own run: read what its kind reads, and report a wrong result for it. For the audit that is a wrong quality verdict on one Stage: a gate that opens when it should not, or findings that prompt the fix loop. Publish live stays a human's click either way. It cannot reach another run (the token), another kind (the identity), or anything else of the admin: IAP lets the account in, but every other route still needs a session, the internal token or the scheduler's identity, and the job has none of them. It holds no database credential and no secret.
- **Reports are untrusted data.** A job is the admin's own code, but it reads what it reports from pages it fetched: the staged build for the audit, third-party sites for the crawl (#1360). So every report is validated at the boundary (the envelope, the token, the action's Zod schema, the size caps), stored through the same ops as before, and rendered as text.
- **Why these jobs pass IAP when the capture job must not.** The capture job (#1217) renders untrusted pages in a full browser, which is the classic exploit surface, so it has no IAP access at all: a browser exploit there reaches nothing but the internet it already renders. A reporting job runs no browser and executes nothing it fetches; it parses fetched bytes as data. The audit runner hands every browser run to the Lighthouse tasks, and the crawl hands every render to the capture job. Those tasks keep their identities without IAP access. The rule: **IAP access goes only to job identities that run no browser and execute nothing they fetch.**
- **The token in the execution's env.** A principal that may read the execution (`run.executions.get`) can read the token. It cannot use it without passing IAP as the job's account, which takes `serviceAccountTokenCreator` on that account (the account itself and project owners). A token is good for one attempt of one run, and a newer attempt replaces it.

## The quality audit as a reporting job (#1359)

The job `caelo-<env>-audit-run` runs the admin image's `reporting-jobs/job-entry.ts` as `caelo-<env>-audit-run@`. It holds:

- `roles/iam.serviceAccountTokenCreator` on itself, so it can sign its IAP credential;
- `roles/iap.httpsResourceAccessor` on the admin. The operator-access sync keeps it there through `CAELO_OPERATOR_ACCESS_IAP_SERVICE_ACCOUNTS`;
- `roles/logging.logWriter`;
- `roles/storage.objectViewer` on the staging bucket, to serve the staged slot to its findings checks, and on the audit-results bucket, to read the Lighthouse results;
- `roles/run.jobsExecutorWithOverrides` and `roles/run.viewer` on the Lighthouse job `caelo-<env>-audit` (#875), whose tasks it starts.

No secret, no Cloud SQL, no VPC. `REPORTING_JOB_FORBIDDEN_ROLES` names the line, and `reporting-job-setup.test.ts` asserts every grant. The admin's run SA may run the job with overrides and read its executions. The upgrader has actAs on the account, because every app-roll moves the job's image with the admin's.

The audit itself is the same code as before (`quality/audit-run.ts`), now fed by reports (`quality/audit-job.ts`; admin side `quality/audit-job-kind.ts`):

| Report | The admin answers with |
|---|---|
| `start` | `quality_audits.claim`: the run to audit (its pages, the staged slot), or "stop" when a newer Stage superseded it |
| `source` | one read of a findings check: modules, layouts, the page index, redirects, the site's URLs, link issues |
| `plugin-findings` | one call of an active plugin's `auditFindingsOperation` (the batching runs in the job, `collectPluginFindings`) |
| `result` | `quality_audits.record_result` |

## Self-hosted and development

There is no extra machine. The admin registers the in-process launcher at boot (`setInProcessJobLauncher`, `hooks.server.ts`). Each attempt then runs the same job main inside the admin process, without the request waiting for it, and one attempt of a kind at a time (`in-line.ts`): two audits at once would share the CPU their Lighthouse runs measure. An attempt in line keeps renewing its lease. Its reports reach `handleJobReport` directly as text, so they pass the same caps, token check and schemas. The self-hosted admin keeps its CPU between requests. A process that dies mid-attempt leaves a lease that runs out, and the tick restarts the attempt. In a test or a script nothing registers the launcher: work is left for whoever drives it (`__tests__/fixtures/drain-audits.ts`).

## Adding a kind

1. Add its name to `REPORTING_JOB_KINDS` and its timings to `JOB_TIMING` (`protocol.ts`).
2. Declare its `ReportingJobKindDef`: its actions with their Zod inputs, `listUnstarted`, `giveUp`, its admin env vars. List it in `kinds.ts`.
3. Write its job main (it talks only through its reporter) and list it in `job-mains.ts`.
4. Provisioning: a `ReportingJobSpec` with its own service account and only the grants it needs, set up by the wizard and the converge. Add the job to `adminImageJobs`, the upgrader's actAs, the operator-access `iapServiceAccounts`, the cost table, and an infra-contract bump.
5. Tests: its grants against `REPORTING_JOB_FORBIDDEN_ROLES`, its actions through `handleJobReport`, and a killed attempt restarted by the backstop.
