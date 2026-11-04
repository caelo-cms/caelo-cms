// SPDX-License-Identifier: MPL-2.0

/**
 * #1140 — set up (and converge) the scheduler tick on a Google Cloud install
 * (`gcp`, `gcp-firebase`): the ONE Cloud Scheduler job that calls the
 * admin's `/api/internal/scheduler/tick` every `schedulerIntervalMinutes`
 * (1–15, default 5). Each task's own cadence lives in the admin's
 * due-table; the tick only says "run what is due now". Run by the wizard
 * after migrations and by `cms-provision upgrade`'s converge (and the
 * converge job), as the operator's or the provisioner's identity.
 *
 * Why not Cloud Scheduler → admin directly. The admin sits behind IAP, and
 * IAP accepts a service account's OIDC ID token only when its `aud` is an
 * OAuth client allowlisted for programmatic access; an install on the
 * Google-managed IAP client has none (cloud.google.com/iap/docs/
 * authentication-howto). Cloud Scheduler's other credential, an OAuth
 * access token, it sends only to `*.googleapis.com` (cloud.google.com/
 * scheduler/docs/http-target-auth). What passes IAP for a service account
 * on every install is a self-signed service-account JWT with `aud` =
 * `<admin origin>/*` — the path caelo-mcp and admin-internal-google.ts
 * take. Cloud Scheduler cannot sign one, so the job starts a Cloud
 * Workflows execution (a googleapis.com target, OAuth), and the workflow
 * signs the JWT as the scheduler account through the IAM Credentials API
 * and POSTs the tick. No container per tick and no image to keep in step
 * with the app-roll; cents a month (wizards/gcp-cost.ts).
 *
 * Why the CLI owns it and not the stacks: the same as audit-job-setup.ts —
 * `upgrade` never runs Pulumi, and existing installs get the tick from here.
 *
 * Trust boundary. The scheduler's identity, `caelo-<env>-scheduler`, holds:
 *
 *   - `roles/iam.serviceAccountTokenCreator` on ITSELF only (signJwt);
 *   - `roles/iap.httpsResourceAccessor` on the admin's IAP resource (the
 *     operator-access sync job keeps it there, operator-access.ts);
 *   - `roles/workflows.invoker` on the project (Cloud Scheduler starts the
 *     workflow as it; Workflows has no per-workflow IAM policy to bind to);
 *   - `roles/logging.logWriter` (the workflow's error call logs).
 *
 * Nothing else: no Secret Manager, no Cloud SQL, no Cloud Run rights. What
 * it can do with the admin is the admin's to decide: the tick endpoint
 * accepts exactly this account's IAP identity (`CAELO_SCHEDULER_SERVICE_
 * ACCOUNT` on the admin) and only ever runs the due-table, never a build
 * or a publish (scripts/no-automatic-production-deploy.test.ts).
 * {@link SCHEDULER_FORBIDDEN_ROLES} names that line; the tests assert no
 * grant crosses it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  schedulerJobName,
  schedulerServiceAccountEmail,
  schedulerServiceAccountId,
  schedulerWorkflowName,
} from "./gcp-names.js";
import { type IapResource, iapResourceArgs } from "./mcp-iap.js";
import { schedulerCron } from "./stack-contract.js";

/** The admin path the workflow calls (apps/admin `api/internal/scheduler/tick`). */
export const SCHEDULER_TICK_PATH = "/api/internal/scheduler/tick";

/**
 * How long the workflow waits for the admin's answer, in seconds: Workflows'
 * maximum (cloud.google.com/workflows/docs/reference/stdlib/http/post). The
 * admin holds the request until the tick's work is done: it claims tasks for
 * at most its budget (4 minutes, admin-core scheduler/tick.ts) and then waits
 * at most one task's lease (10 minutes) for the last one, so 14 minutes in
 * the worst case, inside the admin's own 3600 s request timeout.
 */
export const SCHEDULER_TICK_TIMEOUT_SECONDS = 1800;

/** Lifetime of the IAP credential the workflow signs per tick. */
const JWT_LIFETIME_SECONDS = 600;

/** APIs the tick needs on the project. */
export const SCHEDULER_APIS = [
  "cloudscheduler.googleapis.com",
  "workflows.googleapis.com",
  "iamcredentials.googleapis.com",
] as const;

/**
 * Roles the scheduler's identity must never hold anywhere. Prefix matches
 * (`roles/secretmanager.` = every Secret Manager role).
 */
