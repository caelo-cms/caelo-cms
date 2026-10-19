// SPDX-License-Identifier: MPL-2.0

/**
 * #769 — `cms-provision owner-reset` — get an Owner back into a locked-out admin
 * when the install cannot email a reset link (no email transport set up).
 *
 * The root of trust is the operator's cloud identity: whoever may read the
 * install's internal secret and pass the admin's IAP already controls its
 * database and deploys, so issuing them a reset link grants nothing new. The
 * admin issues the one-hour, single-use token (`auth.issue_owner_reset`,
 * audited) and hands it back over the admin-internal.ts channel; the CLI
 * prints the link once. It is never logged, so it does not land in the
 * project's Cloud Logging the way a "log the link" fallback would.
 *
 * The request carries the operator's gcloud account so the admin's audit row
 * names who asked. That account is self-asserted (the admin sees the shared
 * `caelo-mcp` identity and the shared internal secret), and labelled so; the
 * authoritative record is Google's Data Access audit log for the IAM
 * Credentials and Secret Manager calls this command makes as the operator.
 */

import {
  type AdminInternalDeps,
  type AdminInternalResult,
  type AdminInternalTarget,
  callAdminInternal,
} from "./admin-internal.js";
import { activeAccount, gcloud as defaultGcloud } from "./gcloud.js";

/** Token scope the admin endpoint checks (apps/admin …/api/internal/owner-reset). */
export const OWNER_RESET_SCOPE = "auth.owner_reset";
const ENDPOINT = "/api/internal/owner-reset";

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
  deps: AdminInternalDeps = {},
): Promise<AdminInternalResult<OwnerReset>> {
  const account = await readGcloudAccount(deps.run ?? defaultGcloud);
  if (!account.ok) return account;
  const r = await callAdminInternal<{ email: string; token: string; expiresAt: string }>(
    target,
    {
      endpoint: ENDPOINT,
      scope: OWNER_RESET_SCOPE,
      body: {
        ...(request.email !== undefined ? { email: request.email } : {}),
        requestedBy: account.value,
      },
      introducedBy: "#769",
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

/**
 * The gcloud account this command runs as, for the admin's audit row. Without
 * one there is nobody to name, and the IAP step after this would fail anyway.
 */
export async function readGcloudAccount(
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
