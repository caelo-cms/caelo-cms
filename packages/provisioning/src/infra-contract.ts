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
export const INFRA_CONTRACT_VERSION = 13;

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
