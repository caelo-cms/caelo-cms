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
export const INFRA_CONTRACT_VERSION = 3;

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
