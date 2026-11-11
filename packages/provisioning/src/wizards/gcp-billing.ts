// SPDX-License-Identifier: MPL-2.0

/**
 * Which billing account a new install's Google Cloud project is linked to
 * (#1580).
 *
 * The wizard settles the account before it creates the project, so a
 * mistyped or closed `--billing-account` stops the run with nothing
 * created; the link itself follows the project create. Without the flag the
 * one open account is used, several are offered in a picker, and a
 * `--non-interactive` run with several stops and names the flag, because a
 * script has nobody to pick for it.
 */

import type { BillingAccount } from "../gcloud.js";

/** The installer flag that names the billing account. */
export const BILLING_ACCOUNT_FLAG = "--billing-account";

/** A billing account id as gcloud prints it: three groups of six hex digits. */
const BILLING_ACCOUNT_ID = /^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/;

/**
 * Parse `--billing-account`: the id `gcloud billing accounts list` prints
 * (`012345-6789AB-CDEF01`), also as the API's resource name
 * (`billingAccounts/012345-6789AB-CDEF01`), in either letter case.
 *
 * @returns the id in gcloud's spelling (upper case, no prefix)
 * @throws Error naming the flag and the expected shape
 */
export function parseBillingAccountId(raw: string): string {
  const id = raw
    .trim()
    .replace(/^billingAccounts\//, "")
    .toUpperCase();
  if (!BILLING_ACCOUNT_ID.test(id)) {
    throw new Error(
      `${BILLING_ACCOUNT_FLAG} needs a billing account id like 012345-6789AB-CDEF01, as \`gcloud billing accounts list\` prints it; got "${raw}".`,
    );
  }
  return id;
}

/** What the billing step does with the accounts gcloud listed. */
export type BillingChoice =
  /** Link this account: the one asked for, or the only open one. */
  | { readonly kind: "use"; readonly account: BillingAccount }
  /** Several open accounts and a terminal to ask in: offer these. */
  | { readonly kind: "ask"; readonly open: readonly BillingAccount[] }
  /** Stop before anything is created; the message says what to do. */
  | { readonly kind: "refuse"; readonly message: string };

/**
 * Decide the billing account from the listed accounts and the flag.
 *
 * @param input.requested the parsed `--billing-account`, if given
 * @param input.nonInteractive whether `--non-interactive` was passed
 */
export function chooseBillingAccount(input: {
  readonly accounts: readonly BillingAccount[];
  readonly requested: string | undefined;
  readonly nonInteractive: boolean;
}): BillingChoice {
  const open = input.accounts.filter((a) => a.open);
  if (open.length === 0) {
    return {
      kind: "refuse",
      message:
        "No open billing account found for the signed-in account. Open one at https://console.cloud.google.com/billing, then re-run.",
    };
  }
  const { requested } = input;
  if (requested !== undefined) {
    const named = input.accounts.find((a) => sameBillingAccount(a.id, requested));
    if (named?.open) return { kind: "use", account: named };
    const why = named
      ? "is closed"
      : "is not among the billing accounts the signed-in account can use";
    return {
      kind: "refuse",
      message: `Billing account ${requested} ${why}. Re-run with ${BILLING_ACCOUNT_FLAG} set to an open one: ${describeAccounts(open)}.`,
    };
  }
  if (open.length === 1) return { kind: "use", account: open[0] as BillingAccount };
  if (input.nonInteractive) {
    return {
      kind: "refuse",
      message: `The signed-in account has several open billing accounts, and --non-interactive leaves nobody to pick one. Re-run with ${BILLING_ACCOUNT_FLAG} <id>, one of: ${describeAccounts(open)}.`,
    };
  }
  return { kind: "ask", open };
}

/**
 * Whether two billing account ids name the same account, whatever their
 * letter case or `billingAccounts/` prefix.
 */
export function sameBillingAccount(a: string, b: string): boolean {
  const norm = (id: string) => id.replace(/^billingAccounts\//, "").toUpperCase();
  return norm(a) === norm(b);
}

function describeAccounts(accounts: readonly BillingAccount[]): string {
  return accounts.map((a) => `${a.id} (${a.displayName})`).join(", ");
}
