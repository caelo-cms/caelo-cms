// SPDX-License-Identifier: MPL-2.0

/**
 * #769 / #770 — `cms-provision owner-reset` — get an Owner back into a
 * locked-out admin when the install cannot email a reset link (no email
 * transport set up).
 *
 * The root of trust is the operator's control of the install: on Google
 * Cloud, whoever may read the install's internal secret and pass the
 * admin's IAP already controls its database and deploys; on self-hosted,
 * whoever may run `docker compose` for it already controls the host. Issuing
 * them a reset link grants nothing new. The admin issues the one-hour,
 * single-use token (`auth.issue_owner_reset`, audited) and hands it back over
 * the admin-internal.ts channel; the CLI prints the link once. It is never
 * logged, so it does not land in the project's Cloud Logging or the host's
 * container logs the way a "log the link" fallback would.
 *
 * The request names who asked, for the admin's audit row: the operator's
 * gcloud account on Google Cloud, `<user>@<host>` of the CLI process on
 * self-hosted. Either is self-asserted (the admin sees a shared identity and
 * the shared internal secret) and labelled so; the authoritative record is
 * Google's Data Access audit log for the IAM Credentials and Secret Manager
 * calls, or the host's own login records.
 */

import { hostname, userInfo } from "node:os";
import {
  type AdminInternalDeps,
  type AdminInternalResult,
  type AdminInternalTarget,
  callAdminInternal,
} from "./admin-internal.js";
import { activeAccount, gcloud as defaultGcloud } from "./gcloud.js";
import type { InstallMetadata } from "./install-state.js";

/** Token scope the admin endpoint checks (apps/admin …/api/internal/owner-reset). */
export const OWNER_RESET_SCOPE = "auth.owner_reset";
const ENDPOINT = "/api/internal/owner-reset";

/** Where another Owner or the email setup gets a locked-out Owner back in meanwhile. */
const OTHER_WAYS_IN =
  "Until then, another Owner can set a new password under Settings -> Users, or set up email under Settings -> Email so /forgot can send the link.";

/**
 * The admin of a cloud install recorded in install.json, or why this
 * command cannot reach it. aws and azure have no channel to the admin's
 * internal endpoints yet (#952); a self-hosted install is found by its
 * `.caelo/` directory, not by install.json.
 */
export function ownerResetTarget(
  meta: Pick<InstallMetadata, "installId" | "provider" | "projectId" | "region" | "domain">,
): AdminInternalResult<AdminInternalTarget> {
  const unrecorded = (what: string) => ({
    ok: false as const,
    error: `install ${meta.installId} has no ${what} recorded in install.json; re-run the wizard to record it.`,
  });
  switch (meta.provider) {
    case "gcp-firebase":
      if (!meta.projectId || !meta.region) return unrecorded("project or region");
      return {
        ok: true,
        value: { provider: "gcp-firebase", projectId: meta.projectId, region: meta.region },
      };
    case "gcp":
      if (!meta.projectId || !meta.domain) return unrecorded("project or domain");
      return {
        ok: true,
        value: { provider: "gcp", projectId: meta.projectId, domain: meta.domain },
      };
    case "self-hosted":
      return {
        ok: false,
        error:
          "this install is self-hosted: run `cms-provision owner-reset` without --install in the directory that holds its .caelo/ (or with CAELO_SELF_HOSTED_DIR set to that .caelo/).",
      };
    case "aws":
    case "azure":
      return {
        ok: false,
        error: `owner-reset cannot reach the admin of ${meta.provider} installs yet (issue #952). ${OTHER_WAYS_IN}`,
      };
  }
}

/** What the admin issued: whose account, the link to open, and until when it works. */
export interface OwnerReset {
  readonly email: string;
  readonly resetUrl: string;
  readonly expiresAt: string;
}

/**
 * Ask the admin for a reset link for the install's Owner (or the Owner named
 * by `email` when there are several).
 */
