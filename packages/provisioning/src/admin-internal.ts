// SPDX-License-Identifier: MPL-2.0

/**
 * The CLI's channel to the admin's `/api/internal/*` endpoints, for commands
 * that need an answer BACK from the admin (a generated password, a reset
 * link). A one-shot job could only report through the platform's logs, which
 * would put that secret into them; this call answers straight to the CLI
 * process, and nothing is written anywhere (CLAUDE.md §7, #659).
 *
 * Each provider reaches the admin its own way (CLAUDE.md §11.B), as the
 * operator's own identity on that provider:
 *
 * - `gcp-firebase` / `gcp` (admin-internal-google.ts): through the admin's
 *   Google IAP with a JWT signed as `caelo-mcp@<project>`, plus a token
 *   signed with the internal secret from Secret Manager. gcp-firebase
 *   addresses the admin's Cloud Run URL (IAP on the service); gcp addresses
 *   `admin.<domain>` (IAP on the load balancer backend; the Cloud Run URL
 *   takes no traffic from outside the load balancer).
 * - `self-hosted` (admin-internal-self-hosted.ts): from the install's host
 *   into the admin container (`docker compose exec`), plus a token signed
 *   with `.caelo/internal-secret.json`.
 *
 * aws and azure have no such channel yet (#952).
 */

import { callGoogleAdmin } from "./admin-internal-google.js";
import { callSelfHostedAdmin } from "./admin-internal-self-hosted.js";
import type { GcloudResult } from "./gcloud.js";
import type { HostRunner } from "./self-hosted-release.js";

/** Which admin to call, and what the provider needs to reach it. */
export type AdminInternalTarget = GoogleAdminTarget | SelfHostedAdminTarget;

/** A Google Cloud install (IAP in front of the admin). */
export type GoogleAdminTarget =
  | {
      readonly provider: "gcp-firebase";
      readonly projectId: string;
      readonly region: string;
    }
  | {
      readonly provider: "gcp";
      readonly projectId: string;
      /** The install's domain; the admin answers on `admin.<domain>`. */
      readonly domain: string;
    };

/** A self-hosted install on this host. */
export interface SelfHostedAdminTarget {
  readonly provider: "self-hosted";
  /** The install's `.caelo/` directory (Compose file, internal secret). */
  readonly caeloDir: string;
  /** The admin's public origin, for the links the operator opens. */
  readonly adminUrl: string;
}

export interface AdminInternalDeps {
  /** gcloud (Google providers). */
  readonly run?: (args: string[]) => Promise<GcloudResult>;
  readonly fetch?: typeof fetch;
  /** Seconds since epoch (IAP JWT); tests pin it. */
  readonly now?: () => number;
  /** `docker compose` on the install's host (self-hosted). */
  readonly host?: HostRunner;
}

/** One endpoint call: where, under which token scope, with what body. */
export interface AdminInternalCall {
  /** Path under the admin origin, e.g. `/api/internal/owner-reset`. */
  readonly endpoint: string;
  /** Scope the endpoint's `requireInternalAuth` checks. */
  readonly scope: string;
  readonly body: Record<string, unknown>;
  /** The issue that added the endpoint, named when an older admin answers 404. */
  readonly introducedBy: string;
}

export type AdminInternalResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** What a transport hands back: the admin's answer and the URL it serves on. */
export type AdminInternalAnswer<T> = AdminInternalResult<{ answer: T; adminUrl: string }>;

/**
 * POST `call.body` to the endpoint and return the admin's JSON answer and
 * the admin URL the operator opens (to build links). Every failure names
 * the fix: a gate refusal or a pre-endpoint admin points at the command that
 * repairs it, a refusal carries the admin's own message.
 */
export function callAdminInternal<T>(
  target: AdminInternalTarget,
  call: AdminInternalCall,
  deps: AdminInternalDeps = {},
): Promise<AdminInternalAnswer<T>> {
  return target.provider === "self-hosted"
    ? callSelfHostedAdmin<T>(target, call, deps)
    : callGoogleAdmin<T>(target, call, deps);
}