export const SCHEDULER_FORBIDDEN_ROLES = [
  "roles/owner",
  "roles/editor",
  "roles/viewer",
  "roles/run.",
  "roles/iam.serviceAccountUser",
  "roles/iam.serviceAccountAdmin",
  "roles/iam.securityAdmin",
  "roles/iap.admin",
  "roles/iap.settingsAdmin",
  "roles/secretmanager.",
  "roles/cloudsql.",
  "roles/compute.",
  "roles/storage.",
  "roles/resourcemanager.",
  "roles/workflows.admin",
  "roles/workflows.editor",
  "roles/cloudscheduler.",
] as const;

export interface SchedulerTickTarget {
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /**
   * Where the admin answers behind IAP, an origin: `https://admin.<domain>`
   * on gcp, the admin service's URL on gcp-firebase (remote-mcp.ts
   * RemoteMcpIdentity.adminUrl, the same value as the admin's
   * CAELO_ADMIN_URL).
   */
  readonly adminUrl: string;
  /** The admin's IAP resource (the service on gcp-firebase, the LB backend on gcp). */
  readonly resource: IapResource;
  /** The `schedulerIntervalMinutes` knob (1–15). */
  readonly intervalMinutes: number;
}

export type SchedulerTickResult =
  | { readonly ok: true; readonly done: string[]; readonly serviceAccount: string }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/**
 * The tick's admin origin, or an error naming why it is not one: an https
 * origin without path, query or credentials (it is written into the
 * workflow's source, so nothing but an origin may get there).
 */
export function tickOrigin(
  adminUrl: string,
): { ok: true; origin: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(adminUrl);
  } catch {
    return { ok: false, error: `the admin URL ${JSON.stringify(adminUrl)} is not a URL` };
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.pathname !== "/" && u.pathname !== "") ||
    u.search ||
    u.hash ||
    !/^[a-z0-9.-]+$/.test(u.hostname)
  ) {
    return {
      ok: false,
      error: `the admin URL ${JSON.stringify(adminUrl)} is not a plain https origin`,
    };
  }
  return { ok: true, origin: u.origin };
}

/**
 * The workflow one tick runs (Cloud Workflows YAML): sign a service-account
 * JWT for the admin's IAP as the scheduler account itself (the IAM
 * Credentials API, authenticated with the workflow's own OAuth token), then
 * POST the tick with it. A refused or failed tick (HTTP ≥ 400) fails the
 * execution, so it shows in the workflow's execution history and logs.
 *
 * The tick carries `Content-Type: application/json` and a JSON body, like the
 * self-hosted clock (admin-core scheduler/clock.ts), because the admin's
 * SvelteKit treats a POST with no content type and no `Origin` as a
 * cross-site form submission: it answers 403 before the route runs.
 */
export function schedulerWorkflowSource(opts: {
  readonly serviceAccount: string;
  readonly origin: string;
}): string {
  const { serviceAccount: sa, origin } = opts;
  return `# Caelo scheduler tick (#1140) — generated by cms-provision, do not edit.
main:
  steps:
    - claims:
        assign:
          - now: \${int(sys.now())}
          - jwtClaims:
              iss: "${sa}"
              sub: "${sa}"
              aud: "${origin}/*"
              iat: \${now}
              exp: \${now + ${JWT_LIFETIME_SECONDS}}
    - sign:
        call: http.post
        args:
          url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signJwt"
          auth:
            type: OAuth2
          body:
            payload: \${json.encode_to_string(jwtClaims)}
        result: signed
    - tick:
        call: http.post
        args:
          url: "${origin}${SCHEDULER_TICK_PATH}"
          headers:
            Authorization: \${"Bearer " + signed.body.signedJwt}
            Content-Type: application/json
          body: {}
          timeout: ${SCHEDULER_TICK_TIMEOUT_SECONDS}
        result: answer
    - done:
        return: \${answer.code}
`;
}