export async function requestOwnerReset(
  target: AdminInternalTarget,
  request: { readonly email?: string },
  deps: OwnerResetDeps = {},
): Promise<AdminInternalResult<OwnerReset>> {
  const requester = await readRequester(target, deps);
  if (!requester.ok) return requester;
  const r = await callAdminInternal<{ email: string; token: string; expiresAt: string }>(
    target,
    {
      endpoint: ENDPOINT,
      scope: OWNER_RESET_SCOPE,
      body: {
        ...(request.email !== undefined ? { email: request.email } : {}),
        ...requester.value,
      },
      introducedBy: target.provider === "self-hosted" ? "#770" : "#769",
    },
    deps,
  );
  if (!r.ok) return r;
  const { answer, adminUrl } = r.value;
  const { email, token, expiresAt } = answer;
  if (!email || !token || !expiresAt) {
    return { ok: false, error: "the admin answered without an email, token or expiry" };
  }
  const resetUrl = new URL(`/reset?token=${encodeURIComponent(token)}`, adminUrl).toString();
  return { ok: true, value: { email, resetUrl, expiresAt } };
}

/** {@link requestOwnerReset}'s seams; `localUser` names the host user on self-hosted. */
export interface OwnerResetDeps extends AdminInternalDeps {
  readonly localUser?: () => { readonly user: string; readonly host: string };
}

/**
 * Who asks, as the admin's body field for it: `requestedBy` (a gcloud
 * account) on Google Cloud — the field #769's admins accept — and
 * `requestedByHostUser` on self-hosted, where only admins from #770 on hold
 * the internal secret at all.
 */
async function readRequester(
  target: AdminInternalTarget,
  deps: OwnerResetDeps,
): Promise<AdminInternalResult<{ requestedBy: string } | { requestedByHostUser: string }>> {
  if (target.provider !== "self-hosted") {
    const account = await readGcloudAccount(deps.run ?? defaultGcloud);
    return account.ok ? { ok: true, value: { requestedBy: account.value } } : account;
  }
  const { user, host } = (deps.localUser ?? defaultLocalUser)();
  // The admin accepts exactly this shape (…/api/internal/owner-reset).
  if (!HOST_USER.test(user) || !HOST_NAME.test(host)) {
    return {
      ok: false,
      error: `name this host's user for the admin's audit row: ${JSON.stringify(`${user}@${host}`)} is not <user>@<host> in letters, digits, '.', '_' and '-'. Run the command as a user (and on a host) named that way.`,
    };
  }
  return { ok: true, value: { requestedByHostUser: `${user}@${host}` } };
}

/** The pieces of `requestedByHostUser`, as the admin validates them. */
const HOST_USER = /^[A-Za-z0-9._-]{1,64}$/;
const HOST_NAME = /^[A-Za-z0-9.-]{1,253}$/;

function defaultLocalUser(): { user: string; host: string } {
  return { user: userInfo().username, host: hostname() };
}

/**
 * The gcloud account this command runs as, for the admin's audit row. Without
 * one there is nobody to name, and the IAP step after this would fail anyway.
 */
async function readGcloudAccount(
  run: NonNullable<AdminInternalDeps["run"]>,
): Promise<AdminInternalResult<string>> {
  // `auth list --filter=status:ACTIVE`, not `config get-value account`: the
  // latter prints the sentinel `(unset)` and exits 0 when no account is set.
  const account = await activeAccount(run);
  if (!account || /\s/.test(account)) {
    return {
      ok: false,
      error:
        "read the active gcloud account: none is signed in. Run `gcloud auth login` with the account you provisioned with.",
    };
  }
  return { ok: true, value: account };
}

/** The lines the command prints. Pure — the CLI prints them and stores nothing. */
export function describeOwnerReset(r: OwnerReset): string[] {
  return [
    `Reset link for ${r.email} — open it to set a new password:`,
    "",
    `  ${r.resetUrl}`,
    "",
    `It works once and expires at ${r.expiresAt}. Setting the password signs out every`,
    "other session of this account. The link is not saved anywhere; run the command",
    "again for a new one.",
  ];
}
