// SPDX-License-Identifier: MPL-2.0

/**
 * The infrastructure contract version (epic #696).
 *
 * An upgrade has two halves (packages/provisioning/src/upgrade/): the
 * *converge* half changes IAM, service accounts, secrets and other cloud
 * resources the stacks declare; the *app-roll* half only runs migrations and
 * moves the two Cloud Run services onto new images. The app-roll half can run
 * under an identity without IAM-write or secret-create rights (the in-cloud
 * upgrader job), but only while the install's infrastructure already is what
 * the release expects.
 *
 * This number names that expectation. A release that needs a converge step
 * the installs out there have not had yet (a new secret, a new IAM binding, a
 * new service account) bumps it; `cms-provision upgrade` records the version
 * it converged to in install.json, and the upgrader job refuses an app-roll
 * while the recorded version is lower (`needsConverge` in upgrade/converge.ts),
 * sending the operator to the converge path instead.
 *
 * Bump it in the same PR that adds the converge step, never later: a release
 * whose app-roll references infrastructure an install does not have yet fails
 * at roll time, after migrations ran.
 */
export const INFRA_CONTRACT_VERSION = 22;

// History (why each bump happened — an install below a number needs the
// converge that introduced it):
//   1 — epic #696 split: converge vs app-roll.
//   2 — the upgrader job (#696 Phase 2): its service account + scoped
//       grants, the Cloud SQL backup role, its IAM database user, the job,
//       the admin's run-only grant and CAELO_UPGRADER_JOB on the admin.
//   3 — public_role out of cloudsqlsuperuser (#633): the Admin API revoke
//       runs as the operator; migration 0278's role audit refuses an install
//       that has not had it, so the in-cloud upgrader must not get there
//       first.
//   4 — #587: on `gcp`, the admin's custom role for writing the redirects
//       table into the URL map (url-map-redirects-access.ts).
//   5 — #635: the gateway has no cms_admin login. Its GATEWAY_DATABASE_URL /
//       GATEWAY_DATABASE_PASSWORD go, and its SA loses access to the
//       gateway-role-password secret (a retired IAM binding, removed after
//       the roll — the in-cloud upgrader cannot change IAM).
//   6 — #799: the upgrader's custom role `caeloUpgraderOpsList`
//       (`storage.objects.list` on the ops bucket). Every `gcloud storage cp`
//       into the bucket lists it first; without the binding the in-cloud
//       upgrader fails at its state lock, so it must not run before the
//       converge grants it.
//   7 — #845: the gateway refuses to boot without CAELO_TRUSTED_PROXY_HOPS
//       (which X-Forwarded-For entry is the visitor). A plain env var, but
//       the in-cloud upgrader rolls with the env contract of the release it
//       runs from (the installed one), which does not set it — so the new
//       gateway would not start. The operator-identity upgrade runs the new
//       release's contract and sets it.
//   8 — #875: the quality-audit job, its service account, the audit results
//       bucket and their grants, plus CAELO_AUDIT_JOB /
//       CAELO_AUDIT_RESULTS_BUCKET on the admin. The new admin fans every
//       Stage audit out to that job, and the app-roll moves the job's image,
//       so it must exist before an in-cloud upgrader rolls onto it.
//   9 — #819: the converge job (`caelo-<env>-converge`, converge-job-setup.ts)
//       that installs contract-bumping releases from Settings → Updates as
//       the install's caelo-provisioner, its Cloud SQL IAM database login
//       (platform_updater), the admin's start-only grant on it and
//       CAELO_CONVERGE_JOB on the admin. Installed by the last converge an
//       Owner runs by hand; every later one runs from Caelo. The same bump
//       replaces the upgrader's project-wide roles/run.developer (which
//       holds run.jobs.runWithOverrides on the provisioner's jobs) with the
//       custom role caeloUpgraderRun (#883 review). An install without a
//       caelo-provisioner reaches 9 without the job: there is nothing it
//       could run as, so its admin keeps routing cloud-setup releases to
//       the terminal (upgrade/converge.ts, update-route.ts).
//  10 — #806: remote MCP. Two CLI-generated secrets (the Google OAuth client
//       placeholder, the broker's seal key) the gateway's new revision
//       references — a secret volume and a secret env var Cloud Run refuses
//       to deploy without — plus the gateway SA's accessor and the admin
//       SA's version-adder bindings on them, the operator-access role's
//       IAP-settings permissions, and on `gcp` the URL-map routes and the
//       Cloud Armor rule. The in-cloud upgrader can create none of these.
//  11 — #914: the remote-MCP OAuth client becomes the install's Google
//       sign-in client (IAP browser login + programmatic access + broker).
//       Its secret is renamed (`operator-oauth-client`, CLI-generated; the
//       old `mcp-oauth-client` is deleted after the roll), so the gateway's
//       secret volume and env var, the admin's store env var and both
//       services' bindings on it move; the operator-access job's SA gets
//       `secretAccessor` on it (IAP needs the client secret) and the job a
//       new env var; the admin gets CAELO_ADMIN_URL and the project's
//       organisation domain. A new secret, new IAM and a job redeploy —
//       nothing the in-cloud upgrader may do.
//  12 — #914 follow-up (#597 PR): Google applies a custom OAuth client
//       for Cloud Run IAP, and programmatic clients, only at project level
//       or above — the admin's own IAP resource refused them with HTTP 400.
//       The operator-access job now sets them in the project's IAP settings,
//       so its SA gets the new custom role `caeloOperatorAccessIapProject`
//       (`iap.projects.getSettings` / `updateSettings`) on the project. New
//       IAM the in-cloud upgrader cannot grant; without it the new job image
//       fails every Google sign-in sync with 403.
//  13 — #891: the public site's security headers at the edge. On `gcp` the
//       static backend bucket gets the `X-Content-Type-Options: nosniff`
//       custom response header, the live SVG objects get
//       `Content-Disposition: attachment` and Cloud CDN is purged once
//       (static-svg-gcp.ts); aws / azure gain response-header policies /
//       a Front Door rule set (static-security-headers.ts). Backend-bucket,
//       object-metadata and CDN writes the in-cloud upgrader holds no rights
//       for, so the converge applies them.
//  14 — #1217: the capture job (`caelo-<env>-capture`, capture-job-setup.ts)
//       every server-side browser render runs in, its service account, the
//       capture bucket and their grants (job: create under out/ only; admin:
//       object user on the bucket, run-with-overrides on the job, and
//       tokenCreator on its own account to sign the job's URLs), the
//       upgrader's actAs on the job's account, plus CAELO_CAPTURE_JOB /
//       CAELO_CAPTURE_BUCKET / CAELO_MEDIA_BUCKET on the admin. The new admin
//       runs no browser itself on GCP and the app-roll moves the job's image,
//       so it must exist before an in-cloud upgrader rolls onto it.
//  15 — #1338: verify-full TLS to Cloud SQL. The instance moves to the
//       shared server CA (a patch plus a server-certificate rotation) and
//       refuses plaintext, a private Cloud DNS zone resolves its DNS name in
//       the VPC, and the services dial that name (cloudsql-tls.ts). The new
//       images refuse any database URL weaker than verify-full, and the
//       in-cloud upgrader may neither patch the instance nor create a DNS
//       zone, so it must not roll an install onto them first.
//  16 — #1328: the MCP-Auth-Proxy, remote MCP's broker as a service of its
//       own (no database, its own image). Its service account with
//       secretAccessor on exactly the Google sign-in client and the seal
//       key, and the upgrader's actAs on it. On `gcp-firebase` the visitor
//       gateway moves to a new Cloud Run service (`caelo-<env>-data-gateway`,
//       public invoker, the admin's run.viewer for the Firebase rewrite) and
//       the old `gateway` service, whose run.app URL every connector holds
//       (E13 a), becomes the proxy: new image, new account, no VPC, no
//       database env. On `gcp` the proxy is a new service behind its own
//       serverless NEG, backend service and Cloud Armor policy (the MCP rule
//       moves there) and the URL map sends the MCP paths to it. New
//       services, accounts, IAM and load-balancer resources — none of which
//       the in-cloud upgrader may create, and the app-roll rolls three
//       services from now on.
//  17 — #1329: staging's own database. The Cloud SQL database
//       `cms_public_staging`, the Admin API user `public_staging_role` (its
//       password the new CLI-generated secret `public-staging-role-password`)
//       and its membership revoke; the admin's PUBLIC_STAGING_ADMIN_DATABASE_URL
//       and the gateway's CAELO_GATEWAY_ENVIRONMENT. The in-cloud upgrader
//       may create no database, user or secret, and the new admin and
//       gateway refuse to start without them. Additive only (converge
//       release 1 of the gateway hardening): nothing is served from the
//       staging database yet, so rolling back stays harmless.
//  18 — #1140: the scheduler tick (scheduler-setup.ts). Its service account
//       (token creator on itself, workflows.invoker, logWriter, IAP access to
//       the admin), the Cloud Workflows workflow that signs its IAP JWT and
//       calls the admin's /api/internal/scheduler/tick, the one Cloud
//       Scheduler job that starts it every schedulerIntervalMinutes, the
//       operator-access job's CAELO_OPERATOR_ACCESS_IAP_SERVICE_ACCOUNTS (so
//       its sync keeps the account on IAP) and CAELO_SCHEDULER_SERVICE_ACCOUNT
//       on the admin. The new admin runs its periodic work and plugin workers
//       only on that tick, so an in-cloud upgrader must not roll an install
//       onto it before the tick exists.
//  19 — the scheduler workflow's tick is a JSON POST. Without a content type
//       SvelteKit refused every tick of contract 18 with 403, so no periodic
//       work ran. The workflow source is only deployed by a converge.
//  20 — #1330/#1331: the staging gateway (converge release 2 of the gateway
//       hardening). Its service account (secretAccessor on
//       public-staging-role-password only, log/metric writer), its Cloud Run
//       service `caelo-<env>-staging-gateway` (the gateway's image,
//       CAELO_GATEWAY_ENVIRONMENT=staging, allUsers invoker: the gate is its
//       own), object viewer on the staging bucket — on gcp-firebase a new
//       private bucket, which the admin may write (CAELO_STAGING_BUCKET) —
//       and its edge: on gcp-firebase a second Hosting site with one `**`
//       rewrite and the staging host as its custom domain, the old Cloud Run
//       domain mapping deleted; on gcp a serverless NEG, backend service,
//       managed certificate and URL-map host rule. The live gateway loses
//       CAELO_STAGING_GATE_SECRET (the gate key reaches the staging gateway
//       through the staging projection) and the MCP-Auth-Proxy its interim
//       forwarder. New service, account, bucket, IAM and edge resources the
//       in-cloud upgrader may not create, and the app-roll rolls four
//       services from now on.
//  21 — #1463 and the plain-gcp repairs. The app-roll now brings the gateways
//       to the connection budget (max instances, CAELO_DB_PUBLIC_POOL_MAX),
//       but an in-cloud upgrader rolls with the code of the release it runs
//       from, so without this bump an install would keep 100 gateway
//       instances until the update after next; the converge job runs the
//       target release's code. On `gcp` the gateway also gets its allUsers
//       run.invoker (the stack never declared it, so every /api/ call
//       answered Cloud Run's 403) and the CLI-owned backends created with
//       the `https` port name get `http` and their NEG: IAM and
//       load-balancer writes the in-cloud upgrader may not make.
//  22 — #1339: on `gcp` the gateway's Cloud Armor policy gets per-path
//       rules (gateway-edge.ts): a tighter ban on the auth plugin's
//       credential operations, a captcha throttle, the general ban limited
//       to /api/ paths (it banned staging reviewers, whose pages share the
//       policy since #1330) and the OWASP packs at sensitivity 1. Policy
//       writes the in-cloud upgrader holds no compute rights for, so the
//       converge applies them (gateway-armor.ts). Other providers have
//       nothing to converge for it.
//
// #1029 is deliberately NOT a bump. The upgrader job's stage 1 moves the job
// onto the target's ops image with rights it has held on itself since
// contract 9 (`run.jobs.update`, `run.jobs.run`, `actAs` on its own account),
// so no install needs a converge for it. It also ends the first reason of
// bump 21: once an install's job carries #1029, an app-roll runs the target
// release's code, and "the upgrader rolls with old code" is no reason to bump.

