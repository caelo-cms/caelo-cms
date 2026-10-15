// SPDX-License-Identifier: MPL-2.0

/**
 * The API gateway's database identity (issues #613, #635; CLAUDE.md §2):
 * which env var it connects with, which role that must resolve to, and the
 * admin credentials it refuses to run with. Kept apart from server.ts so
 * the dev launcher (dev.ts) can use it without loading the server.
 *
 * The gateway connects to cms_public ONLY, as public_role. It has no
 * cms_admin login: what it needs from authoring state, the admin publishes
 * into cms_public (`@caelo-cms/migrations/public-projection`).
 */

import { databaseUrlFromEnv } from "@caelo-cms/shared";

/**
 * Env vars that would hand the gateway an admin_role credential. The
 * gateway refuses to boot while any is set (CLAUDE.md §2: never let the API
 * Gateway hold admin_role credentials) — an install whose env still carries
 * one has not converged, and running anyway would hide that.
 */
export const ADMIN_CREDENTIAL_ENV = [
  "ADMIN_DATABASE_URL",
  "ADMIN_DATABASE_PASSWORD",
  "PUBLIC_ADMIN_DATABASE_URL",
  "PUBLIC_ADMIN_DATABASE_PASSWORD",
] as const;

/**
 * The roles the gateway's adapter must connect as: no cms_admin pool at
 * all, public_role on cms_public.
 */
export const GATEWAY_DATABASE_ROLES = {
  admin: null,
  public: ["public_role"],
} as const;

/**
 * The gateway's connection URL: `PUBLIC_DATABASE_URL` (public_role on
 * cms_public) with its `_PASSWORD` companion applied. Throws, naming what is
 * wrong, when an admin credential is present or the URL is missing.
 */
export function gatewayDatabaseUrls(env: Readonly<Record<string, string | undefined>>): {
  readonly public: string;
} {
  const leaked = ADMIN_CREDENTIAL_ENV.filter((name) => env[name]);
  if (leaked.length > 0) {
    throw new Error(
      `the API gateway must not hold admin_role credentials (CLAUDE.md §2) but ${leaked.join(", ")} ${leaked.length === 1 ? "is" : "are"} set. Remove ${leaked.length === 1 ? "it" : "them"} from the gateway's environment; it connects to cms_public only, as public_role (PUBLIC_DATABASE_URL). Cloud installs: run \`cms-provision upgrade\`. Local dev with the shared root .env: start it with \`bun run --filter @caelo-cms/api-gateway dev\`, which leaves them out.`,
    );
  }
  const pub = databaseUrlFromEnv(["PUBLIC_DATABASE_URL"], env);
  if (!pub)
    throw new Error("the API gateway needs PUBLIC_DATABASE_URL (public_role on cms_public)");
  return { public: pub };
}
