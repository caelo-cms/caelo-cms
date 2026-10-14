// SPDX-License-Identifier: MPL-2.0

/**
 * Reload the self-hosted Caddy after a deploy so the build's redirect
 * snippet (`_redirects.caddy`, #587) takes effect.
 *
 * Caddy reads imported files only when it loads a config. The admin posts
 * the Caddyfile Caddy runs to the admin API's `/load` endpoint
 * (`Content-Type: text/caddyfile`); Caddy adapts it on its own filesystem —
 * resolving the `import` of the freshly synced build — and swaps the config
 * gracefully. An identical config is a no-op. A config Caddy rejects keeps
 * the previous one running and fails the deploy with Caddy's message.
 *
 * The API listens on a unix socket in a volume only Caddy and the admin
 * mount (compose.ts in @caelo-cms/provisioning), never on the network.
 */

import { readFile } from "node:fs/promises";
import { CADDY_ADMIN_SOCKET_ENV, CADDYFILE_ENV, trimTrailingSlashes } from "@caelo-cms/shared";

/** Where the admin API is reached: a unix socket, or a URL (tests). */
export type CaddyAdminEndpoint =
  | { readonly kind: "socket"; readonly path: string }
  | { readonly kind: "url"; readonly baseUrl: string };

/** What a reload needs: the endpoint and the Caddyfile to post. */
export interface CaddyReloadTarget {
  readonly endpoint: CaddyAdminEndpoint;
  readonly caddyfilePath: string;
}

/**
 * The reload target from the admin's env, or null in local development:
 * there no admin API is shared, and docker-compose.yml runs Caddy with
 * `--watch`, which re-reads the import itself. A self-hosted install
 * (`CAELO_PROVIDER=self-hosted`, set by the generated Compose file) without
 * the env is a broken install — fail instead of serving stale redirects.
 */
export function caddyReloadTargetFromEnv(env: NodeJS.ProcessEnv): CaddyReloadTarget | null {
  const socket = env[CADDY_ADMIN_SOCKET_ENV];
  const caddyfilePath = env[CADDYFILE_ENV];
  if (socket && caddyfilePath) {
    return { endpoint: { kind: "socket", path: socket }, caddyfilePath };
  }
  if (env.CAELO_PROVIDER === "self-hosted") {
    throw new Error(
      `caddy-reload: ${CADDY_ADMIN_SOCKET_ENV} / ${CADDYFILE_ENV} are not set on this self-hosted install, so Caddy cannot be reloaded and new redirects would not be served. Re-run \`cms-provision up\` to regenerate the Compose file, then deploy again.`,
    );
  }
  return null;
}

/**
 * POST the Caddyfile to Caddy's `/load`.
 *
 * @throws with Caddy's response when it rejects the config.
 */
export async function reloadCaddy(target: CaddyReloadTarget): Promise<void> {
  const caddyfile = await readFile(target.caddyfilePath, "utf8");
  const init = {
    method: "POST",
    headers: { "Content-Type": "text/caddyfile" },
    body: caddyfile,
  };
  let res: Response;
  try {
    res =
      target.endpoint.kind === "socket"
        ? // Bun's fetch speaks HTTP over a unix socket via `unix`; the host
          // part of the URL is then only the Host header.
          await fetch("http://localhost/load", { ...init, unix: target.endpoint.path })
        : await fetch(`${trimTrailingSlashes(target.endpoint.baseUrl)}/load`, init);
  } catch (e) {
    throw new Error(
      `caddy-reload: Caddy's admin API is unreachable (${(e as Error).message}). The site files are published but new redirects are not served until Caddy reloads. Check that the caelo-caddy container runs, then deploy again.`,
    );
  }
  if (!res.ok) {
    const detail = (await res.text()).trim();
    throw new Error(
      `caddy-reload: Caddy rejected the reload (HTTP ${res.status}): ${detail}. Caddy keeps serving its previous config; the site files are published but the new redirects are not served. Fix the cause above, then deploy again.`,
    );
  }
}

/** Reload Caddy when this runtime has a Caddy to reload (see {@link caddyReloadTargetFromEnv}). */
export async function reloadCaddyIfConfigured(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = caddyReloadTargetFromEnv(env);
  if (target) await reloadCaddy(target);
}