/**
 * What each contract version adds, in operator terms — the upgrader's
 * refusal names the steps an install is missing. Keep one entry per version
 * (the history above says why each bump happened).
 */
export const INFRA_CONTRACT_STEPS: Readonly<Record<number, string>> = {
  1: "the converge/app-roll split",
  2: "the in-cloud upgrader job and its scoped permissions",
  3: "public_role out of the Cloud SQL superuser group (#633)",
  4: "the admin's permission to serve redirects from the load balancer (#587)",
  5: "the gateway's cms_admin login removed from its env and IAM (#635)",
  6: "the upgrader's permission to list its ops bucket (#799)",
  7: "the gateway's trusted proxy hop count, CAELO_TRUSTED_PROXY_HOPS (#845)",
  8: "the quality-audit job, its service account, results bucket and grants (#875)",
  9: "the converge job that installs cloud-setup changes from Settings → Updates, and a narrower Cloud Run role for the upgrader (#819)",
  10: "remote MCP: the OAuth client and seal-key secrets, their IAM, the gateway's secret file and timeout, IAP programmatic-client sync and the load-balancer rules (#806)",
  11: "Google sign-in: the renamed sign-in client secret, its IAM and mounts, the operator-access job's read access to it, and the admin's URL and organisation domain (#914)",
  12: "Google sign-in at project level: the operator-access job's permission to set the sign-in client in the project's IAP settings (#914)",
  13: "the public site's security headers at the edge: nosniff on every file, uploaded SVGs no longer run as documents on the site's origin, and a one-time CDN purge (#891)",
  14: "the capture job that takes server-side screenshots outside the admin, its service account, bucket and grants (#1217)",
  15: "verified TLS to the database: Cloud SQL's shared server CA, encrypted connections only, and a private DNS name the services dial (#1338)",
  16: "the MCP sign-in service as its own Cloud Run service with its own account (no database access), the visitor gateway as its own service on Firebase installs, and on Google Cloud load-balancer installs the sign-in service's backend and Cloud Armor rule (#1328)",
  17: "the staging site's own database and its gateway login, kept apart from the live data (#1329)",
  18: "the scheduler tick that runs the admin's periodic work and plugin workers every few minutes: its service account, workflow and Cloud Scheduler job, and its IAP access (#1140)",
  19: "the scheduler tick sent as a JSON request, because the admin refused every tick before (#1140)",
  20: "the staging gateway that serves the staged site behind the staging gate on every address: its service, service account and grants, the private staging bucket, and the staging host's own route (a second Firebase Hosting site, or a host rule and certificate on the load balancer); the live gateway no longer holds the staging gate key (#1330, #1331)",
  21: "the gateways' scale-out and connection pool kept inside the database connection budget, and on Google Cloud load-balancer installs the gateway open to visitors and the sign-in and staging routes repaired (#1463)",
  22: "per-path Cloud Armor rules for the visitor and staging gateways on Google Cloud load-balancer installs: a tighter ban on sign-up, login and password reset, a captcha throttle, the general ban only on the visitor API, and fewer false positives from the OWASP rules (#1339)",
};

/**
 * The steps an install at contract `installed` lacks for `target`, oldest
 * first. A release newer than this code can carry versions it does not know
 * (the upgrader reads the NEW release's manifest); those are named by number.
 *
 * @example
 *   pendingInfraSteps(2, 4)
 *   // → ["public_role out of the Cloud SQL superuser group (#633)",
 *   //    "the admin's permission to serve redirects from the load balancer (#587)"]
 */
export function pendingInfraSteps(installed: number, target: number): string[] {
  const steps: string[] = [];
  for (let v = Math.max(installed, 0) + 1; v <= target; v += 1) {
    steps.push(INFRA_CONTRACT_STEPS[v] ?? `infrastructure step ${v} (see that release's notes)`);
  }
  return steps;
}

/** {@link pendingInfraSteps} as one sentence fragment for messages. */
export function infraStepsText(installed: number, target: number): string {
  return pendingInfraSteps(installed, target).join("; ");
}
