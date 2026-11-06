// SPDX-License-Identifier: MPL-2.0

/**
 * The Owner setup token of a GCP install (#1476): mint it, keep it in Secret
 * Manager for the admin, and store the link that carries it.
 *
 * The token is minted here and not in the Pulumi program, which runs on every
 * `pulumi up` and would hand out a new one each time; and at the end of the
 * install, so its 24 hours start when the link is shown, not hours earlier
 * while the install waits for DNS. This also keeps it out of Pulumi's state.
 *
 * The secret and the admin's read access on it are made here, through
 * gcloud, rather than declared in the stacks. Only an install still waiting
 * for its Owner needs them, so an install that has one gets no new resource,
 * no new binding and no infrastructure-contract step: its admin never reads
 * this secret (packages/admin-core/src/security/owner-bootstrap-secret.ts).
 *
 * The admin reads the newest version whenever `/setup` opens, so a new token
 * works without a new revision.
 */

import {
  OWNER_BOOTSTRAP_TOKEN_SECRET,
  type OwnerBootstrapToken,
  ownerSetupLink,
  parseOwnerBootstrapToken,
} from "@caelo-cms/shared";
import { generateBootstrapToken } from "./bootstrap-token.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { GCP_STACK_ENV, runServiceAccountEmail } from "./gcp-names.js";
import { storeInstallSecretValue, storeSetupLink } from "./install-job.js";

/** A token with less time left than this is replaced: nobody should get a link about to die. */
const MIN_REMAINING_MS = 60 * 60 * 1000;

/**
 * The token stored in `projectId`, or null when there is none or it is not
 * one (a new one replaces it).
 *
 * @throws when it can't be read for any other reason, with what the account needs
 */
export async function readOwnerBootstrapToken(
  run: GcloudRunner,
  projectId: string,
): Promise<OwnerBootstrapToken | null> {
  const r = await run([
    "secrets",
    "versions",
    "access",
    "latest",
    `--secret=${OWNER_BOOTSTRAP_TOKEN_SECRET}`,
    `--project=${projectId}`,
  ]);
  if (r.ok) return parseOwnerBootstrapToken(r.stdout.trim());
  if (/NOT_FOUND|not found|DISABLED|DESTROYED|FAILED_PRECONDITION/i.test(r.stderr)) return null;
  throw new Error(
    `Could not read the Owner setup token (secret ${OWNER_BOOTSTRAP_TOKEN_SECRET} in ${projectId}): ${r.stderr.trim()}. Your gcloud account needs secretmanager.versions.access on the project (e.g. roles/secretmanager.secretAccessor or project Owner).`,
  );
}

/** A working link, and whether its token is new. */
export interface OwnerSetupIssued {
  readonly link: string;
  readonly expiresAt: string;
  readonly minted: boolean;
}

/**
 * Make sure the install has a working Owner setup link: keep a stored token
 * with time left (a link already handed out stays good), otherwise mint one
 * and store it; let the admin's service account read it; store the link.
 * Safe to repeat. Runs as the installer or as the operator's gcloud account.
 *
 * @param adminUrl the admin's bare origin, as the Owner opens it
 * @param now the current time in ms, for tests
 */
export async function issueOwnerSetup(
  run: GcloudRunner,
  target: { readonly projectId: string; readonly region: string },
  adminUrl: string,
  now: number = Date.now(),
): Promise<({ ok: true } & OwnerSetupIssued) | { ok: false; error: string }> {
  let stored: OwnerBootstrapToken | null;
  try {
    stored = await readOwnerBootstrapToken(run, target.projectId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const kept =
    stored !== null && Date.parse(stored.expiresAt) - now > MIN_REMAINING_MS ? stored : null;
  const current = kept ?? generateBootstrapToken();
  if (!kept) {
    const written = await storeInstallSecretValue(
      run,
      target,
      OWNER_BOOTSTRAP_TOKEN_SECRET,
      JSON.stringify(current),
    );
    if (!written.ok) return written;
  }
  // Also for a kept token: an interrupted run may have stored it and stopped
  // before this grant.
  const granted = await run([
    "secrets",
    "add-iam-policy-binding",
    OWNER_BOOTSTRAP_TOKEN_SECRET,
    `--project=${target.projectId}`,
    `--member=serviceAccount:${runServiceAccountEmail(target.projectId, GCP_STACK_ENV)}`,
    "--role=roles/secretmanager.secretAccessor",
    "--condition=None",
    "--quiet",
    "--format=none",
  ]);
  if (!granted.ok) {
    return {
      ok: false,
      error: `let the admin read ${OWNER_BOOTSTRAP_TOKEN_SECRET}: ${granted.stderr.trim()}`,
    };
  }
  const link = ownerSetupLink(adminUrl, current.token);
  const linked = await storeSetupLink(run, target, link);
  if (!linked.ok) return linked;
  // Two secrets, no transaction: a run at the same time may have written its
  // own token in between, and then this link is not the one the admin accepts.
  let latest: OwnerBootstrapToken | null;
  try {
    latest = await readOwnerBootstrapToken(run, target.projectId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (latest?.token !== current.token) {
    return {
      ok: false,
      error: `another run changed the Owner setup token at the same time (secret ${OWNER_BOOTSTRAP_TOKEN_SECRET}). Run this command again.`,
    };
  }
  return { ok: true, link, expiresAt: current.expiresAt, minted: kept === null };
}
