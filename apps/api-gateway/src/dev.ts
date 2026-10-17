// SPDX-License-Identifier: MPL-2.0

/**
 * Local dev launcher for the API gateway (`bun run --filter
 * @caelo-cms/api-gateway dev`).
 *
 * The documented dev setup is one root `.env` (from `.env.example`) shared
 * by the admin and the gateway, and the admin needs its admin_role URLs in
 * it. The gateway refuses to boot while any cms_admin credential is in its
 * environment (database-env.ts `gatewayDatabaseUrls`), so this launcher
 * starts it with the root `.env` minus those vars, and with Bun's own `.env`
 * loading off so nothing adds them back. The strict refusal itself stays
 * untouched: production images, Compose and the cloud adapters start
 * `server.ts` directly with the gateway's own env.
 */

import { resolve } from "node:path";
import { TRUSTED_PROXY_HOPS_ENV } from "./client-ip.js";
import { adminDatabaseAccessInEnv } from "./database-env.js";

/**
 * `env` without anything the gateway's guard refuses (every cms_admin
 * credential, by name or by value) and without unset entries, for the
 * gateway's process.
 */
export function gatewayDevEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const drop = new Set(adminDatabaseAccessInEnv(env).map((l) => l.slice(0, l.indexOf(":"))));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !drop.has(name)) out[name] = value;
  }
  return out;
}

if (import.meta.main) {
  // The package script loads the root .env into THIS process
  // (`bun --env-file=../../.env src/dev.ts`); the server gets the filtered copy.
  // Nothing sits in front of the dev gateway, so the client address is the
  // TCP peer (client-ip.ts, hop count 0).
  const env = { ...gatewayDevEnv(process.env), [TRUSTED_PROXY_HOPS_ENV]: "0" };
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--hot", resolve(import.meta.dir, "server.ts")],
    { env, stdio: ["inherit", "inherit", "inherit"] },
  );
  process.exit(await child.exited);
}
