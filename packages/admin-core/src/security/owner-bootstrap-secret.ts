// SPDX-License-Identifier: MPL-2.0

/**
 * #1476 — the cloud half of the `/setup` token gate. The installer keeps the
 * Owner's token in the provider's secret manager; this reads it and inserts
 * it through `owner_bootstrap_tokens.insert`, the same op self-hosted's
 * `pending-token.json` goes through.
 *
 * It runs when `/setup` is opened or submitted and an Owner does not exist,
 * not when the process boots, for three reasons:
 *
 *   - `/setup` cannot pass without it. An insert at boot would leave a window
 *     (a request before the insert finds no token ever issued and is let
 *     through); `users.create_first_owner` treats that as a contributor's
 *     checkout. Run here, a failure refuses the very request that needed it.
 *   - The migrations are done by then: `/setup` asked the database whether an
 *     Owner exists before it gets here.
 *   - An install with an Owner never comes here, so it cannot start failing.
 *     No admin env, secret mount or IAM binding changes for it, and a new link
 *     from `setup-link` works without a new revision.
 *
 * The insert is idempotent (`ON CONFLICT DO NOTHING`), so a repeat costs one
 * Secret Manager read while the install waits for its Owner, and none after.
 *
 * Fails closed: on a cloud provider nothing but a stored, unexpired token lets
 * `/setup` through. A contributor's checkout and a self-hosted install have no
 * `CAELO_PROVIDER` of that kind and never get here.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import {
  OWNER_BOOTSTRAP_TOKEN_SECRET,
  type OwnerBootstrapToken,
  ownerSetupLinkCommand,
  parseOwnerBootstrapToken,
} from "@caelo-cms/shared";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import { GOOGLE_IAP_PROVIDERS } from "./identity-gate.js";
import {
  defaultGoogleDeps,
  GoogleCallError,
  type GoogleDeps,
  googleCall,
} from "./operator-access/google-iam.js";

/** Providers whose admin finds its token somewhere other than a secret manager. */
const NO_CLOUD_TOKEN: ReadonlySet<string> = new Set(["", "self-hosted"]);

/** May `/setup` go on, and if not, why (with the next step, for the operator). */
export type OwnerBootstrapGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const refused = (message: string): OwnerBootstrapGate => ({ ok: false, message });

type SecretRead =
  | { readonly ok: true; readonly token: OwnerBootstrapToken; readonly projectId: string }
  | { readonly ok: false; readonly message: string };

/** `400` is a disabled or destroyed version, `403` also a secret that does not exist yet. */
const MISSING_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);

async function readGoogleSecret(deps: GoogleDeps): Promise<SecretRead> {
  let projectId: string;
  try {
    projectId = await deps.metadata("project/project-id");
  } catch (e) {
    return {
      ok: false,
      message: `Owner setup cannot start: the admin could not ask the metadata server for its project (${String(e)}). Reload this page; if it stays, check the admin's logs.`,
    };
  }
  const missing = `Owner setup cannot start: the admin cannot read its setup token (secret ${OWNER_BOOTSTRAP_TOKEN_SECRET} in ${projectId}). If the install is still running, wait for it to finish. Otherwise run \`${ownerSetupLinkCommand(projectId)}\`, wait a minute and open the link it prints.`;
  let payload: unknown;
  try {
    payload = await googleCall(
      deps,
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${OWNER_BOOTSTRAP_TOKEN_SECRET}/versions/latest:access`,
      "GET",
    );
  } catch (e) {
    if (e instanceof GoogleCallError && e.status !== undefined && MISSING_STATUSES.has(e.status)) {
      return { ok: false, message: missing };
    }
    return {
      ok: false,
      message: `Owner setup cannot start: reading the setup token from Secret Manager failed (${String(e)}). Reload this page in a minute.`,
    };
  }
  const data = (payload as { payload?: { data?: unknown } }).payload?.data;
  const token =
    typeof data === "string"
      ? parseOwnerBootstrapToken(Buffer.from(data, "base64").toString("utf8"))
      : null;
  return token ? { ok: true, token, projectId } : { ok: false, message: missing };
}

/** What {@link ensureOwnerBootstrapToken} works with. */
export interface OwnerBootstrapDeps {
  /** `CAELO_PROVIDER`. */
  readonly provider: string | undefined;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly requestId: string;
  readonly google?: GoogleDeps;
  readonly now?: () => number;
}

/**
 * Make sure the install's Owner token is in `owner_bootstrap_tokens` before
 * `/setup` answers. Call it only once the install is known to have no Owner.
 *
 * @returns `ok` when `/setup` may go on (`users.create_first_owner` then
 *   redeems the token); otherwise the refusal to show, naming the next step
 */
export async function ensureOwnerBootstrapToken(
  deps: OwnerBootstrapDeps,
): Promise<OwnerBootstrapGate> {
  const provider = deps.provider?.trim() ?? "";
  if (NO_CLOUD_TOKEN.has(provider)) return { ok: true };
  if (!GOOGLE_IAP_PROVIDERS.has(provider)) {
    // Refused, not waved through: aws and azure have no path from their
    // secret manager to the admin yet (#1483), and with no token issued
    // `users.create_first_owner` would let anyone who reaches /setup in.
    return refused(
      `Owner setup is not available on ${provider} installs yet: the setup token has no way to reach the admin there (issue #1483).`,
    );
  }
  const read = await readGoogleSecret(deps.google ?? defaultGoogleDeps());
  if (!read.ok) return refused(read.message);
  const inserted = await execute(
    deps.registry,
    deps.adapter,
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: deps.requestId },
    "owner_bootstrap_tokens.insert",
    read.token,
  );
  if (!inserted.ok) {
    return refused(
      `Owner setup cannot start: saving the setup token failed (${inserted.error.kind}). Reload this page; if it stays, check the admin's logs.`,
    );
  }
  if (Date.parse(read.token.expiresAt) <= (deps.now ?? Date.now)()) {
    return refused(
      `This Owner setup link expired on ${read.token.expiresAt}. Run \`${ownerSetupLinkCommand(read.projectId)}\` and open the new link it prints.`,
    );
  }
  return { ok: true };
}