/** Ensure the scheduler tick and everything it needs. Never throws for a gcloud failure. */
export async function ensureSchedulerTick(
  target: SchedulerTickTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<SchedulerTickResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const retry = (args: string[]) => runWithRetry(run, sleep, args);
  const { projectId, region, env } = target;
  const project = `--project=${projectId}`;
  const sa = schedulerServiceAccountEmail(projectId, env);
  const member = `serviceAccount:${sa}`;
  const workflow = schedulerWorkflowName(env);
  const job = schedulerJobName(env);
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): SchedulerTickResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });

  const origin = tickOrigin(target.adminUrl);
  if (!origin.ok) return { ok: false, done, error: origin.error };
  let cron: string;
  try {
    cron = schedulerCron(target.intervalMinutes);
  } catch (e) {
    return { ok: false, done, error: (e as Error).message };
  }

  // 1. APIs.
  const api = await run(["services", "enable", ...SCHEDULER_APIS, project, "--quiet"]);
  if (!api.ok) return fail(`enable ${SCHEDULER_APIS.join(", ")}`, api);
  done.push(`APIs enabled (${SCHEDULER_APIS.join(", ")})`);

  // 2. The scheduler's own service account.
  const describe = await run([
    "iam",
    "service-accounts",
    "describe",
    sa,
    project,
    "--format=value(email)",
  ]);
  if (!describe.ok) {
    const create = await run([
      "iam",
      "service-accounts",
      "create",
      schedulerServiceAccountId(env),
      "--display-name=Caelo scheduler tick",
      "--description=Calls the admin's scheduler tick through IAP every few minutes; signs its own IAP credential, nothing else.",
      project,
    ]);
    if (!create.ok && !/already exists/i.test(create.stderr)) return fail(`create ${sa}`, create);
  }
  done.push(`service account ${sa}`);

  // 3. Its grants (see the file comment).
  const self = await retry([
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    sa,
    `--member=${member}`,
    "--role=roles/iam.serviceAccountTokenCreator",
    "--condition=None",
    project,
    "--quiet",
    "--format=none",
  ]);
  if (!self.ok) return fail("let the scheduler sign its IAP credential as itself", self);
  done.push(`scheduler: roles/iam.serviceAccountTokenCreator on ${sa} (itself, signJwt)`);

  for (const g of [
    { role: "roles/workflows.invoker", why: "Cloud Scheduler starts the tick workflow as it" },
    { role: "roles/logging.logWriter", why: "the workflow logs failed calls" },
  ]) {
    const r = await retry([
      "projects",
      "add-iam-policy-binding",
      projectId,
      `--member=${member}`,
      `--role=${g.role}`,
      "--condition=None",
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the scheduler ${g.role} (${g.why})`, r);
    done.push(`scheduler: ${g.role} on the project`);
  }

  const iap = await retry([
    "iap",
    "web",
    "add-iam-policy-binding",
    ...iapResourceArgs(target.resource),
    `--member=${member}`,
    "--role=roles/iap.httpsResourceAccessor",
    "--condition=None",
    project,
    "--quiet",
  ]);
  if (!iap.ok) return fail("let the scheduler pass the admin's IAP", iap);
  done.push(`scheduler: roles/iap.httpsResourceAccessor on the admin (${target.resource.service})`);

  // 4. The workflow. A private directory (mkdtemp, mode 700): no other local
  //    user can swap the file between write and read.
  const dir = mkdtempSync(join(tmpdir(), "caelo-scheduler-"));
  try {
    const file = join(dir, "tick.yaml");
    writeFileSync(file, schedulerWorkflowSource({ serviceAccount: sa, origin: origin.origin }), {
      mode: 0o600,
    });
    const deploy = await retry([
      "workflows",
      "deploy",
      workflow,
      `--source=${file}`,
      `--location=${region}`,
      `--service-account=${sa}`,
      "--call-log-level=log-errors-only",
      `--description=Caelo scheduler tick (#1140): calls ${origin.origin}${SCHEDULER_TICK_PATH}`,
      project,
      "--quiet",
    ]);
    if (!deploy.ok) return fail(`deploy workflow ${workflow}`, deploy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  done.push(`workflow ${workflow} (calls ${origin.origin}${SCHEDULER_TICK_PATH})`);

  // 5. The one Cloud Scheduler job.
  const scheduleArgs = [
    job,
    `--location=${region}`,
    project,
    `--schedule=${cron}`,
    "--time-zone=Etc/UTC",
    `--uri=https://workflowexecutions.googleapis.com/v1/projects/${projectId}/locations/${region}/workflows/${workflow}/executions`,
    "--http-method=POST",
    `--oauth-service-account-email=${sa}`,
    // A tick that has not answered when the next one is due is the admin's
    // lease to sort out (its due-table), not a reason to retry this one.
    "--max-retry-attempts=0",
    "--quiet",
  ];
  const existing = await run([
    "scheduler",
    "jobs",
    "describe",
    job,
    `--location=${region}`,
    project,
    "--format=value(name)",
  ]);
  const sched = await retry([
    "scheduler",
    "jobs",
    existing.ok ? "update" : "create",
    "http",
    ...scheduleArgs,
  ]);
  if (!sched.ok) return fail(`schedule ${job}`, sched);
  done.push(`Cloud Scheduler job ${job} (${cron}, UTC)`);

  return { ok: true, done, serviceAccount: sa };
}
