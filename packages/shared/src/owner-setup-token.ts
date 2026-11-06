// SPDX-License-Identifier: MPL-2.0

/**
 * The Owner setup token between the installer and a Google Cloud admin
 * (#1476). The CLI stores it in Secret Manager as the last step of an install
 * (and on `setup-link`); the admin reads it there when `/setup` is opened and
 * inserts it through `owner_bootstrap_tokens.insert`. Both sides meet on the
 * definitions in this file.
 */

import { z } from "zod";

/**
 * Secret Manager id of the token. Equals
 * `gcpSecretId(GCP_STACK_ENV, "owner-bootstrap-token")`; provisioning pins that
 * in a test, because the admin must not depend on the provisioning package.
 */
export const OWNER_BOOTSTRAP_TOKEN_SECRET = "caelo-production-owner-bootstrap-token";

/** A token as it is stored: the same shape as self-hosted's `pending-token.json`. */
export const OwnerBootstrapTokenSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.string().datetime(),
});

/** One Owner bootstrap token and when it stops working. */
export type OwnerBootstrapToken = z.infer<typeof OwnerBootstrapTokenSchema>;

/** Parse a stored token; null when `raw` is not one. */
export function parseOwnerBootstrapToken(raw: string): OwnerBootstrapToken | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = OwnerBootstrapTokenSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The link the Owner opens. `adminUrl` is a bare origin. */
export function ownerSetupLink(adminUrl: string, token: string): string {
  return `${adminUrl}/setup?token=${token}`;
}

/** The command that gives a late Owner a working link, from any signed-in terminal. */
export function ownerSetupLinkCommand(projectId: string): string {
  return `bunx @caelo-cms/provisioning setup-link --project ${projectId}`;
}
